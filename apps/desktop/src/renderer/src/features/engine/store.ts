// 引擎系统在界面这边的数据：引擎状态、项目、会话列表、打开过的会话快照。
// 数据来自主进程（window.pixelsky.engine），事件用 @pixelsky/protocol 的 reduce() 折叠，和主进程结果一致。
// 演示模式（--demo）不连接引擎：会话快照一开始装着演示的对话展示（docs/ui/demo-conversation.md），其余一直是空的，界面照旧显示 mock/demo.ts。
import { useSyncExternalStore } from 'react'
import {
  reduce,
  type EngineConfig,
  type EngineDefaults,
  type EngineId,
  type EngineInfo,
  type HostEvent,
  type NativeAction,
  type NativeActionResult,
  type NativeImportResult,
  type NativeSessionDetail,
  type NativeSessionSummary,
  type ProjectRecord,
  type AddProjectsResult,
  type ProjectFolder,
  type SessionSettings,
  type SessionSnapshot,
  type SessionSummary,
} from '@pixelsky/protocol'
import type { ImportCandidates } from '../../../../shared/types/workspace'
import type { ProjectImportBatch, ProjectImportPicker } from '../../../../shared/types/project-import'
import { addProjectsInBatches } from './projectImportBatches'
import { isDemo, projects as demoProjects } from '@/data'
import { demo } from '@/data/demo'
import { SESSION_REMOVED_EVENT } from './sessionLifecycle'
import { RETAIN_RELEASED, evictions } from './retention'
import { getMachines, machineOf } from '@/features/machines/store'

export interface EngineState {
  /** 已经从主进程拿到初始数据 */
  ready: boolean
  engines: EngineInfo[]
  /** 用户点「重新检测」的次数；目录（模型 / 输出风格）据此重新请求 */
  detectGen: number
  defaults: EngineDefaults | null
  /** 各引擎的本机配置（设置 › 本机引擎）；输入框的引擎菜单按 hidden 过滤 */
  config: EngineConfig | null
  projects: ProjectRecord[]
  sessions: SessionSummary[]
  /** 打开过的会话快照 */
  snapshots: Record<string, SessionSnapshot>
  /** 有新回复、还没看的会话 */
  unread: Record<string, true>
  /** 欢迎页（新会话）要在哪个项目里开始 */
  currentProjectId: string | null
}

let state: EngineState = {
  ready: false,
  engines: [],
  detectGen: 0,
  defaults: null,
  config: null,
  projects: [],
  sessions: [],
  snapshots: isDemo ? { ...demo().conversations.snapshots } : {},
  // 演示模式：演示数据里标了「有新回复」的会话作为初始未读，这样标记已读 / 未读和真实模式走同一套
  unread: isDemo
    ? Object.fromEntries(
        demoProjects
          .flatMap(p => [...p.sessions, ...(p.archived ?? [])])
          .filter(s => s.status === 'unread')
          .map(s => [s.id, true as const]),
      )
    : {},
  currentProjectId: null,
}
const listeners = new Set<() => void>()
/** 每个会话已应用到的事件序号 */
const seqs: Record<string, number> = {}
/** 正在打开（等快照）的会话：期间到达的事件先存起来 */
const opening: Record<string, Array<{ seq: number; event: HostEvent & { kind: 'session' } }>> = {}
/** 用户正在看的会话（它的新回复不算未读） */
// 正在显示的会话（多窗格时每个窗格一个），这些会话回复完不标「新回复」
let viewing = new Set<string>()

export const bridge = isDemo ? undefined : window.pixelsky?.engine

// 快照的释放（docs/ui/renderer-memory.md §3.4）：useSession 按引用计数，归零的会话只留最近几个
/** 各会话被几处在用 */
const refs = new Map<string, number>()
/** 引用归零的先后，最近的在后 */
let released: string[] = []
/** 打开过快照、或在标签里出现过的会话：没有快照时跑完照样标「有新回复」 */
const everOpened = new Set<string>()
/** 释放前多等一会儿，让紧跟着到的事件和引用的回落先处理完（StrictMode 双调用、快速切标签） */
const SWEEP_DELAY_MS = 3000
let sweepTimer: ReturnType<typeof setTimeout> | undefined

