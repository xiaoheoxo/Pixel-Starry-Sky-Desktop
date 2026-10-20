import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, realpath, stat, open, rename, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, extname } from 'node:path'
import {
  FILE_STAGE_CHUNK_BYTES,
  MAX_STAGED_FILE_BYTES,
  STAGED_FILE_TTL_MS,
  codedError,
  parseCodedError,
} from '@pixelsky/protocol'
import { grepWorkspace } from './workspace-grep'
import { IGNORED_STATUS } from '../../shared/types/workspace'
import type {
  DirectoryListing,
  FileDocument,
  GrepResult,
  FileStageRequest,
  WorkspaceRef,
  WorkspaceTarget,
} from '../../shared/types/workspace'

export const TEXT_LIMIT = 2 * 1024 * 1024
export const READ_LIMIT = 10 * 1024 * 1024
const IMAGE_LIMIT = 8 * 1024 * 1024
const PAGE_LIMIT = 500
const SEARCH_LIMIT = 200
const HASH = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const IMAGES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}
export type TargetResolver = (ref: WorkspaceRef) => WorkspaceTarget

export function workspaceRef(value: unknown): WorkspaceRef {
  const v = value as Partial<WorkspaceRef> | null
  if (!v || typeof v !== 'object') throw new Error('缺少项目或会话')
  // 附加文件夹编号（docs/ui/multi-root-projects.md §3.4）：1–20 的整数，别的值一律当成没写
  const folder = Number.isInteger(v.folder) && v.folder! >= 1 && v.folder! <= 20 ? { folder: v.folder } : {}
  if (typeof v.sessionId === 'string' && v.sessionId && v.projectId === undefined)
    return { sessionId: v.sessionId, ...folder }
  if (typeof v.projectId === 'string' && v.projectId && v.sessionId === undefined)
    return { projectId: v.projectId, ...folder }
  throw new Error('项目目标不正确')
}

function inside(root: string, file: string): boolean {
  const r = relative(root, file)
  return !isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)
}

/** 相对路径和真实路径都必须位于所选项目，避免目录链接指向项目外。 */
export async function workspacePath(rootPath: string, input: unknown, kind?: 'file' | 'directory'): Promise<string> {
  if (typeof input !== 'string' || input.includes('\0') || input.includes(':') || isAbsolute(input))
    throw codedError('files.relativePath')
  let root: string
  try {
    root = await realpath(rootPath)
  } catch {
    throw new Error('项目目录不存在')
  }
  const candidate = resolve(root, input)
  if (!inside(root, candidate)) throw codedError('files.outsideProject')
  let result: string
  try {
    result = await realpath(candidate)
  } catch {
    throw input ? codedError('files.notFound') : new Error('项目目录不存在')
  }
  if (!inside(root, result)) throw new Error('此链接指向项目外，无法在软件内打开')
  const info = await stat(result)
  if (kind === 'directory' && !info.isDirectory()) throw new Error('目标不是文件夹')
  if (kind === 'file' && !info.isFile()) throw new Error('目标不是普通文件')
  return result
}

/** 文件 / 文件夹名：不能为空、. / ..，不能带 Windows 不允许的字符，也不能以空格或点结尾 */
const BAD_NAME = /[\\/:*?"<>|\0]/
export function validName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !BAD_NAME.test(name) && !/[ .]$/.test(name) && name.length <= 255
}

