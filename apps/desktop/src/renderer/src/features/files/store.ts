import { isWindowsMachine, machineOf } from '@/features/machines/store'
import { tr } from '../../i18n/core'
import { useSyncExternalStore } from 'react'
import type { FileDocument, WorkspaceRef } from '../../../../shared/types/workspace'
import { isDemo, projects } from '@/data'
import { paneActions } from '@/features/panes/store'
import { getEngineState } from '@/features/engine/store'
import { fileTab, parseFileTab } from '@/features/panes/tree'
import {
  getPanelScope,
  openRightTab,
  detachPanelFile,
  renamePanelFile,
  replacePanelFile,
  panelFileIds,
  resolvePanelFileId,
} from '@/features/panel/workspaceStore'
import { demo } from '@/data/demo'
import { renameRecentFile } from '@/features/panel/recentFiles'
import { OUTSIDE_PREFIX, isAbsolutePath, relativeInFolders } from './extraFolderPaths'

export const OPEN_FILES_EVENT = 'pixelsky:open-files'
export const FILE_CLOSED_EVENT = 'pixelsky:file-closed'
/** 文件保存成功后广播：detail 是 { root, path }（「任务」视图靠它重新读 package.json 等） */
export const FILE_SAVED_EVENT = 'pixelsky:file-saved'
export interface OpenFile {
  preview?: boolean
  id: string
  ref: WorkspaceRef
  path: string
  name: string
  root: string
  project: string
  document: FileDocument | null
  draft: string
  cursor: { line: number; column: number }
  reveal: { line: number; column: number; seq: number } | null
  head: string | null
  external: FileDocument | null
  ignoredVersion: string | null
  changed: number
  loading: boolean
  saving: boolean
  error: string | null
}
interface State {
  tabs: OpenFile[]
  active: string | null
}
let state: State = { tabs: [], active: null }
const listeners = new Set<() => void>()
const checking = new Set<string>()
/** 正在读 HEAD 的标签 → 读的途中又被要求重读（读完再补一次，免得拿到的是提交前的 HEAD） */
const headChecking = new Map<string, boolean>()
function set(next: State): void {
  state = next
  listeners.forEach(l => l())
}
export function subscribeFiles(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
export function useFiles(): State {
  return useSyncExternalStore(subscribeFiles, () => state)
}
export const getFiles = (): State => state
/** 删除会话前把文件 API 目标改为长期存在的项目；当前标签 id 不变，保留 EditorView 与草稿。 */
export function retainSessionFiles(sessionId: string): void {
  const affected = state.tabs.filter(tab => tab.ref.sessionId === sessionId)
  const stored = panelFileIds().filter(id => parseFileTab(resolvePanelFileId(id))?.ref.sessionId === sessionId)
  if (!affected.length && !stored.length) return
  const engine = getEngineState(),
    record = engine.snapshots[sessionId]?.record ?? engine.sessions.find(s => s.record.id === sessionId)?.record
  const project = engine.projects.find(
    p => record && p.id === record.projectId && p.path.toLowerCase() === record.cwd.toLowerCase(),
  )
  if (!project) throw new Error('先保存并关闭这个会话打开的文件，再删除会话')
  set({
    ...state,
    tabs: state.tabs.map(tab => (tab.ref.sessionId === sessionId ? { ...tab, ref: { projectId: project.id } } : tab)),
  })
  for (const tab of affected) replacePanelFile(tab.id, fileTab({ projectId: project.id }, tab.path))
  for (const id of stored) replacePanelFile(id, fileTab({ projectId: project.id }, parseFileTab(id)!.path))
}
const sameRef = (a: WorkspaceRef, b: WorkspaceRef): boolean =>
  a.projectId === b.projectId && a.sessionId === b.sessionId
/** path 本身或它下面的文件（文件夹改名 / 删除时一起处理） */
const under = (path: string, base: string): boolean => path === base || path.startsWith(base + '/')

/** 已打开的、位于 path（文件或文件夹）下的文件（docs/ui/files-search-terminal-pins.md §3） */
export const openFilesUnder = (ref: WorkspaceRef, path: string): OpenFile[] =>
  state.tabs.filter(tab => sameRef(tab.ref, ref) && under(tab.path, path))

/** 改名 / 移动后标签 id 换了：编辑器实例、右栏布局、代码模式标签、最近文件、窗格跟着换（detail 是 FileRename[]） */
export const FILE_RENAMED_EVENT = 'pixelsky:file-renamed'
export interface FileRename {
  from: string
  to: string
}

/**
 * 改名 / 移动 from → to 会被顶掉、还有未保存修改的标签：from 下面已打开的文件挪过去后，id 和新路径上已有的标签撞上了。
 * 文件树在改名前用它先问（取消就不动磁盘）；确认后把这些 id 传给 renameOpenFiles 的 discard
 */
export function displacedDirtyFiles(ref: WorkspaceRef, from: string, to: string): OpenFile[] {
  const moving = (tab: OpenFile): boolean => sameRef(tab.ref, ref) && under(tab.path, from)
  const incoming = new Set(state.tabs.filter(moving).map(tab => fileTab(tab.ref, to + tab.path.slice(from.length))))
  return state.tabs.filter(tab => !moving(tab) && incoming.has(tab.id) && dirtyFile(tab))
}

/**
 * 文件树重命名 / 移动后，已打开的标签换成新路径和新 id（id 由路径算出），草稿、编辑器（含撤销记录）都保留。
 * 原来 id 不变、只记一笔「旧 id → 新 id」：之后在旧路径新建或打开文件会算出同一个 id，打开的是改名后的文件，
 * 保存也写进它；代码模式的标签和最近文件还记着旧 id，重启后指向旧路径（审查报告 2026-10-14）。
 * 新路径上已经有标签（文件早已不在或被外部移走、标签还留着）：没改过的去掉，免得两个标签同一个 id；
 * 有未保存修改的只有在 discard 里（用户确认过丢弃）才去掉，否则留着它，撞上的那个标签不挪（兜底，不丢草稿）
 */
export function renameOpenFiles(ref: WorkspaceRef, from: string, to: string, discard: readonly string[] = []): void {
  const moving = (tab: OpenFile): boolean => sameRef(tab.ref, ref) && under(tab.path, from)
  const held = new Map(state.tabs.filter(tab => !moving(tab)).map(tab => [tab.id, tab]))
  const moves: FileRename[] = []
  const tabs = state.tabs.map(tab => {
    if (!moving(tab)) return tab
    const path = to + tab.path.slice(from.length)
    const id = fileTab(tab.ref, path)
    const other = held.get(id)
    if (other && dirtyFile(other) && !discard.includes(other.id)) return tab
    if (id !== tab.id) moves.push({ from: tab.id, to: id })
    return { ...tab, id, path, name: path.split('/').pop() ?? path }
  })
  if (!moves.length) {
    if (tabs.some((t, i) => t !== state.tabs[i])) set({ ...state, tabs })
    return
  }
  const moved = new Set(moves.map(m => m.from))
  const taken = new Set(moves.map(m => m.to))
  const kept = tabs.filter((t, i) => !(taken.has(t.id) && !moved.has(state.tabs[i].id)))
  const active = moves.find(m => m.from === state.active)?.to ?? state.active
  set({ tabs: kept, active })
  for (const m of moves) {
    renamePanelFile(m.from, m.to)
    paneActions.replace(m.from, m.to)
    renameRecentFile(m.from, m.to)
  }
  // 代码模式的标签组、编辑器实例在各自模块里换（它们引用这个模块，不能反过来引用）
  window.dispatchEvent(new CustomEvent<FileRename[]>(FILE_RENAMED_EVENT, { detail: moves }))
}

export const dirtyFile = (tab: OpenFile): boolean =>
  tab.document?.kind === 'text' && tab.draft !== tab.document.content.replace(/\r\n/g, '\n')
export const updateFile = (id: string, patch: Partial<OpenFile>): void =>
  set({ ...state, tabs: state.tabs.map(t => (t.id === id ? { ...t, ...patch } : t)) })
export function showFiles(ref?: WorkspaceRef, path?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_FILES_EVENT, { detail: { ref, path } }))
}
export const activateFile = (id: string): void => {
  if (state.active !== id) set({ ...state, active: id })
}
export function removeFile(id: string): void {
  detachPanelFile(id)
  const index = state.tabs.findIndex(t => t.id === id),
    tabs = state.tabs.filter(t => t.id !== id)
  set({ tabs, active: state.active === id ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null) : state.active })
  window.dispatchEvent(new CustomEvent(FILE_CLOSED_EVENT, { detail: id }))
}
export async function loadFile(id: string): Promise<void> {
  const tab = state.tabs.find(t => t.id === id)
  if (!tab) return
  updateFile(id, { loading: true, error: null })
  try {
    const document = isDemo ? demo().files.document(tab.path) : await window.pixelsky!.files.read(tab.ref, tab.path)
    updateFile(id, {
      document,
      draft: document.kind === 'text' ? document.content.replace(/\r\n/g, '\n') : '',
      external: null,
      ignoredVersion: null,
      loading: false,
    })
    if (document.kind === 'text' && !document.readonly) {
      // 演示模式：有 git 对比的文件用 HEAD 版本，让 gutter 和「对比 HEAD」有内容（D12）
      const head = isDemo
        ? (demo().git.diff(tab.path)?.original ?? document.content).replace(/\r\n/g, '\n')
        : await window.pixelsky!.files.headContent(tab.ref, tab.path).catch(() => null)
      updateFile(id, { head })
    } else updateFile(id, { head: null })
  } catch (e) {
    updateFile(id, { error: (e as Error).message, loading: false })
  }
}
export async function ensureFile(id: string): Promise<void> {
  if (state.tabs.some(t => t.id === id)) return
  const parsed = parseFileTab(resolvePanelFileId(id))
  if (!parsed) return
  const { ref, path } = parsed
  const tab: OpenFile = {
    id,
    ref,
    path,
    root: '',
    project: '',
    name: path.split('/').pop() ?? path,
    document: null,
    draft: '',
    cursor: { line: 1, column: 1 },
    reveal: null,
    head: null,
    external: null,
    ignoredVersion: null,
    changed: 0,
    loading: true,
    saving: false,
    error: null,
  }
  set({ ...state, tabs: [...state.tabs, tab] })
  if (isDemo) {
    const project = projects.find(p => p.id === ref.projectId || p.sessions.some(s => s.id === ref.sessionId))
    updateFile(id, { root: project?.name ?? '', project: project?.name ?? '' })
  } else {
    try {
      const target = await window.pixelsky!.files.target(ref)
      updateFile(id, { root: target.path.replaceAll('\\', '/'), project: target.name })
    } catch {
      /* loadFile 提供实际错误 */
    }
  }
  await loadFile(id)
}
export type FileOpenTarget = 'auto' | 'panel' | 'code'
export interface OpenFileOptions {
  target?: FileOpenTarget
}
let codeOpener: ((id: string) => void) | null = null
/** 代码模式注册自己的打开方式；null 表示回到右侧工作区 */
export function setCodeOpener(opener: ((id: string) => void) | null): void {
  codeOpener = opener
}
export const hasCodeOpener = (): boolean => codeOpener !== null
/** 返回打开的文件 id；打不开时 null */
export async function openFile(
  ref: WorkspaceRef,
  path: string,
  line?: number,
  column = 1,
  searchText?: string,
  options: OpenFileOptions = {},
): Promise<string | null> {
  const panelScope = getPanelScope()
  let normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  // 从附加文件夹的 Git 面板打开（ref 带 folder）：换成项目里的「::N/…」，和文件树打开的是同一个标签
  if (ref.folder) {
    normalized = `::${ref.folder}/${normalized}`
    ref = ref.sessionId ? { sessionId: ref.sessionId } : { projectId: ref.projectId! }
  }
  const demoProject = isDemo
    ? projects.find(p => p.id === ref.projectId || p.sessions.some(s => s.id === ref.sessionId))
    : null
  const target = isDemo
    ? { name: demoProject?.name ?? '', path: demoProject?.id ?? ref.projectId ?? ref.sessionId ?? '' }
    : await window.pixelsky!.files.target(ref)
  const machine = machineOf(ref.projectId ?? ref.sessionId),
    windows = isWindowsMachine(machine)
  const root = target.path.replaceAll('\\', '/'),
    key = windows ? root.toLowerCase() : root
  // 绝对路径（AI 改了附加文件夹里的文件，改动卡片给的是完整路径）：换成主文件夹的相对路径或「::N/…」
  // 都不在（AI 改了项目外的文件）：「::0/完整路径」，主进程以它所在的文件夹为根读写（docs/ui/outside-files.md）
  if (!isDemo && isAbsolutePath(normalized))
    normalized = relativeInFolders(normalized, target, windows) ?? `${OUTSIDE_PREFIX}${normalized}`
  const existing = state.tabs.find(
    t =>
      machineOf(t.ref.projectId ?? t.ref.sessionId) === machine &&
      (windows ? t.root.toLowerCase() : t.root) === key &&
      (windows ? t.path.toLowerCase() === normalized.toLowerCase() : t.path === normalized),
  )
  if (!isDemo && 'ref' in target) ref = target.ref
  const id = existing?.id ?? fileTab(ref, normalized)
  const loading = ensureFile(id)
  updateFile(id, { root, project: target.name })
  await loading
  const current = state.tabs.find(t => t.id === id)
  // 指名了行（搜索结果、路径链接）：Markdown 不停在预览，切到源码那一行（docs/ui/markdown-preview.md §2）
  const named = line !== undefined || !!searchText
  if (searchText && current?.document?.kind === 'text') {
    const index = current.draft.indexOf(searchText.replace(/\r\n/g, '\n'))
    line = index >= 0 ? current.draft.slice(0, index).split('\n').length : 1
  }
  updateFile(id, {
    reveal: { line: Math.max(1, line ?? 1), column: Math.max(1, column), seq: (current?.reveal?.seq ?? 0) + 1 },
    ...(named && (line ?? 1) > 1 && /\.(md|markdown)$/i.test(normalized) ? { preview: false } : {}),
  })
  const target0 = options.target ?? 'auto'
  if ((target0 === 'code' || target0 === 'auto') && codeOpener) {
    codeOpener(id)
    activateFile(id)
  } else {
    paneActions.detachFileTab(id)
    openRightTab(id, panelScope)
    activateFile(id)
  }
  return id
}
export async function checkFile(id: string): Promise<void> {
  const tab = state.tabs.find(t => t.id === id)
  if (isDemo || !tab?.document || tab.loading || tab.saving || checking.has(id)) return
  checking.add(id)
  try {
    const next = await window.pixelsky!.files.read(tab.ref, tab.path),
      now = state.tabs.find(t => t.id === id)
    if (
      !now ||
      now.loading ||
      now.saving ||
      now.document?.kind !== 'text' ||
      (next.kind === 'text' && next.version === now.document.version)
    )
      return
    if (dirtyFile(now)) {
      if (next.kind !== 'text' || next.version !== now.ignoredVersion) updateFile(id, { external: next })
    } else
      updateFile(id, {
        document: next,
        draft: next.kind === 'text' ? next.content.replace(/\r\n/g, '\n') : '',
        external: null,
        changed: now.changed + 1,
        error: null,
      })
  } catch (e) {
    updateFile(id, { error: (e as Error).message })
  } finally {
    checking.delete(id)
  }
}
export const checkOpenFiles = (): void => {
  for (const tab of state.tabs) void checkFile(tab.id)
}

