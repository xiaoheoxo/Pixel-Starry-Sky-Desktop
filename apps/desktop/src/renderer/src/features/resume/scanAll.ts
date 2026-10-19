// 设置 › 项目「原来的 AI 会话」：手动扫描全部项目的状态（docs/ui/resume-scan-mockup.html）。
// 状态放在模块里：离开设置页再回来还看得到上次的结果；扫描本身走 hint.ts 的 scanResumeProject（结果顺带写回提示缓存）。
import { useSyncExternalStore } from 'react'
import { mapLimit, scanResumeProject, type HintEngine, type ProjectScan } from './hint'

/** 同时扫几个项目（每个项目查两个引擎，在跑的查询总数另由 hint.ts 限制） */
export const SCAN_CONCURRENCY = 4

export type ScanRowState = 'waiting' | 'scanning' | 'done' | 'remote'
export interface ScanRow {
  projectId: string
  state: ScanRowState
  result: ProjectScan | null
}
export interface ScanState {
  /** 按开始扫描时侧栏的顺序（调用方排好） */
  rows: ScanRow[]
  running: boolean
  /** 点了停止：在扫的扫完，排队的不再扫 */
  stopping: boolean
  /** 这一轮扫完（或停下）的时间；没扫过为 null */
  finishedAt: number | null
}

let state: ScanState = { rows: [], running: false, stopping: false, finishedAt: null }
const listeners = new Set<() => void>()
const set = (next: Partial<ScanState>): void => {
  state = { ...state, ...next }
  listeners.forEach(l => l())
}
const patchRow = (projectId: string, patch: Partial<ScanRow>): void =>
  set({ rows: state.rows.map(r => (r.projectId === projectId ? { ...r, ...patch } : r)) })

export const getResumeScan = (): ScanState => state

export function useResumeScan(): ScanState {
  return useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

/** 测试用 */
export function resetResumeScan(): void {
  set({ rows: [], running: false, stopping: false, finishedAt: null })
}

type Scanner = (projectId: string) => Promise<ProjectScan>

async function scanRow(projectId: string, scan: Scanner): Promise<void> {
  patchRow(projectId, { state: 'scanning' })
  const result = await scan(projectId).catch(() => ({}) as ProjectScan)
  patchRow(projectId, { state: 'done', result })
}

/**
 * 扫描全部项目：本机项目排队扫，远程项目直接标「不支持」。已经在扫时不重复开始。
 * projects 是侧栏里的项目（按侧栏顺序），isLocal 判断是不是本机项目
 */
export async function scanAllProjects(
  projects: readonly { id: string }[],
  isLocal: (projectId: string) => boolean,
  scan: Scanner = scanResumeProject,
): Promise<void> {
  if (state.running) return
  const rows: ScanRow[] = projects.map(p => ({
    projectId: p.id,
    state: isLocal(p.id) ? 'waiting' : 'remote',
    result: null,
  }))
  set({ rows, running: true, stopping: false, finishedAt: null })
  const local = rows.filter(r => r.state === 'waiting').map(r => r.projectId)
  await mapLimit(local, SCAN_CONCURRENCY, async id => {
    if (state.stopping) return
    await scanRow(id, scan)
  })
  set({ running: false, stopping: false, finishedAt: Date.now() })
}

/** 停止：在扫的扫完，排队的留在「没扫」 */
export function stopResumeScan(): void {
  if (state.running && !state.stopping) set({ stopping: true })
}

/** 只重扫一个项目（行尾的刷新按钮）；它正在扫时不重复 */
export async function rescanProject(projectId: string, scan: Scanner = scanResumeProject): Promise<void> {
  const row = state.rows.find(r => r.projectId === projectId)
  if (!row || row.state === 'scanning' || row.state === 'remote') return
  await scanRow(projectId, scan)
}

// ---------- 显示用的纯函数 ----------

/** 这个项目里能接着聊的引擎（有会话的），按 Claude Code、Codex 的顺序 */
export const rowEngines = (row: ScanRow): HintEngine[] =>
  (['claude', 'codex'] as const).filter(e => (row.result?.[e]?.count ?? 0) > 0)

/** 最近一个会话的时间（两个引擎里最晚的）；没有为 null */
export function rowLatest(row: ScanRow): number | null {
  const times = (['claude', 'codex'] as const).flatMap(e => {
    const t = row.result?.[e]?.latest
    return t ? [t] : []
  })
  return times.length ? Math.max(...times) : null
}

export interface ScanView {
  /** 要显示的行 */
  rows: ScanRow[]
  /** 已扫完的本机项目数 / 本机项目总数 */
  done: number
  total: number
  /** 有会话的项目数 */
  found: number
  /** 「只看有会话的」时藏起来的：扫过没找到的、远程的、没扫到的（停下了） */
  hiddenNone: number
  hiddenRemote: number
  hiddenSkipped: number
}

/** 按「只看有会话的」挑出要显示的行，并数出藏起来的 */
export function scanView(state: Pick<ScanState, 'rows' | 'running'>, onlyWithSessions: boolean): ScanView {
  const local = state.rows.filter(r => r.state !== 'remote')
  const done = local.filter(r => r.state === 'done').length
  const has = (r: ScanRow): boolean => r.state === 'done' && rowEngines(r).length > 0
  const found = local.filter(has).length
  if (!onlyWithSessions)
    return { rows: state.rows, done, total: local.length, found, hiddenNone: 0, hiddenRemote: 0, hiddenSkipped: 0 }
  // 扫描中的行也显示（看得到在扫哪个）；停下以后没扫到的收起来
  const shown = state.rows.filter(r => has(r) || r.state === 'scanning')
  return {
    rows: shown,
    done,
    total: local.length,
    found,
    hiddenNone: local.filter(r => r.state === 'done' && !has(r)).length,
    hiddenRemote: state.rows.filter(r => r.state === 'remote').length,
    hiddenSkipped: state.running ? 0 : local.filter(r => r.state === 'waiting').length,
  }
}