function relativeInput(input: unknown): string {
  if (typeof input !== 'string' || input.includes('\0') || input.includes(':') || isAbsolute(input))
    throw codedError('files.relativePath')
  return input.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * 项目内一个已存在的条目本身（不跟随最后一级的符号链接，重命名 / 删除的是链接而不是它指向的文件）。
 * 上级目录的真实路径必须在项目内；不能是项目根目录。
 */
export async function workspaceEntry(rootPath: string, input: unknown): Promise<{ root: string; path: string }> {
  const rel = relativeInput(input)
  if (!rel) throw codedError('files.projectRoot')
  const root = await realpath(rootPath).catch(() => {
    throw new Error('项目目录不存在')
  })
  const lexical = resolve(root, rel)
  if (!inside(root, lexical) || lexical === root) throw codedError('files.outsideProject')
  const parent = await realpath(dirname(lexical)).catch(() => {
    throw codedError('files.notFound')
  })
  if (parent !== root && !inside(root, parent)) throw codedError('files.outsideProject')
  const path = join(parent, basename(lexical))
  await lstat(path).catch(() => {
    throw codedError('files.notFound')
  })
  return { root, path }
}

/** 项目内一个还不存在的新路径：名称合法、上级文件夹存在且在项目内、没有同名条目 */
export async function workspaceNewPath(
  rootPath: string,
  input: unknown,
  allowExisting?: string,
): Promise<{ root: string; path: string }> {
  const rel = relativeInput(input)
  const name = rel.split('/').pop() ?? ''
  if (!rel || !validName(name)) throw codedError('files.invalidName')
  const root = await realpath(rootPath).catch(() => {
    throw new Error('项目目录不存在')
  })
  const lexical = resolve(root, rel)
  if (!inside(root, lexical) || lexical === root) throw codedError('files.outsideProject')
  let parent: string
  try {
    parent = await realpath(dirname(lexical))
    if (!(await stat(parent)).isDirectory()) throw new Error()
  } catch {
    throw codedError('files.parentMissing')
  }
  if (parent !== root && !inside(root, parent)) throw codedError('files.outsideProject')
  const path = join(parent, name)
  const existing = await lstat(path).catch(() => null)
  // 只改大小写（a.ts → A.ts）：不区分大小写的文件系统上新旧是同一个条目，允许；区分大小写时（Linux、WSL、
  // SSH 远端）A.ts 可能是另一个文件，要拒绝，否则会被覆盖。按 dev + ino 判断是不是同一个条目，不按字符串
  let sameEntry = false
  if (existing && allowExisting !== undefined && allowExisting.toLowerCase() === path.toLowerCase()) {
    const source = await lstat(allowExisting).catch(() => null)
    sameEntry = !!source && source.dev === existing.dev && source.ino === existing.ino
  }
  if (existing && !sameEntry) throw codedError('files.exists', { name })
  return { root, path }
}

const relativeTo = (root: string, path: string): string => relative(root, path).split(sep).join('/')

/** 「::N/…」：第 N 个附加文件夹里的路径（docs/ui/multi-root-projects.md §3.4）；以前的路径不允许带冒号，所以不会撞上 */
const EXTRA_FOLDER = /^::(\d{1,2})(?:[\\/]|$)/

/** 路径在哪个文件夹：root 是那个文件夹，rel 是相对它的路径，prefix 是返回路径时要加回去的前缀 */
export function locateFolder(target: WorkspaceTarget, input: unknown): { root: string; rel: unknown; prefix: string } {
  const match = typeof input === 'string' ? EXTRA_FOLDER.exec(input) : null
  if (!match) return { root: target.path, rel: input, prefix: '' }
  const folder = target.folders?.[Number(match[1]) - 1]
  if (!folder) throw codedError('files.notFound')
  return { root: folder.path, rel: (input as string).slice(match[0].length), prefix: `::${match[1]}/` }
}

/** 主文件夹和每个附加文件夹：[根目录, 前缀] */
const allFolders = (target: WorkspaceTarget): [string, string][] => [
  [target.path, ''],
  ...(target.folders ?? []).map((f, i): [string, string] => [f.path, `::${i + 1}/`]),
]

async function boundedRead(file: string, max: number): Promise<Buffer> {
  const h = await open(file, 'r')
  try {
    if (!(await h.stat()).isFile()) throw new Error('目标不是普通文件')
    const buffer = Buffer.alloc(max + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await h.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > max) throw new Error('文件太大，请用外部编辑器打开')
    return buffer.subarray(0, offset)
  } finally {
    await h.close()
  }
}

function decode(path: string, bytes: Buffer): Extract<FileDocument, { kind: 'text' }> {
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
  const body = bom ? bytes.subarray(3) : bytes
  if (body.includes(0)) throw new Error('二进制文件或非 UTF-8 编码，请用外部编辑器打开')
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new Error('暂不支持此文件编码，请用外部编辑器打开')
  }
  return {
    kind: 'text',
    path,
    content,
    version: HASH(bytes),
    bytes: bytes.length,
    bom,
    newline: content.includes('\r\n') ? 'crlf' : 'lf',
  }
}

