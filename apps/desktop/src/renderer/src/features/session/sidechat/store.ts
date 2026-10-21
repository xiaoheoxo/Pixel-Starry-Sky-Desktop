// 旁聊（docs/ui/rewind-fork-sidechat.md §3）：每个会话一串问答，只在内存里；问的时候带上前面已经答完的几问
import { useSyncExternalStore } from 'react'
import type { SideTurn } from '@pixelsky/protocol'
import { tr, translateMessage } from '@/i18n/core'
import { SESSION_REMOVED_EVENT } from '@/features/engine/sessionLifecycle'

export interface SideEntry {
  id: string
  question: string
  answer: string | null
  error: string | null
  pending: boolean
}

/** 真正去问的函数：桌面版走引擎，演示模式用演示数据 */
export type SideAsk = (sessionId: string, question: string, history: SideTurn[]) => Promise<string>
export type SideCancel = (sessionId: string) => Promise<void> | void

let chats: Record<string, SideEntry[]> = {}
const listeners = new Set<() => void>()
const EMPTY: SideEntry[] = []

// 会话删掉、归档了：旁聊也丢掉（只在内存里，原来只增不删，docs/perf-audit-2026-10-18.md D7）；正在答的留着
if (typeof window !== 'undefined')
  window.addEventListener(SESSION_REMOVED_EVENT, event => {
    const ids = (event as CustomEvent<{ ids?: string[] }>).detail?.ids ?? []
    const gone = ids.filter(id => chats[id] && !chats[id].some(e => e.pending))
    if (!gone.length) return
    chats = { ...chats }
    for (const id of gone) delete chats[id]
    listeners.forEach(l => l())
  })

function set(sessionId: string, entries: SideEntry[]): void {
  chats = { ...chats, [sessionId]: entries }
  listeners.forEach(l => l())
}

function patch(sessionId: string, id: string, change: Partial<SideEntry>): void {
  const entries = chats[sessionId]
  if (!entries?.some(e => e.id === id)) return
  set(
    sessionId,
    entries.map(e => (e.id === id ? { ...e, ...change } : e)),
  )
}

export function sideEntries(sessionId: string): SideEntry[] {
  return chats[sessionId] ?? EMPTY
}

export function useSideChat(sessionId: string): SideEntry[] {
  return useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => sideEntries(sessionId),
  )
}

/** 现在不能问的原因（还没发过消息、上一个问题还在答）；null 表示可以。输入框的 /btw 先看这个再清空 */
export function sideRefusal(sessionId: string, disabledReason: string | null): string | null {
  if (disabledReason) return disabledReason
  return sideEntries(sessionId).some(e => e.pending) ? tr('side.busy') : null
}

/** 问一个问题；同一时间只有一个在答 */
export async function askSide(sessionId: string, question: string, ask: SideAsk): Promise<void> {
  const text = question.trim()
  const entries = sideEntries(sessionId)
  if (!text || entries.some(e => e.pending)) return
  const history = entries.flatMap(e => (e.answer !== null ? [{ question: e.question, answer: e.answer }] : []))
  const id = crypto.randomUUID()
  set(sessionId, [...entries, { id, question: text, answer: null, error: null, pending: true }])
  try {
    const answer = await ask(sessionId, text, history)
    patch(sessionId, id, { answer, pending: false })
  } catch (err) {
    patch(sessionId, id, { error: translateMessage((err as Error).message), pending: false })
  }
}

export function stopSide(sessionId: string, cancel: SideCancel): void {
  const pending = sideEntries(sessionId).find(e => e.pending)
  if (!pending) return
  void cancel(sessionId)
}

export function clearSide(sessionId: string, cancel: SideCancel): void {
  stopSide(sessionId, cancel)
  set(sessionId, [])
}
