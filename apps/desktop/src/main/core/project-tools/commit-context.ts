// AI 写提交信息要发给模型的改动（docs/ui/ai-commit-codex-warnings-history.md §2.2）：在仓库所在的机器上取（SSH 也一样），
// 按上限截好再传回本机。staged 只看暂存的；all 是全部改动，含未跟踪的文件（和「提交全部」一致）。
// 锁文件、压缩文件只列名字；可能有密钥的文件连改动行都不发（正文在这里就丢掉，不出这台机器）。
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  GitCommitContext,
  GitCommitFile,
  GitCommitScope,
  GitContextContent,
  GitContextFile,
} from '../../../shared/types/project-tools'
import { parseCommitFiles } from './git-parse'

export const CONTEXT_LIMITS = {
  /** 放进去的正文总字数 */
  total: 60_000,
  /** 单个文件最多放多少字 */
  perFile: 12_000,
  /** 未跟踪的新文件最多放前几行、读前多少字节 */
  newFileLines: 200,
  newFileBytes: 64 * 1024,
  /** 最近几条提交标题 */
  recent: 10,
  /** 最多列多少个文件 */
  files: 500,
  /** 读改动正文时 git 输出的上限 */
  patchBytes: 8 * 1024 * 1024,
}

/** 剩下的额度不到这么多就不再放正文 */
const MIN_SECTION = 400

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'go.sum',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'composer.lock',
  'gemfile.lock',
  'packages.lock.json',
  'flake.lock',
  'podfile.lock',
  'pubspec.lock',
  'mix.lock',
])
const GENERATED = /\.(min\.(js|mjs|cjs|css)|map)$/i
const SECRETS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials|htpasswd)$/i,
  /^(credentials|secrets?)(\.[a-z]+)?$/i,
]

/** 只列名字的文件：listed 锁文件 / 压缩过的文件，secret 可能有密钥 */
export function contextKind(path: string): 'listed' | 'secret' | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (SECRETS.some(re => re.test(name))) return 'secret'
  if (LOCKFILES.has(name.toLowerCase()) || GENERATED.test(name)) return 'listed'
  return null
}

/** 一段 unified diff 按文件拆开：键是 `diff --git ` 后面那一行（`a/旧路径 b/路径`） */
export function splitPatch(patch: string): Map<string, string> {
  const sections = new Map<string, string>()
  const starts = [...patch.matchAll(/^diff --git (.*)$/gm)]
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : patch.length
    sections.set(m[1], patch.slice(m.index, end))
  })
  return sections
}

/** 截到 limit 字以内，在换行处断开 */
export function cutAtLine(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const nl = cut.lastIndexOf('\n')
  return nl > limit / 2 ? cut.slice(0, nl + 1) : cut + '\n'
}

/** 未跟踪的新文件写成 unified diff 的样子，和别的文件一个格式 */
export function newFileSection(path: string, lines: string[], partial: boolean): string {
  const body = lines.map(l => '+' + l).join('\n')
  return (
    `diff --git a/${path} b/${path}\nnew file (untracked)\n--- /dev/null\n+++ b/${path}\n` +
    `@@ -0,0 +1,${lines.length} @@\n${body}\n${partial ? '…（新文件后面还有）\n' : ''}`
  )
}

/** 按顺序放正文，直到用完总额度 */
export interface ContextEntry {
  file: GitCommitFile
  /** 这个文件的正文；拿不到时为 null */
  section: string | null
  /** 已经知道放不进去的原因（二进制、读不到） */
  kind?: GitContextContent
  /** 正文本身只是开头（新文件只读了前一部分） */
  partial?: boolean
}

export function assemble(entries: ContextEntry[], limits = CONTEXT_LIMITS): { files: GitContextFile[]; patch: string } {
  let patch = ''
  const files = entries.map(({ file, section, kind, partial }): GitContextFile => {
    const listed = contextKind(file.path) ?? (file.origPath ? contextKind(file.origPath) : null)
    let content: GitContextContent
    if (listed) content = listed
    else if (kind) content = kind
    else if (section === null) content = 'omitted'
    else {
      const room = Math.min(limits.perFile, limits.total - patch.length)
      if (room < MIN_SECTION) content = 'omitted'
      else if (section.length <= room) {
        patch += section.endsWith('\n') ? section : section + '\n'
        content = partial ? 'cut' : 'diff'
      } else {
        patch += cutAtLine(section, room - 40) + '…（这个文件后面的改动省略了）\n'
        content = 'cut'
      }
    }
    return { ...file, content }
  })
  return { files, patch }
}