export interface WorkspaceFilesOptions {
  /** 删除时移到回收站：本机是系统回收站，远端是数据目录里的回收目录；不提供时拒绝删除 */
  trash?: (absolute: string, relative: string) => Promise<void>
  /** 智能体可按路径读取的私有临时文件目录 */
  attachmentDir?: string
}

interface StagedUpload {
  dir: string
  part: string
  path: string
  bytes: number
  written: number
}

const safeStageName = (name: string): string => {
  const safe = basename(name.replaceAll('\\', '/'))
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .slice(0, 240)
  return safe && safe !== '.' && safe !== '..' ? safe : 'attachment'
}

export class WorkspaceFiles {
  private saves = new Map<string, Promise<unknown>>()
  private stagedUploads = new Map<string, StagedUpload>()
  constructor(
    private resolveTarget: TargetResolver,
    private options: WorkspaceFilesOptions = {},
  ) {}
  target(value: unknown): WorkspaceTarget {
    return this.resolveTarget(workspaceRef(value))
  }

  private stageRoot(): string {
    return this.options.attachmentDir ?? join(tmpdir(), 'pixelsky-file-references')
  }

  /** 清理超过保留期限的临时附件。 */
  async cleanExpiredStages(): Promise<void> {
    const root = this.stageRoot()
    await mkdir(root, { recursive: true, mode: 0o700 })
    const cutoff = Date.now() - STAGED_FILE_TTL_MS
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      const info = await stat(dir).catch(() => null)
      if (info && info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true })
    }
  }

  /** 将文件分块写入当前工作区所属机器的私有临时目录。 */
  async stage(ref: WorkspaceRef, raw: unknown): Promise<{ path?: string }> {
    this.target(ref)
    if (!raw || typeof raw !== 'object') throw new Error('文件引用请求不正确')
    const request = raw as FileStageRequest
    if (typeof request.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.id)) throw new Error('文件引用编号不正确')
    if (request.action === 'begin') {
      if (
        typeof request.name !== 'string' ||
        !request.name ||
        request.name.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(request.name) ||
        !Number.isSafeInteger(request.bytes) ||
        request.bytes < 0 ||
        request.bytes > MAX_STAGED_FILE_BYTES
      )
        throw new Error('文件引用参数不正确或文件超过 1 GB')
      if (this.stagedUploads.has(request.id)) throw new Error('文件引用编号已使用')
      const dir = join(this.stageRoot(), request.id)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const part = join(dir, 'payload.part')
      const handle = await open(part, 'wx', 0o600)
      await handle.close()
      this.stagedUploads.set(request.id, {
        dir,
        part,
        path: join(dir, `file-${safeStageName(request.name)}`),
        bytes: request.bytes,
        written: 0,
      })
      return {}
    }
    if (request.action === 'cancel') {
      const upload = this.stagedUploads.get(request.id)
      this.stagedUploads.delete(request.id)
      if (upload) await rm(upload.dir, { recursive: true, force: true })
      return {}
    }
    const upload = this.stagedUploads.get(request.id)
    if (!upload) throw new Error('文件引用上传已过期，请重试')
    if (request.action === 'chunk') {
      if (
        !Number.isSafeInteger(request.offset) ||
        request.offset !== upload.written ||
        typeof request.dataBase64 !== 'string' ||
        request.dataBase64.length > Math.ceil((FILE_STAGE_CHUNK_BYTES + 2) / 3) * 4
      )
        throw new Error('文件引用数据块不正确')
      const bytes = Buffer.from(request.dataBase64, 'base64')
      if (
        !bytes.length ||
        bytes.length > FILE_STAGE_CHUNK_BYTES ||
        bytes.toString('base64') !== request.dataBase64 ||
        upload.written + bytes.length > upload.bytes
      )
        throw new Error('文件引用数据块不正确')
      const handle = await open(upload.part, 'r+')
      try {
        const result = await handle.write(bytes, 0, bytes.length, upload.written)
        if (result.bytesWritten !== bytes.length) throw new Error('文件引用写入不完整')
        upload.written += result.bytesWritten
      } finally {
        await handle.close()
      }
      return {}
    }
    if (request.action === 'finish') {
      if (upload.written !== upload.bytes || (await stat(upload.part)).size !== upload.bytes)
        throw new Error('文件引用大小不匹配，请重试')
      await rename(upload.part, upload.path)
      this.stagedUploads.delete(request.id)
      return { path: upload.path }
    }
    throw new Error('文件引用操作不支持')
  }

  /** 新建空文件或文件夹（docs/ui/files-search-terminal-pins.md §3）；返回相对项目的路径 */
  async create(ref: WorkspaceRef, path: unknown, kind: unknown): Promise<{ path: string }> {
    if (kind !== 'file' && kind !== 'folder') throw new Error('参数不正确')
    const at = locateFolder(this.target(ref), path)
    const target = await workspaceNewPath(at.root, at.rel)
    try {
      if (kind === 'folder') await mkdir(target.path)
      else await (await open(target.path, 'wx')).close()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST')
        throw codedError('files.exists', { name: basename(target.path) })
      throw err
    }
    return { path: at.prefix + relativeTo(target.root, target.path) }
  }

  /** 在同一项目内重命名或移动；目标已存在时拒绝。不能跨文件夹移动（主文件夹和附加文件夹之间） */
  async rename(ref: WorkspaceRef, from: unknown, to: unknown): Promise<{ path: string }> {
    const workspace = this.target(ref)
    const at = locateFolder(workspace, from)
    const dest = locateFolder(workspace, to)
    if (at.prefix !== dest.prefix) throw codedError('files.outsideProject')
    const source = await workspaceEntry(at.root, at.rel)
    const target = await workspaceNewPath(at.root, dest.rel, source.path)
    if (target.path === source.path) return { path: at.prefix + relativeTo(source.root, source.path) }
    // 不能把文件夹移进它自己里面（只改大小写时 Windows 的路径比较会把两者当成同一个，跳过这个检查）
    const caseOnly = target.path.toLowerCase() === source.path.toLowerCase()
    if (!caseOnly && inside(source.path, target.path)) throw codedError('files.outsideProject')
    try {
      await rename(source.path, target.path)
    } catch (err) {
      // Windows 上文件被别的程序占着会报 EBUSY / EPERM；目标在另一个盘上报 EXDEV
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM') throw codedError('files.busy', { name: basename(source.path) })
      if (code === 'EXDEV') throw codedError('files.crossDevice')
      throw err
    }
    return { path: at.prefix + relativeTo(target.root, target.path) }
  }

  /** 删除：移到回收站，不做永久删除 */
  async remove(ref: WorkspaceRef, path: unknown): Promise<void> {
    if (!this.options.trash) throw new Error('当前环境不能删除文件')
    const at = locateFolder(this.target(ref), path)
    const entry = await workspaceEntry(at.root, at.rel)
    try {
      await this.options.trash(entry.path, relativeTo(entry.root, entry.path))
    } catch (err) {
      throw codedError('files.trashFailed', { reason: (err as Error).message })
    }
  }

  async list(ref: WorkspaceRef, path: string): Promise<DirectoryListing> {
    const at = locateFolder(this.target(ref), path)
    const dir = await workspacePath(at.root, at.rel, 'directory')
    const all = (await readdir(dir, { withFileTypes: true })).filter(e => e.name !== '.git')
    all.sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }),
    )
    const entries = await Promise.all(
      all.slice(0, PAGE_LIMIT).map(async e => {
        const next = (path ? path.replaceAll('\\', '/') + '/' : '') + e.name
        let kind: 'directory' | 'file' = e.isDirectory() ? 'directory' : 'file'
        if (e.isSymbolicLink()) {
          try {
            if ((await stat(join(dir, e.name))).isDirectory()) kind = 'directory'
          } catch {
            /* 展示失效链接，打开时说明 */
          }
        }
        return { name: e.name, path: next, kind, linked: e.isSymbolicLink() }
      }),
    )
    return { entries, truncated: all.length > PAGE_LIMIT }
  }

  /**
   * 同 list，但目录不存在时返回 null、不报错：对话和终端里的路径链接、输入框的 @ 菜单只是问一下有没有，
   * 不存在是常事。报错的话 Electron 会把每一次都当错误打到控制台、进日志（ERROR console … files.notFound）
   */
  async listExisting(ref: WorkspaceRef, path: string): Promise<DirectoryListing | null> {
    try {
      return await this.list(ref, path)
    } catch (err) {
      if (parseCodedError(err instanceof Error ? err.message : null)?.code === 'files.notFound') return null
      throw err
    }
  }

  async search(ref: WorkspaceRef, name: string): Promise<DirectoryListing> {
    if (typeof name !== 'string' || name.length > 160) throw new Error('筛选名称过长')
    const term = name.trim().toLocaleLowerCase()
    if (!term) return this.list(ref, '')
    // 多文件夹项目：按顺序搜每个文件夹（主文件夹先），共用同一个上限和时限；
    // 主文件夹不在了报错，附加文件夹不在了（删掉、移走、暂时访问不了）就跳过，和 grep / status 一样（#85）
    const roots: [string, string][] = []
    for (const [i, [path, prefix]] of allFolders(this.target(ref)).entries()) {
      const root =
        i === 0
          ? await workspacePath(path, '', 'directory')
          : await workspacePath(path, '', 'directory').catch(() => null)
      if (root) roots.push([root, prefix])
    }
    const entries: DirectoryListing['entries'] = []
    const queue: [string, string, string][] = roots.map(([root, prefix]) => [root, prefix, ''])
    let examined = 0
    const deadline = Date.now() + 2500
    while (queue.length && examined < 10000 && entries.length < SEARCH_LIMIT && Date.now() < deadline) {
      const [root, prefix, path] = queue.shift()!
      let children
      try {
        children = await readdir(join(root, path), { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of children) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        if (++examined > 10000 || entries.length >= SEARCH_LIMIT) break
        const next = path ? `${path}/${e.name}` : e.name
        if (e.name.toLocaleLowerCase().includes(term))
          entries.push({
            name: e.name,
            path: prefix + next,
            kind: e.isDirectory() ? 'directory' : 'file',
            linked: e.isSymbolicLink(),
          })
        if (e.isDirectory() && !e.isSymbolicLink()) queue.push([root, prefix, next])
      }
    }
    return { entries, truncated: queue.length > 0 || examined >= 10000 || entries.length >= SEARCH_LIMIT }
  }

  /** 内容搜索（git grep 或逐个读文件），路径相对项目 */
  async grep(ref: WorkspaceRef, query: unknown): Promise<GrepResult> {
    const folders = allFolders(this.target(ref))
    const main = await grepWorkspace(await workspacePath(folders[0][0], '', 'directory'), query)
    if (folders.length === 1) return main
    // 多文件夹项目：每个文件夹各搜一遍，结果按文件夹顺序接起来；一个文件夹搜不了（不在了）就跳过
    const matches = [...main.matches]
    let truncated = main.truncated
    for (const [path, prefix] of folders.slice(1)) {
      const result = await workspacePath(path, '', 'directory')
        .then(root => grepWorkspace(root, query))
        .catch(() => null)
      if (!result) continue
      matches.push(...result.matches.map(m => ({ ...m, path: prefix + m.path })))
      truncated ||= result.truncated
    }
    return { matches, truncated }
  }

  async read(ref: WorkspaceRef, path: string): Promise<FileDocument> {
    const at = locateFolder(this.target(ref), path)
    const file = await workspacePath(at.root, at.rel, 'file')
    const info = await stat(file)
    const image = IMAGES[extname(file).toLowerCase()]
    try {
      const bytes = await boundedRead(file, image ? IMAGE_LIMIT : READ_LIMIT)
      if (image)
        return { kind: 'image', path, dataUrl: `data:${image};base64,${bytes.toString('base64')}`, bytes: bytes.length }
      return { ...decode(path, bytes), readonly: bytes.length > TEXT_LIMIT }
    } catch (e) {
      return { kind: 'unsupported', path, reason: (e as Error).message, bytes: info.size }
    }
  }

  /** HEAD 路径使用仓库前缀，避免子目录项目读错文件；未跟踪与非 Git 项目返回 null。 */
  async headContent(ref: WorkspaceRef, path: string): Promise<string | null> {
    const at = locateFolder(this.target(ref), path)
    const rel = typeof at.rel === 'string' ? at.rel : path
    const cwd = await workspacePath(at.root, '', 'directory')
    await workspacePath(cwd, rel, 'file')
    // 不设 cwd、用 -C：Windows 按裸名启动时会先在 cwd 里找，项目里的 git.exe 不能顶替真正的 git
    const git = (args: string[]): Promise<string | null> =>
      new Promise(done => {
        execFile(
          'git',
          ['-C', cwd, ...args],
          { windowsHide: true, timeout: 2000, maxBuffer: READ_LIMIT, encoding: 'utf8' },
          (err, out) => done(err ? null : out),
        )
      })
    const prefix = await git(['rev-parse', '--show-prefix'])
    if (prefix === null) return null
    const content = await git(['show', `HEAD:${prefix.trim()}${rel.replaceAll('\\', '/')}`])
    return content === null || content.includes('\0') ? null : content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  }

  /** 每文件串行保存；版本不一致禁止覆盖，打开句柄后再次核对原内容。 */
  async save(
    ref: WorkspaceRef,
    path: string,
    content: string,
    version: string,
  ): Promise<Extract<FileDocument, { kind: 'text' }>> {
    if (typeof content !== 'string' || typeof version !== 'string' || !/^[0-9a-f]{64}$/.test(version))
      throw new Error('保存参数不正确')
    if (Buffer.byteLength(content, 'utf8') > TEXT_LIMIT) throw new Error('内容太大，请用外部编辑器保存')
    const { root, rel } = locateFolder(this.target(ref), path)
    const file = await workspacePath(root, rel, 'file')
    const previous = this.saves.get(file) ?? Promise.resolve()
    const job = previous
      .catch(() => {})
      .then(async () => {
        const actual = await workspacePath(root, rel, 'file')
        if (actual !== file) throw new Error('文件路径已经变化，请重新打开')
        const h = await open(file, 'r')
        const temporary = file + `.pixelsky-${randomUUID()}.tmp`
        try {
          const info = await h.stat()
          if (!info.isFile() || info.size > TEXT_LIMIT) throw new Error('文件已变化，请重新加载')
          const original = await h.readFile()
          if (HASH(original) !== version) throw codedError('files.changedOutside')
          const old = decode(path, original)
          const normalized = content.replace(/\r\n/g, '\n').replace(/\n/g, old.newline === 'crlf' ? '\r\n' : '\n')
          const next = Buffer.concat([
            old.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
            Buffer.from(normalized),
          ])
          if (next.length > TEXT_LIMIT) throw new Error('内容太大，请用外部编辑器保存')
          const output = await open(temporary, 'wx', info.mode)
          try {
            await output.writeFile(next)
            await output.sync()
          } finally {
            await output.close()
          }
          // 临时文件写好后再次核对，写入失败保留原文件；保存不更换符号链接本身。
          if (
            (await workspacePath(root, rel, 'file')) !== file ||
            HASH(await boundedRead(file, TEXT_LIMIT)) !== version
          )
            throw codedError('files.changedOutside')
          await h.close()
          await rename(temporary, file)
          return decode(path, next)
        } finally {
          await h.close().catch(() => {})
          await unlink(temporary).catch(() => {})
        }
      })
    this.saves.set(file, job)
    try {
      return await job
    } finally {
      if (this.saves.get(file) === job) this.saves.delete(file)
    }
  }

  /** 文件树上的 Git 标记；多文件夹项目里每个文件夹各查各的仓库，附加文件夹的路径带「::N/」 */
  async status(ref: WorkspaceRef): Promise<Record<string, string>> {
    const statuses: Record<string, string> = {}
    for (const [path, prefix] of allFolders(this.target(ref))) {
      // 主文件夹不在了照旧报错；附加文件夹不在了就跳过
      const cwd = prefix
        ? await workspacePath(path, '', 'directory').catch(() => null)
        : await workspacePath(path, '', 'directory')
      if (!cwd) continue
      const [changes, ignored] = await Promise.all([gitStatus(cwd), gitIgnored(cwd)])
      for (const [file, code] of Object.entries(changes)) statuses[prefix + file] = code
      // 被忽略的只补没有别的状态的路径（忽略的文件不会有改动，保险起见）
      for (const file of ignored) statuses[prefix + file] ??= IGNORED_STATUS
    }
    return statuses
  }
}