let pendingRaf: number | undefined
let pendingTimer: ReturnType<typeof setTimeout> | undefined

function notifyNow(): void {
  if (pendingRaf !== undefined) cancelAnimationFrame(pendingRaf)
  if (pendingTimer !== undefined) clearTimeout(pendingTimer)
  pendingRaf = pendingTimer = undefined
  for (const l of listeners) l()
}

// 状态总是立刻更新（读 getEngineState() 的人拿到的永远是最新）；notify = false 时只把通知推迟到下一帧。
// 输出很快时一帧里会来几百个增量，每个都通知会让所有订阅者和正在流式的消息重渲染几百次；
// 合并后每帧最多一次，渲染忙时 rAF 自然更晚，等于自动限流。窗口隐藏 / 最小化时 rAF 不触发，所以再挂一个定时器兜底。
function set(patch: Partial<EngineState>, notify = true): void {
  state = { ...state, ...patch }
  if (notify) {
    notifyNow()
    return
  }
  if (pendingRaf !== undefined) return
  pendingRaf = requestAnimationFrame(notifyNow)
  pendingTimer = setTimeout(notifyNow, 100)
}

// 演示模式里会动的会话（压缩上下文、当前步骤循环播放）
if (isDemo)
  demo().conversations.animate?.((id, change, patch) => {
    const snap = state.snapshots[id]
    if (snap) set({ snapshots: { ...state.snapshots, [id]: { ...snap, ...patch, items: change(snap.items) } } })
  })

/** 演示模式里改一个会话的快照（演示的消息队列、错误卡片的「重试」用）；不是演示模式时什么都不做 */
export function updateDemoSnapshot(id: string, change: (snap: SessionSnapshot) => SessionSnapshot): void {
  const snap = state.snapshots[id]
  if (isDemo && snap) set({ snapshots: { ...state.snapshots, [id]: change(snap) } })
}

export function getEngineState(): EngineState {
  return state
}

