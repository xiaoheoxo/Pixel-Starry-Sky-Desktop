// 文字里的路径 → 项目内确实存在的文件（终端 docs/ui/files-search-terminal-pins.md §4.2，对话 docs/ui/content-highlight.md §2 A）。
// 项目 / 会话的根目录（含附加文件夹）缓存 30 秒，目录列表缓存几秒：鼠标划过同一屏输出、一条回复里有很多路径时不会反复读盘。
import { isWindowsMachine, machineOf } from '@/features/machines/store'
import type { WorkspaceRef, WorkspaceTarget } from '../../../../shared/types/workspace'
import { linkPathText, type LinkTarget } from '@/ui/markdown/pathLinks'
import { findPathMatches, projectPath } from './pathMatch'
import { OUTSIDE_PREFIX, isAbsolutePath } from './extraFolderPaths'

const LIST_TTL = 5000
/** 项目的附加文件夹可能改（docs/ui/multi-root-projects.md §3），目标只缓存一会儿 */
const TARGET_TTL = 30_000
const targets = new Map<string, { at: number; target: Promise<WorkspaceTarget | null> }>()
/** 目录里的条目：名字（Windows 上小写）→ 文件还是文件夹 */
type Entries = Map<string, 'file' | 'directory'>
const listings = new Map<string, { at: number; names: Promise<Entries | null> }>()

const refKey = (ref: WorkspaceRef): string => (ref.sessionId ? `s:${ref.sessionId}` : `p:${ref.projectId}`)

function workspaceTarget(ref: WorkspaceRef): Promise<WorkspaceTarget | null> {
  const key = refKey(ref),
    cached = targets.get(key)
  if (cached && Date.now() - cached.at < TARGET_TTL) return cached.target
  const target = window.pixelsky!.files.target(ref).catch(() => null)
  targets.set(key, { at: Date.now(), target })
  return target
}

/** 项目根目录（会话是会话的工作目录） */
export async function workspaceRoot(ref: WorkspaceRef): Promise<string | null> {
  return (await workspaceTarget(ref))?.path ?? null
}

function entriesIn(ref: WorkspaceRef, dir: string, windows: boolean): Promise<Entries | null> {
  const key = refKey(ref) + '\0' + dir,
    cached = listings.get(key)
  if (cached && Date.now() - cached.at < LIST_TTL) return cached.names
  const names = window
    .pixelsky!.files.listExisting(ref, dir)
    .then(list =>
      list ? (new Map(list.entries.map(e => [windows ? e.name.toLowerCase() : e.name, e.kind])) as Entries) : null,
    )
    .catch(() => null)
  listings.set(key, { at: Date.now(), names })
  if (listings.size > 200) listings.delete(listings.keys().next().value!)
  return names
}

/**
 * 一个路径 → 所选项目里的相对路径；项目外或解析不了时为 null，文件存在性由读取接口校验。
 * cwd 是相对路径的起点，不给时用项目根目录。
 */
export async function workspaceRelativePath(ref: WorkspaceRef, raw: string, cwd?: string): Promise<string | null> {
  if (!window.pixelsky) return null
  const windows = isWindowsMachine(machineOf(ref.projectId ?? ref.sessionId))
  const target = await workspaceTarget(ref)
  if (!target) return null
  const root = target.path
  let relative = projectPath(raw, cwd ?? root, root, windows)
  // 多文件夹项目：不在主文件夹里的再看附加文件夹，换成「::N/…」
  if (!relative)
    for (const [i, folder] of (target.folders ?? []).entries()) {
      const inFolder = projectPath(raw, cwd ?? root, folder.path, windows)
      if (inFolder) {
        relative = `::${i + 1}/${inFolder}`
        break
      }
    }
  return relative
}

/** 同 workspaceRelativePath，项目外的完整路径换成「::0/完整路径」（docs/ui/outside-files.md）；相对路径解析不了时 null */
export async function workspacePathOrOutside(ref: WorkspaceRef, raw: string): Promise<string | null> {
  const relative = await workspaceRelativePath(ref, raw)
  if (relative) return relative
  const normalized = raw.replaceAll('\\', '/')
  return isAbsolutePath(normalized) ? OUTSIDE_PREFIX + normalized : null
}