/** 条数上限：超过的部分不再变暗，免得一个满是忽略文件的目录拖垮树 */
const IGNORED_LIMIT = 20_000

/**
 * git ls-files -z --others --ignored --directory 的输出 → 相对 cwd 的路径列表。
 * 整个文件夹被忽略时 git 只报这个文件夹（带结尾 /），去掉结尾 /；
 * '' / '.' / './' 是 cwd 本身被上层仓库忽略，不算（否则整棵树都变暗）。
 */
export function parseIgnoredOutput(out: string): string[] {
  const paths: string[] = []
  for (const record of out.split('\0')) {
    const path = record.replace(/\/+$/, '')
    if (!path || path === '.') continue
    paths.push(path)
    if (paths.length >= IGNORED_LIMIT) break
  }
  return paths
}

/**
 * 文件树的 git 查询只读：不抢 index.lock（AI 同时在跑 git 时不会让它失败），不弹凭据框
 * （docs/perf-audit-2026-10-18.md B5）
 */
const quietGit = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' })
// 与项目 Git 面板的只读查询保持一致，给 Windows 慢机器上的 Git 启动留出时间。
const GIT_READ_TIMEOUT = 15_000

/**
 * 被 .gitignore 等规则忽略的路径（相对 cwd）。不能加 --no-empty-directory：它会丢掉「没被忽略的未跟踪目录」里的被忽略文件。
 * 任何失败都返回 []（不是仓库、超时，或 git 报「directory entry not superset of prefix」——文件夹在上层仓库的忽略目录里时会这样）
 */