export function subscribeEngine(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useEngineState<T>(selector: (s: EngineState) => T): T {
  return useSyncExternalStore(subscribeEngine, () => selector(state))
}

/** 默认项目：最近用过的会话所在的项目，没有就用第一个 */
function pickProject(projects: ProjectRecord[], sessions: SessionSummary[], current: string | null): string | null {
  projects = projects.filter(p => machineOf(p.id) === getMachines().currentId)
  if (current && projects.some(p => p.id === current)) return current
  const recent = sessions.find(s => projects.some(p => p.id === s.record.projectId))
  return recent?.record.projectId ?? projects[0]?.id ?? null
}

function applySessionEvent(e: HostEvent & { kind: 'session' }): void {
  const id = e.sessionId
  if (opening[id]) {
    opening[id].push({ seq: e.seq, event: e })
    return
  }
  const snap = state.snapshots[id]
  if (!snap) {
    // 快照被释放（或标签启动时没挂载）的会话：事件丢掉，但跑完了照样标「有新回复」
    if (e.event.type === 'turn_completed' && everOpened.has(id) && !viewing.has(id) && !state.unread[id])
      set({ unread: { ...state.unread, [id]: true } })
    return
  }
  if (e.seq <= (seqs[id] ?? 0)) return
  seqs[id] = e.seq
  const next = reduce(snap, e.event)
  const unread =
    e.event.type === 'turn_completed' && !viewing.has(id) ? { ...state.unread, [id]: true as const } : state.unread
  // 流式增量合并通知，其余事件（开始 / 完成 / 状态 / 审批…）照旧立刻通知
  set({ snapshots: { ...state.snapshots, [id]: next }, unread }, e.event.type !== 'item_delta')
}

function onHostEvent(e: HostEvent): void {
  switch (e.kind) {
    case 'session':
      applySessionEvent(e)
      return
    case 'sessions': {
      const ids = new Set(e.sessions.map(s => s.record.id)),
        archived = new Set(
          e.sessions
            .filter(
              s => s.record.archivedAt && !state.sessions.find(old => old.record.id === s.record.id)?.record.archivedAt,
            )
            .map(s => s.record.id),
        )
      const removed = state.sessions.filter(s => !ids.has(s.record.id)).map(s => s.record.id),
        snapshots = { ...state.snapshots },
        unread = { ...state.unread }
      for (const id of removed) {
        delete snapshots[id]
        delete unread[id]
        delete seqs[id]
        // refs 不动：它数的是还挂着的组件，由 releaseSession 归零时清；这里删了，组件卸载时会算出 -1
        everOpened.delete(id)
      }
      if (removed.length) released = released.filter(id => !removed.includes(id))
      for (const id of archived) delete unread[id]
      set({
        sessions: e.sessions,
        snapshots,
        unread,
        currentProjectId: pickProject(state.projects, e.sessions, state.currentProjectId),
      })
      // 归档且没人用的直接释放，不进最近释放队列；其余的等延后的清理
      if (archived.size) drop(evictions({ ...sweepInput(), keep: Infinity }).filter(id => archived.has(id)))
      scheduleSweep()
      if (removed.length || archived.size)
        window.dispatchEvent(new CustomEvent(SESSION_REMOVED_EVENT, { detail: { ids: [...removed, ...archived] } }))
      return
    }
    case 'projects':
      set({ projects: e.projects, currentProjectId: pickProject(e.projects, state.sessions, state.currentProjectId) })
      return
    case 'engines':
      set({ engines: e.engines })
      return
    case 'native_import':
      setImportProgress(e.token, { read: e.read, total: e.total })
      return
    case 'engine_config':
      // 默认引擎、新会话默认值可能跟着变了
      set({ config: e.config })
      void refreshDefaults()
      return
  }
}

let started = false

/** 连接主进程：拉初始数据、订阅事件（只做一次） */
export function startEngineStore(): void {
  if (started) return
  started = true
  // 订阅之后、拉列表之前向主进程报到：崩溃恢复中主进程不往没准备好的页面推送（docs/ui/renderer-memory.md §3.1.2）。演示模式也报，没有 preload 就跳过
  bridge?.onEvent(onHostEvent)
  void window.pixelsky?.app?.ready().catch(() => {})
  if (!bridge) return
  void Promise.all([bridge.projects(), bridge.sessions(), bridge.defaults()]).then(([projects, sessions, defaults]) => {
    set({ ready: true, projects, sessions, defaults, currentProjectId: pickProject(projects, sessions, null) })
  })
  void bridge.engines().then(engines => set({ engines }))
  void bridge.config().then(config => set({ config }))
}

/** 确保会话快照已加载 */
export async function openSession(id: string): Promise<void> {
  if (!bridge || state.snapshots[id] || opening[id]) return
  opening[id] = []
  try {
    const { snapshot, seq } = await bridge.openSession(id)
    if (state.ready && !state.sessions.some(s => s.record.id === id)) return
    let snap = snapshot
    let last = seq
    for (const b of opening[id]) {
      if (b.seq > last) {
        snap = reduce(snap, b.event.event)
        last = b.seq
      }
    }
    seqs[id] = last
    everOpened.add(id)
    set({ snapshots: { ...state.snapshots, [id]: snap } })
    scheduleSweep()
  } catch (error) {
    if (!state.ready || state.sessions.some(s => s.record.id === id)) throw error
  } finally {
    delete opening[id]
  }
}

/** 切换正在看的会话，清掉它的「新回复」标记 */
export function setViewing(id: string | null): void {
  setViewingSet(id ? [id] : [])
}

/** 这个会话现在是否显示在某个窗格里（通知判断用，docs/ui/notifications.md） */
export const isViewingSession = (id: string): boolean => viewing.has(id)

/** 多窗格：所有窗格里正在显示的会话（docs/ui/multi-pane.md §5） */
export function setViewingSet(ids: string[]): void {
  viewing = new Set(ids)
  if (ids.some(id => state.unread[id])) {
    const rest = { ...state.unread }
    for (const id of ids) delete rest[id]
    set({ unread: rest })
  }
}

/** 手动标记会话未读 / 已读（侧栏会话右键菜单）；正在显示的会话标成未读后保持，直到视图集合变化时被清 */
export function markSessionUnread(id: string, unread: boolean): void {
  if (!!state.unread[id] === unread) return
  const next = { ...state.unread }
  if (unread) next[id] = true
  else delete next[id]
  set({ unread: next })
}

/** 重新拉取新会话默认设置（用户在别的会话里改过强度 / 权限后，新会话沿用） */
export async function refreshDefaults(): Promise<void> {
  if (!bridge) return
  const machine = getMachines().currentId,
    defaults = await bridge.defaults()
  if (getMachines().currentId === machine) set({ defaults })
}

export function setCurrentProject(id: string): void {
  set({ currentProjectId: id })
}
export async function refreshMachineEngine(machine: string): Promise<void> {
  if (!bridge) return
  const [projects, sessions, defaults, engines, config] = await Promise.all([
    bridge.projects(),
    bridge.sessions(),
    bridge.defaults(),
    bridge.engines(),
    bridge.config(),
  ])
  if (getMachines().currentId !== machine) return
  let current: string | null = null
  try {
    current = JSON.parse(localStorage.getItem('pixelsky.last-workspace.' + machine) ?? 'null')?.projectId ?? null
  } catch {}
  const allowed = projects.filter(p => machineOf(p.id) === machine)
  set({ projects, sessions, defaults, engines, config, currentProjectId: pickProject(allowed, sessions, current) })
  window.dispatchEvent(new Event('pixelsky:machine-context'))
}
export function invalidateRemoteSnapshots(machine: string): void {
  const snapshots = { ...state.snapshots }
  for (const id of Object.keys(snapshots))
    if (machineOf(id) === machine) {
      delete snapshots[id]
      delete seqs[id]
    }
  released = released.filter(id => id in snapshots)
  set({ snapshots })
}

/** 这个会话现在有人在用（useSession 挂载）；演示模式的快照是固定数据，不参与释放 */
export function retainSession(id: string): void {
  if (!bridge) return
  refs.set(id, (refs.get(id) ?? 0) + 1)
  released = released.filter(x => x !== id)
}

/** 用完了：引用归零后进最近释放队列，延后清理 */
export function releaseSession(id: string): void {
  if (!bridge) return
  const n = (refs.get(id) ?? 0) - 1
  if (n > 0) {
    refs.set(id, n)
    return
  }
  refs.delete(id)
  // 快照已经没了（会话被删）就没有要释放的，不进队列
  if (!(id in state.snapshots)) return
  released = [...released.filter(x => x !== id), id]
  scheduleSweep()
}

/** 布局里的对话标签（不论有没有挂载）：它们的会话跑完照样标「有新回复」；只加不删 */
export function noteTabSessions(ids: readonly string[]): void {
  for (const id of ids) everOpened.add(id)
}

function scheduleSweep(): void {
  if (!bridge || sweepTimer !== undefined) return
  sweepTimer = setTimeout(() => {
    sweepTimer = undefined
    sweep()
  }, SWEEP_DELAY_MS)
}

/** 释放判断要用的输入：运行中、等你处理、正在打开的不释放 */
function sweepInput(): Parameters<typeof evictions>[0] {
  const pinned = new Set(Object.keys(opening))
  for (const s of state.sessions) if (s.state !== 'idle' || s.background) pinned.add(s.record.id)
  for (const [id, snap] of Object.entries(state.snapshots))
    if (snap.state !== 'idle' || snap.pending.length > 0) pinned.add(id)
  return {
    loaded: Object.keys(state.snapshots),
    refs,
    released,
    pinned,
    archived: new Set(state.sessions.filter(s => s.record.archivedAt).map(s => s.record.id)),
    keep: RETAIN_RELEASED,
  }
}

function sweep(): void {
  drop(evictions(sweepInput()))
  released = released.filter(id => id in state.snapshots)
}

/** 从界面内存里删掉这些会话的快照和序号（再打开时从主进程重新拉） */
function drop(ids: readonly string[]): void {
  if (!ids.length) return
  const snapshots = { ...state.snapshots }
  for (const id of ids) {
    delete snapshots[id]
    delete seqs[id]
  }
  released = released.filter(id => !ids.includes(id))
  set({ snapshots })
}

/** 重新检测引擎（用户装好 / 登录之后） */
export async function redetectEngines(): Promise<void> {
  if (!bridge) return
  const engines = await bridge.engines(true)
  set({ engines, detectGen: state.detectGen + 1 })
}

/** 一次加了几个项目时广播的事件：ProjectImport 据此弹一句「已添加 3 个项目，1 个已在列表里」 */
export const PROJECTS_ADDED_EVENT = 'pixelsky:projects-added'

/** 把添加结果并进列表，切到第一个新加的（没有新加的就切到第一个已在列表里的）；返回它的 id */
function applyAdded(result: AddProjectsResult, quiet = false): string | null {
  const known = new Set(state.projects.map(p => p.id))
  const projects = [...state.projects, ...result.added.filter(p => !known.has(p.id))]
  const first = result.added[0] ?? result.existing[0]
  set(first ? { projects, currentProjectId: first.id } : { projects })
  window.dispatchEvent(
    new CustomEvent<AddProjectsResult & { quiet?: boolean }>(PROJECTS_ADDED_EVENT, { detail: { ...result, quiet } }),
  )
  return first?.id ?? null
}

/** 远程机器上的项目走工作区选择器（在机器上选目录）；返回 true 表示已经转过去了 */
function remotePicker(): boolean {
  if (getMachines().currentId === 'local') return false
  window.dispatchEvent(new Event('pixelsky:choose-workspace'))
  return true
}

/** 添加项目（选文件夹对话框里可以一次选几个）；成功后设为当前项目 */
export async function addProject(): Promise<string | null> {
  if (!bridge || remotePicker()) return null
  const result = await bridge.addProject()
  return result ? applyAdded(result) : null
}

/**
 * 按路径一次加多个本机项目（「从一个文件夹导入」、拖到侧栏的文件夹，docs/ui/multi-root-projects.md §2）。
 * 返回宿主的结果（新加的、本来就有的、加不上的），「放进一个分区」要用到项目 ID
 */
export async function addProjectPaths(
  paths: string[],
  opts: { quiet?: boolean } = {},
): Promise<AddProjectsResult | null> {
  if (!bridge || !paths.length || remotePicker()) return null
  const result = await addProjectsInBatches(paths, batch => bridge!.addProjects(batch))
  applyAdded(result, opts.quiet)
  return result
}

/** 「从一个文件夹导入…」：打开 ProjectImport 的勾选对话框（远程机器转到工作区选择器） */
export function importProjects(): void {
  if (!bridge || remotePicker()) return
  window.dispatchEvent(new Event(IMPORT_PROJECTS_EVENT))
}
export const IMPORT_PROJECTS_EVENT = 'pixelsky:import-projects'

export async function scanProjectImports(): Promise<ProjectImportBatch | null> {
  if (!bridge || remotePicker()) return null
  return bridge.scanProjectImports()
}

export async function pickProjectImports(kind: ProjectImportPicker): Promise<ProjectImportBatch | null> {
  if (!bridge || remotePicker()) return null
  return bridge.pickProjectImports(kind)
}

export async function previewProjectPaths(text: string): Promise<ProjectImportBatch | null> {
  if (!bridge || remotePicker()) return null
  return bridge.previewProjectPaths(text)
}

// ---------- 接着终端里的 Claude Code 会话（docs/ui/claude-resume.md） ----------

/** 导入大文件时读到哪里了（宿主只在文件超过 50 MB 时才推 native_import） */
export interface NativeImportProgress {
  read: number
  total: number
}
const importProgress = new Map<string, NativeImportProgress>()
const progressListeners = new Set<() => void>()
function setImportProgress(token: string, progress: NativeImportProgress | null): void {
  if (progress) importProgress.set(token, progress)
  else importProgress.delete(token)
  for (const l of progressListeners) l()
}
const subscribeProgress = (l: () => void): (() => void) => {
  progressListeners.add(l)
  return () => progressListeners.delete(l)
}

/** 某次导入（token）的进度；没有进度（文件不大，或还没开始）为 null */
export function useNativeImportProgress(token: string | null): NativeImportProgress | null {
  return useSyncExternalStore(subscribeProgress, () => (token ? (importProgress.get(token) ?? null) : null))
}

/** 第一步：这个项目里引擎自己留下的会话（只读头部，很快）。subfolders：连项目子文件夹里开的一起列（默认 true，传 false 才只列项目主目录） */
export async function listNativeSessions(
  projectId: string,
  opts: { engine?: EngineId; subfolders?: boolean } = {},
): Promise<NativeSessionSummary[]> {
  if (isDemo) return demo().conversations.nativeSessions.list(projectId, opts.engine === 'codex' ? 'codex' : 'claude')
  if (!bridge) return []
  return bridge.nativeSessions(
    projectId,
    opts.engine ?? 'claude',
    opts.subfolders === false ? { subfolders: false } : undefined,
  )
}

/** 第二步：按屏幕上的行分批补尾部信息（最后一句、标题、模型）；共用最近一次列表的读取预算 */
export async function nativeSessionDetails(
  projectId: string,
  ids: string[],
  engine: EngineId = 'claude',
): Promise<NativeSessionDetail[]> {
  if (isDemo) return demo().conversations.nativeSessions.details(ids, engine === 'codex' ? 'codex' : 'claude')
  if (!bridge || !ids.length) return []
  return bridge.nativeSessionDetails(projectId, engine, ids)
}

/**
 * 导入成一个新对话。mode 'inplace'（默认）原地接着；'copy' 复制一份接着聊（正开着时用）。
 * 结果是新对话的 sessionId、已被占用的 ownerId，或原地导入时正开着的 live。token 给 cancelNativeImport 和进度用
 */
export async function importNativeSession(
  projectId: string,
  nativeId: string,
  opts: {
    engine?: EngineId
    mode?: 'inplace' | 'copy'
    settings?: Partial<SessionSettings>
    token?: string
  } = {},
): Promise<NativeImportResult> {
  if (isDemo)
    return demo().conversations.nativeSessions.import(
      nativeId,
      opts.mode ?? 'inplace',
      opts.engine === 'codex' ? 'codex' : 'claude',
    )
  if (!bridge) throw new Error('引擎不可用')
  try {
    return await bridge.importNativeSession(projectId, opts.engine ?? 'claude', nativeId, {
      mode: opts.mode,
      settings: opts.settings,
      token: opts.token,
    })
  } finally {
    if (opts.token) setImportProgress(opts.token, null)
  }
}

/** 关掉选择框时取消还没读完的导入（不建对话） */
export async function cancelNativeImport(token: string): Promise<void> {
  setImportProgress(token, null)
  await bridge?.cancelNativeImport(token)
}

/** 对导入的对话：earlier 加载更早的、sync 补上终端里新聊的、check 只检查（有新的就在末尾加提示）、copy 改成复制一份接着聊 */
export async function nativeSessionAction(sessionId: string, kind: NativeAction): Promise<NativeActionResult> {
  if (!bridge) return { added: 0 }
  return bridge.nativeSessionAction(sessionId, kind)
}

/** 改项目的附加文件夹（整组替换，只对之后新建的对话生效）；列表随宿主的 projects 事件刷新 */
export async function setProjectFolders(id: string, folders: ProjectFolder[]): Promise<void> {
  if (!bridge) return
  await bridge.setProjectFolders(id, folders)
}

/** 选几个文件夹（只要路径）；取消时 null */
export async function pickFolders(): Promise<string[] | null> {
  return bridge ? bridge.pickFolders() : null
}

/** 选上级文件夹并列出子文件夹；取消时 null */
export async function importCandidates(): Promise<ImportCandidates | null> {
  return bridge ? bridge.importCandidates() : null
}

/** 改项目显示名；列表随宿主的 projects 事件刷新 */
export async function renameProject(id: string, name: string): Promise<void> {
  if (!bridge) return
  await bridge.renameProject(id, name)
}

/** 从列表移除项目；磁盘文件和会话记录保留 */
export async function removeProject(id: string): Promise<void> {
  if (!bridge) return
  await bridge.removeProject(id)
}
