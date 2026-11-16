// Git 面板「按模块分组」和「加入 .gitignore」（docs/ui/git-panel.md §10、§10.1）：
// 模块 = 带项目清单的文件夹；清单从 git ls-files 来（已跟踪 + 没被忽略的新文件，任意深度，node_modules 这类被忽略的自然不在）。
// 这里只放纯函数和读清单，跑 git 在 git.ts。远端辅助进程也会打包，不导入 electron。
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { GIT_MODULE_MANIFESTS as MODULE_MANIFESTS } from '../../../shared/types/project-tools'
import type { GitIgnoreEntry, GitModule } from '../../../shared/types/project-tools'

/** git ls-files 用的 pathspec（要关掉 GIT_LITERAL_PATHSPECS 才认 glob） */
export const MODULE_PATHSPECS = MODULE_MANIFESTS.map(name => `:(glob)**/${name}`)

/** 这些文件夹里的清单不算模块：依赖、测试样例、构建输出 */
const SKIP_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  'fixtures',
  '__fixtures__',
  'testdata',
  '.dart_tool',
  'build',
  'dist',
  'out',
  'target',
  'buildSrc',
])

/** 一个仓库最多认这么多模块（再多分组也没法看了） */
export const MODULE_LIMIT = 500
const MANIFEST_BYTES = 64 * 1024

export interface ModuleCandidate {
  /** 相对仓库根，posix；根是 '' */
  dir: string
  manifest: (typeof MODULE_MANIFESTS)[number]
}

/** ls-files 列出的清单路径 → 每个文件夹一个（按优先级挑清单），按路径排序，最多 MODULE_LIMIT 个 */
export function moduleCandidates(paths: readonly string[]): ModuleCandidate[] {
  const byDir = new Map<string, ModuleCandidate>()
  const rank = (name: string) => MODULE_MANIFESTS.indexOf(name as ModuleCandidate['manifest'])
  for (const path of paths) {
    const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path)
    const name = posix.basename(path)
    if (rank(name) < 0) continue
    if (dir && dir.split('/').some(s => SKIP_SEGMENTS.has(s))) continue
    const prev = byDir.get(dir)
    if (!prev || rank(name) < rank(prev.manifest))
      byDir.set(dir, { dir, manifest: name as ModuleCandidate['manifest'] })
  }
  return [...byDir.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)).slice(0, MODULE_LIMIT)
}