function gitIgnored(cwd: string): Promise<string[]> {
  return new Promise(resolveIgnored => {
    execFile(
      'git',
      [
        '-C',
        cwd,
        '-c',
        'core.quotepath=false',
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '--',
        '.',
      ],
      { windowsHide: true, timeout: GIT_READ_TIMEOUT, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: quietGit() },
      (err, output) => resolveIgnored(err ? [] : parseIgnoredOutput(output)),
    )
  })
}

function gitStatus(cwd: string): Promise<Record<string, string>> {
  return new Promise(resolveStatus => {
    execFile(
      'git',
      [
        '-C',
        cwd,
        '-c',
        'core.quotepath=false',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=normal',
        '--',
        '.',
      ],
      { windowsHide: true, timeout: GIT_READ_TIMEOUT, maxBuffer: 1024 * 1024, encoding: 'utf8', env: quietGit() },
      async (err, output) => {
        if (err) {
          resolveStatus({})
          return
        }
        // Porcelain 路径相对仓库根，先读取 prefix 以兼容会话 cwd 位于子目录。
        execFile(
          'git',
          ['-C', cwd, 'rev-parse', '--show-prefix'],
          { windowsHide: true, timeout: GIT_READ_TIMEOUT, encoding: 'utf8', env: quietGit() },
          (prefixError, prefixText) => {
            if (prefixError) {
              resolveStatus({})
              return
            }
            const prefix = prefixText.trim()
            const statuses: Record<string, string> = {}
            const records = output.split('\0')
            for (let i = 0; i < records.length; i++) {
              const row = records[i]
              if (row.length < 4) continue
              const code = row.slice(0, 2).trim()
              const original = row.slice(3)
              if (code.includes('R') || code.includes('C')) i++
              if (prefix && !original.startsWith(prefix)) continue
              const path = original.slice(prefix.length).replace(/\/$/, '')
              statuses[path] =
                code === '??'
                  ? '?'
                  : code.includes('U')
                    ? '!'
                    : code.includes('D')
                      ? 'D'
                      : code.includes('A')
                        ? 'A'
                        : code.includes('R')
                          ? 'R'
                          : 'M'
            }
            resolveStatus(statuses)
          },
        )
      },
    )
  })
}
