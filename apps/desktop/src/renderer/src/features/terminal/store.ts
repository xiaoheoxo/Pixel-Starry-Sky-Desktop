import { useSyncExternalStore } from 'react'
import type {
  TerminalEvent,
  TerminalRecord,
  TerminalState,
  TerminalProfileInput,
} from '../../../../shared/types/terminal'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { isDemo, projects } from '@/data'
import { translateMessage, tr } from '@/i18n/core'
import { demo } from '@/data/demo'
import { createHistory, HISTORY_LIMIT_BYTES, type DataEvent, type TerminalHistory } from './history'
import { applyPrompt, type PromptMarks } from './marks'

interface State extends TerminalState {
  ready: boolean
  error: string | null
  /** 各终端的提示符记录（shell 集成）；只在收到 prompt 事件时换新对象 */
  marks: Record<string, PromptMarks>
}
let state: State = { profiles: [], defaultProfileId: '', terminals: [], ready: false, error: null, marks: {} }
const listeners = new Set<() => void>()
let init: Promise<void> | null = null
const sinks = new Map<string, (event: DataEvent) => void>()
const pending = new Map<string, DataEvent[]>()
/** 每个终端最近 512 KiB 的输出，视图（含代码模式底部）挂上时整段重放 */
const histories = new Map<string, TerminalHistory>()
const historyListeners = new Set<() => void>()
let historyTimer: ReturnType<typeof setTimeout> | null = null
function notifyHistory(): void {
  if (historyTimer) return
  historyTimer = setTimeout(() => {
    historyTimer = null
    historyListeners.forEach(fn => fn())
  }, 500)
}
function recordHistory(value: DataEvent): void {
  let history = histories.get(value.terminalId)
  if (!history) histories.set(value.terminalId, (history = createHistory(HISTORY_LIMIT_BYTES)))
  history.push(value)
  notifyHistory()
}
function set(patch: Partial<State>): void {
  state = { ...state, ...patch }
  listeners.forEach(fn => fn())
}
export function terminalError(cause: unknown): void {
  set({ error: cause === null ? null : translateMessage(cause instanceof Error ? cause.message : String(cause)) })
}
export function applyTerminalRecord(record: TerminalRecord): void {
  const previous = state.terminals.find(r => r.id === record.id)
  if (previous && record.generation < previous.generation) return
  set({
    terminals: previous ? state.terminals.map(r => (r.id === record.id ? record : r)) : [...state.terminals, record],
  })
}
/** 等 shell 第一次输出（提示符）后再写入的命令（docs/ui/files-search-terminal-pins.md §4.3） */
const readyWaiters = new Map<string, () => void>()
const seenOutput = new Set<string>()
function event(value: TerminalEvent): void {
  if (value.type === 'record') {
    applyTerminalRecord(value.record)
    return
  }
  if (value.type === 'profiles') {
    // 启动时的 Shell 检测在后台做，完成后推一次；重新取一次（SSH 机器的列表也在 state 里合并）
    void refreshTerminals().catch(terminalError)
    return
  }
  if (value.type === 'prompt') {
    const next = applyPrompt(state.marks[value.terminalId], value)
    if (next && next !== state.marks[value.terminalId]) set({ marks: { ...state.marks, [value.terminalId]: next } })
    return
  }
  seenOutput.add(value.terminalId)
  const waiter = readyWaiters.get(value.terminalId)
  if (waiter) {
    readyWaiters.delete(value.terminalId)
    waiter()
  }
  recordHistory(value)
  const sink = sinks.get(value.terminalId)
  if (sink) sink(value)
  else {
    const queue = pending.get(value.terminalId) ?? []
    queue.push(value)
    pending.set(value.terminalId, queue)
    // The host stops producing after 256 KiB until a view consumes and acknowledges it.
  }
}
export function initTerminalStore(): Promise<void> {
  return (init ??= (async () => {
    if (isDemo) {
      set({ profiles: demo().terminal.profiles, defaultProfileId: demo().terminal.profiles[0].id, ready: true })
      return
    }
    window.pixelsky?.terminal.onEvent(event)
    try {
      if (window.pixelsky) set({ ...(await window.pixelsky.terminal.state()), ready: true })
    } catch (cause) {
      set({ ready: true })
      terminalError(cause)
    }
  })())
}
export function useTerminalStore(): State {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => state,
  )
}
export function terminalState(): State {
  return state
}
export function consumeTerminal(id: string, sink: (e: DataEvent) => void): () => void {
  sinks.set(id, sink)
  // pending 里的数据在到达时已经写进历史，所以只重放历史；视图按 seq 去重，重复 ack 是安全的
  pending.delete(id)
  histories.get(id)?.events().slice().forEach(sink)
  return () => {
    if (sinks.get(id) === sink) sinks.delete(id)
  }
}
export async function refreshTerminals(force = false): Promise<void> {
  if (!isDemo) set(await window.pixelsky!.terminal.state(force))
}
export async function terminalSetDefault(id: string): Promise<void> {
  if (isDemo) set({ defaultProfileId: id })
  else set(await window.pixelsky!.terminal.setDefaultProfile(id))
}
export async function terminalProfile(input: TerminalProfileInput): Promise<void> {
  if (isDemo) {
    const profile = { ...input, id: input.id ?? 'custom-' + crypto.randomUUID(), custom: true, available: true }
    set({ profiles: [...state.profiles.filter(p => p.id !== profile.id), profile] })
    return
  }
  set(await window.pixelsky!.terminal.saveProfile(input))
}
export async function removeTerminalProfile(id?: string): Promise<void> {
  if (isDemo) {
    set({
      profiles: id ? state.profiles.filter(p => p.id !== id) : demo().terminal.profiles,
      defaultProfileId: demo().terminal.profiles[0].id,
    })
    return
  }
  set(id ? await window.pixelsky!.terminal.removeProfile(id) : await window.pixelsky!.terminal.resetProfiles())
}
export async function terminalCreate(ref: WorkspaceRef, profileId?: string): Promise<TerminalRecord> {
  await initTerminalStore()
  if (isDemo) {
    if (state.terminals.length >= 12) throw new Error(tr('terminal.limit'))
    const profile = state.profiles.find(p => p.id === (profileId ?? state.defaultProfileId))!
    const project =
      projects.find(p => p.id === ref.projectId || p.sessions.some(s => s.id === ref.sessionId)) ?? projects[0]
    const record: TerminalRecord = {
      id: crypto.randomUUID(),
      projectId: project.id,
      projectName: project.name,
      cwd: project.name,
      profileId: profile.id,
      profileLabel: profile.label,
      title: profile.label,
      titleEdited: false,
      status: 'running',
      generation: 1,
      createdAt: Date.now(),
    }
    applyTerminalRecord(record)
    event({ type: 'data', terminalId: record.id, generation: 1, seq: 1, data: demo().terminal.output })
    return record
  }
  const record = await window.pixelsky!.terminal.create(ref, profileId, crypto.randomUUID())
  applyTerminalRecord(record)
  return record
}
export async function terminalRename(id: string, title: string): Promise<void> {
  const record = state.terminals.find(r => r.id === id)
  if (!record) throw new Error(tr('terminal.missing'))
  if (isDemo) applyTerminalRecord({ ...record, title, titleEdited: true })
  else applyTerminalRecord(await window.pixelsky!.terminal.rename(id, title))
}
export async function terminalClose(id: string, force = false): Promise<void> {
  if (!isDemo) await window.pixelsky!.terminal.close(id, force)
  pending.delete(id)
  histories.delete(id)
  notifyHistory()
  seenOutput.delete(id)
  readyWaiters.delete(id)
  const marks = { ...state.marks }
  delete marks[id]
  set({ terminals: state.terminals.filter(r => r.id !== id), marks })
}
export async function terminalRestart(id: string, force = false): Promise<void> {
  const record = state.terminals.find(r => r.id === id)
  if (!record) throw new Error(tr('terminal.missing'))
  if (isDemo) {
    applyTerminalRecord({ ...record, generation: record.generation + 1, status: 'running', exitCode: undefined })
    event({ type: 'data', terminalId: id, generation: record.generation + 1, seq: 1, data: demo().terminal.output })
  } else {
    // 新的 shell 还没出过输出：terminalRunWhenReady 要等它的提示符，不能用上一轮的记录
    seenOutput.delete(id)
    applyTerminalRecord(await window.pixelsky!.terminal.restart(id, force))
  }
}
/**
 * 新建的终端出现第一段输出（shell 就绪）后写入一条命令；最多等 4 秒。
 * 只在用户点击时调用，命令不进任何保存的记录（D051：不自动重跑命令）。
 * onSent：命令写进终端之后调用（任务面板在这里记下「从这一刻起的提示符才算命令结束」）。
 */