const tomlName = (text: string, table: string): string | null => {
  const start = text.search(new RegExp(`^\\[${table.replace('.', '\\.')}\\]\\s*$`, 'm'))
  if (start < 0) return null
  const body = text.slice(start).split(/\r?\n/).slice(1)
  for (const line of body) {
    if (/^\s*\[/.test(line)) break
    const m = /^\s*name\s*=\s*["']([^"']+)["']/.exec(line)
    if (m) return m[1]
  }
  return null
}

/** 清单内容 → 模块名和类型；读不出名字时用文件夹名（根是仓库文件夹名） */
export function moduleInfo(candidate: ModuleCandidate, text: string | null, rootName: string): GitModule {
  const folder = candidate.dir ? posix.basename(candidate.dir) : rootName
  const t = text ?? ''
  let name: string | null = null
  let kind: string
  switch (candidate.manifest) {
    case 'package.json': {
      kind = 'npm'
      try {
        const data = JSON.parse(t) as { name?: unknown }
        if (typeof data.name === 'string') name = data.name
      } catch {
        // 不是合法 JSON：用文件夹名
      }
      break
    }
    case 'pubspec.yaml':
      name = /^name:\s*([^\s#]+)/m.exec(t)?.[1] ?? null
      kind = /^\s+sdk:\s*flutter\b/m.test(t) || /^flutter:/m.test(t) ? 'Flutter' : 'Dart'
      break
    case 'Cargo.toml':
      name = tomlName(t, 'package')
      kind = 'Cargo'
      break
    case 'go.mod':
      name = /^module\s+(\S+)/m.exec(t)?.[1]?.split('/').pop() ?? null
      kind = 'Go'
      break
    case 'pom.xml':
      name = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(t.replace(/<parent>[\s\S]*?<\/parent>/, ''))?.[1] ?? null
      kind = 'Maven'
      break
    case 'pyproject.toml':
      name = tomlName(t, 'project') ?? tomlName(t, 'tool.poetry')
      kind = 'Python'
      break
    case 'settings.gradle':
    case 'settings.gradle.kts':
      name = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(t)?.[1] ?? null
      kind = 'Gradle'
      break
    default:
      kind = 'Gradle'
  }
  return { dir: candidate.dir, name: name?.trim() || folder, kind }
}

/** 读清单（不跟随符号链接、太大不读）；读不了返回 null，模块照样算，只是用文件夹名 */
async function readManifest(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MANIFEST_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** 仓库里的模块：root 是仓库根绝对路径，paths 是 ls-files 列出的清单 */
export async function readModules(root: string, paths: readonly string[]): Promise<GitModule[]> {
  const rootName = posix.basename(root.replace(/\\/g, '/').replace(/\/+$/, '')) || root
  return Promise.all(
    moduleCandidates(paths).map(async c => moduleInfo(c, await readManifest(join(root, c.dir, c.manifest)), rootName)),
  )
}

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

/** 渲染层传来的要忽略的路径：相对仓库根、posix、不能有 .. 和绝对路径；最多 200 个 */
export function ignoreEntries(input: unknown): GitIgnoreEntry[] {
  const list = (input as { entries?: unknown } | null)?.entries
  if (!Array.isArray(list) || !list.length || list.length > 200) throw new Error('参数不正确')
  return list.map(item => {
    const v = (item ?? {}) as { path?: unknown; dir?: unknown }
    if (typeof v.path !== 'string') throw new Error('参数不正确')
    const path = v.path.replace(/\\/g, '/').replace(/\/+$/, '')
    if (
      !path ||
      path.length > 1000 ||
      path.includes('\0') ||
      path.startsWith('/') ||
      /^[a-zA-Z]:/.test(path) ||
      path.split('/').some(s => s === '..' || s === '.' || s === '' || s === '.git')
    )
      throw new Error('参数不正确')
    return { path, dir: v.dir === true }
  })
}

/** 一条忽略规则：从仓库根锚定（/a/b/），通配符和反斜杠转义，结尾空格转义 */
export function ignorePattern(entry: GitIgnoreEntry): string {
  const escaped = entry.path.replace(/[\\*?[\]]/g, c => '\\' + c).replace(/ $/, '\\ ')
  return '/' + escaped + (entry.dir ? '/' : '')
}

/**
 * 原来的 .gitignore 内容（没有是 null）加上这些规则后的内容；都已经有了返回 null。
 * 沿用原文件的换行（有 CRLF 就用 CRLF），原来末尾没换行先补一个
 */
export function ignoreUpdate(content: string | null, entries: readonly GitIgnoreEntry[]): string | null {
  const text = content ?? ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const have = new Set(text.split(/\r?\n/).map(l => l.trim()))
  const add: string[] = []
  for (const entry of entries) {
    const pattern = ignorePattern(entry)
    if (!have.has(pattern) && !add.includes(pattern)) add.push(pattern)
  }
  if (!add.length) return null
  return text + (text && !text.endsWith('\n') ? eol : '') + add.join(eol) + eol
}

/** 把规则写进仓库根的 .gitignore：内容先算好再写；是符号链接或不是普通文件就不写 */
export async function appendIgnore(root: string, entries: readonly GitIgnoreEntry[]): Promise<void> {
  const file = join(root, '.gitignore')
  let content: string | null = null
  try {
    const info = await lstat(file)
    if (!info.isFile()) throw new Error('.gitignore 不是普通文件，没有改')
    content = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const next = ignoreUpdate(content, entries)
  if (next !== null) await writeFile(file, next, 'utf8')
}