/**
 * 重读一个文本标签的 HEAD 版本（「变更 / 并排」的基准）：在软件里提交、切分支、终端里提交以后跟上。
 * 内容一样不更新；只读 / 非文本的标签没有基准
 */
export async function refreshHead(id: string): Promise<void> {
  const tab = state.tabs.find(t => t.id === id)
  if (isDemo || !tab || tab.document?.kind !== 'text' || tab.document.readonly) return
  if (headChecking.has(id)) {
    headChecking.set(id, true)
    return
  }
  headChecking.set(id, false)
  try {
    const head = await window.pixelsky!.files.headContent(tab.ref, tab.path).catch(() => null)
    const now = state.tabs.find(t => t.id === id)
    // null 既可能是「HEAD 里没有这个文件」也可能是 git 出错 / 超时：已有的基准不拿 null 盖掉（真从 HEAD 里删了的，重新打开才清）
    if (now && now.document?.kind === 'text' && head !== null && now.head !== head) updateFile(id, { head })
  } finally {
    const again = headChecking.get(id)
    headChecking.delete(id)
    if (again) await refreshHead(id)
  }
}

/** 同时最多几个标签在读 HEAD（每个要起两次 git；一次提交后几十个标签一起读会超时） */
const HEAD_CONCURRENCY = 3