export function terminalRunWhenReady(id: string, command: string, onSent?: () => void): void {
  if (isDemo) {
    demoWrite(id, '\r\n$ ' + command + '\r\n')
    return
  }
  let sent = false
  const send = (): void => {
    if (sent) return
    sent = true
    readyWaiters.delete(id)
    const record = state.terminals.find(r => r.id === id)
    if (record && (record.status === 'running' || record.status === 'starting'))
      void window
        .pixelsky!.terminal.write(id, record.generation, command + '\r')
        .then(() => onSent?.())
        .catch(terminalError)
  }
  // 稍等一下让提示符画完，避免命令和提示符交错
  const soon = (): void => void setTimeout(send, 150)
  if (seenOutput.has(id)) soon()
  else readyWaiters.set(id, soon)
  setTimeout(send, 4000)
}
export function demoWrite(id: string, data: string): void {
  const record = state.terminals.find(r => r.id === id)
  if (record) event({ type: 'data', terminalId: id, generation: record.generation, seq: Date.now(), data })
}

/** 终端的滚动历史文本（已去掉 ANSI），给「AI 命令」「输出」等只读视图用 */
export function terminalHistoryText(id: string): string {
  return histories.get(id)?.text() ?? ''
}
/** 历史变化时通知（节流 500ms）；返回退订函数 */
export function subscribeTerminalHistory(fn: () => void): () => void {
  historyListeners.add(fn)
  return () => {
    historyListeners.delete(fn)
  }
}