export type GitRunner = (
  args: string[],
  opts?: { input?: string; limit?: number },
) => Promise<{ ok: boolean; stdout: Buffer }>

const isBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0)
/** 文件开头的字节顺序标记（BOM） */
const BOM = new RegExp('^' + String.fromCharCode(0xfeff))

/** 读未跟踪文件的开头；二进制返回 null */
async function readHead(path: string, limits = CONTEXT_LIMITS): Promise<{ lines: string[]; partial: boolean } | null> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(limits.newFileBytes)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const data = buffer.subarray(0, bytesRead)
    if (isBinary(data)) return null
    const size = (await handle.stat()).size
    let lines = data.toString('utf8').replace(BOM, '').replace(/\r\n/g, '\n').split('\n')
    let partial = size > bytesRead
    // 读到一半的最后一行不要；整个文件读完时去掉末尾换行留下的空行
    if (partial) lines.pop()
    else if (lines.at(-1) === '') lines.pop()
    if (lines.length > limits.newFileLines) {
      lines = lines.slice(0, limits.newFileLines)
      partial = true
    }
    return { lines, partial }
  } finally {
    await handle.close()
  }
}

/**
 * 取这次要提交的改动；run 在仓库根目录跑 git，root 是仓库根目录的绝对路径。
 * only：只看这些路径（文件或文件夹，相对仓库根；Git 面板「AI 只给这些写」，docs/ui/git-panel.md §10.1）
 */
export async function collectCommitContext(
  root: string,
  scope: GitCommitScope,
  run: GitRunner,
  limits = CONTEXT_LIMITS,
  only?: readonly string[],
): Promise<GitCommitContext> {
  const pathspec = only?.length ? ['--', ...only] : []
  const out = async (args: string[], opts?: { input?: string; limit?: number }): Promise<string> => {
    const r = await run(args, opts)
    return r.ok ? r.stdout.toString('utf8') : ''
  }
  const head = (await out(['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).trim()
  // 还没有提交：和空树比（SHA-256 仓库的空树哈希不一样，现算）
  const base = head || (await out(['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim()
  const diff = (...format: string[]) => [
    'diff',
    ...(scope === 'staged' ? ['--cached'] : []),
    '--no-ext-diff',
    '--no-textconv',
    '-M',
    ...format,
    '--end-of-options',
    base,
    ...pathspec,
  ]
  const [names, nums, patch, branch, log, untracked] = await Promise.all([
    out(diff('--name-status', '-z')),
    out(diff('--numstat', '-z')),
    out(diff('-U3'), { limit: limits.patchBytes }),
    out(['branch', '--show-current']),
    head ? out(['log', '-n', String(limits.recent), '--no-merges', '--format=%s']) : Promise.resolve(''),
    scope === 'all' ? out(['ls-files', '--others', '--exclude-standard', '-z', ...pathspec]) : Promise.resolve(''),
  ])
  const tracked = parseCommitFiles(names, nums, limits.files)
  const sections = splitPatch(patch)
  const entries: ContextEntry[] = tracked.files.map(file => ({
    file,
    section:
      file.insertions === null && file.deletions === null
        ? null
        : (sections.get(`a/${file.origPath ?? file.path} b/${file.path}`) ?? null),
    ...(file.insertions === null && file.deletions === null ? { kind: 'binary' as const } : {}),
  }))
  let truncated = tracked.truncated
  for (const path of untracked.split('\0').filter(Boolean)) {
    if (entries.length >= limits.files) {
      truncated = true
      break
    }
    const file: GitCommitFile = { path, origPath: null, code: 'A', insertions: null, deletions: 0 }
    if (contextKind(path)) {
      entries.push({ file, section: null })
      continue
    }
    const read = await readHead(join(root, path), limits).catch(() => undefined)
    if (read === undefined) entries.push({ file, section: null, kind: 'omitted' })
    else if (read === null) entries.push({ file: { ...file, deletions: null }, section: null, kind: 'binary' })
    else
      entries.push({
        file: { ...file, insertions: read.lines.length },
        section: newFileSection(path, read.lines, read.partial),
        partial: read.partial,
      })
  }
  const assembled = assemble(entries, limits)
  return {
    scope,
    branch: branch.trim() || null,
    files: assembled.files,
    patch: assembled.patch,
    recent: log
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean),
    truncated,
  }
}