/** 重读一批标签的 HEAD 版本（match 不给就是全部），限制并发 */
export async function refreshHeads(match?: (tab: OpenFile) => boolean): Promise<void> {
  const ids = state.tabs.filter(t => !match || match(t)).map(t => t.id)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < ids.length) await refreshHead(ids[next++])
  }
  await Promise.all(Array.from({ length: Math.min(HEAD_CONCURRENCY, ids.length) }, worker))
}

/** 窗口回到前台：只核对正在看的那个标签（每个标签都核对要起很多次 git） */
export const refreshActiveHead = (): void => {
  if (state.active) void refreshHead(state.active)
}
export async function saveFile(id: string): Promise<boolean> {
  const tab = state.tabs.find(t => t.id === id)
  if (!tab || tab.document?.kind !== 'text' || tab.document.readonly || tab.saving || tab.loading) return false
  if (!dirtyFile(tab)) return true
  updateFile(id, { saving: true, error: null })
  try {
    if (isDemo) throw new Error(tr('files.store.demoModeCannotSave'))
    const document = await window.pixelsky!.files.save(tab.ref, tab.path, tab.draft, tab.document.version)
    // 保存期间还可输入；只更新基线，不覆盖更晚的草稿。
    updateFile(id, { document, external: null, ignoredVersion: null, saving: false })
    window.dispatchEvent(new CustomEvent(FILE_SAVED_EVENT, { detail: { root: tab.root, path: tab.path } }))
    return true
  } catch (e) {
    updateFile(id, { error: (e as Error).message, saving: false })
    void checkFile(id)
    return false
  }
}
export const hasDirtyFiles = (): boolean => state.tabs.some(dirtyFile)