/** 项目内确实存在的文件；图片读取不依赖目录缓存，交给 files.read 校验文件。 */
export async function workspaceFilePath(ref: WorkspaceRef, raw: string, cwd?: string): Promise<string | null> {
  const relative = await workspaceRelativePath(ref, raw, cwd)
  if (!relative) return null
  const windows = isWindowsMachine(machineOf(ref.projectId ?? ref.sessionId))
  return (await entryKind(ref, relative, windows)) === 'file' ? relative : null
}

/** 项目里一个相对路径是文件、文件夹还是不存在 */
async function entryKind(ref: WorkspaceRef, relative: string, windows: boolean): Promise<'file' | 'directory' | null> {
  const parts = relative.split('/'),
    name = parts.pop()!
  const entries = await entriesIn(ref, parts.join('/'), windows)
  return entries?.get(windows ? name.toLowerCase() : name) ?? null
}

/** 末尾的 :行 / :行:列 拆出来（E:/x 的盘符冒号后面不是数字，不会被拆） */
export function splitLine(text: string): { path: string; line: number | null; column: number | null } {
  const m = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(text)!
  return { path: m[1], line: m[2] ? Number(m[2]) : null, column: m[3] ? Number(m[3]) : null }
}

/** 本机上的完整路径：Windows 要盘符，其余 / 开头；\\主机\共享、//主机/共享 这种网络路径不算 */
export const localAbsolute = (path: string, windows: boolean): boolean =>
  windows ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith('/') && !path.startsWith('//')

/**
 * Markdown 链接地址 → 项目里的文件 / 文件夹，或项目外本机上存在的路径（docs/ui/path-click.md）。
 * 地址是明确给出的路径，不像行内代码那样猜：有空格、没有扩展名都认。
 * 项目外的路径只认本机会话：远程机器上的路径在这台电脑上没法显示
 */
export async function linkTarget(ref: WorkspaceRef, text: string): Promise<LinkTarget | null> {
  if (!window.pixelsky) return null
  const { path: raw, line, column } = splitLine(text.trim())
  if (!raw) return null
  const local = machineOf(ref.projectId ?? ref.sessionId) === 'local'
  const windows = isWindowsMachine(machineOf(ref.projectId ?? ref.sessionId))
  if (!(await workspaceRoot(ref))) return null
  // 主文件夹和附加文件夹（「::N/…」）里的都算项目里的（#86）
  const relative = await workspaceRelativePath(ref, raw)
  if (relative) {
    const kind = await entryKind(ref, relative, windows)
    if (kind === 'file') return { kind: 'file', path: relative, line, column }
    if (kind === 'directory') return { kind: 'folder', path: relative }
    return null
  }
  if (!local || !localAbsolute(raw, windows)) return null
  const full = windows ? raw.replaceAll('/', '\\') : raw
  const kind = await window.pixelsky.editor.statOutside(full).catch(() => null)
  return kind ? { kind: 'outside', path: full, folder: kind === 'folder' } : null
}

export interface FileTarget {
  /** 相对项目根目录，用 / 分隔 */
  path: string
  line: number | null
  column: number | null
}

/**
 * 一整段文字（行内代码、@ 后面的路径）恰好是一个路径（可带 :行 / :行:列）时，解析成项目里存在的文件；
 * 文字里还有别的内容、或者文件不存在时为 null。
 */
export async function wholeTextFile(ref: WorkspaceRef, text: string): Promise<FileTarget | null> {
  // `file:///D:/x/a.html` 这种写法先换成路径（路径规则不认前面紧挨着 / 的盘符）
  const value = (/^\s*file:/i.test(text) ? (linkPathText(text.trim()) ?? '') : text).trim()
  const [match] = findPathMatches(value)
  if (!match || match.start !== 0 || match.end !== value.length) return null
  const path = await workspaceFilePath(ref, match.raw)
  return path ? { path, line: match.line, column: match.column } : null
}
