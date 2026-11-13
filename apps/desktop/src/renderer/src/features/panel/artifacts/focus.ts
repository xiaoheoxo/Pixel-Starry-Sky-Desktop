// 「审查」：从对话里的改动卡片定位到产物面板里的这一轮（docs/ui/conversation-ux.md §2.1）。
// 对话那边调用 reviewTurn，打开右侧「产物」页并登记请求；产物面板读到数据后滚过去、闪一下、展开各文件的 diff
import { useSyncExternalStore } from 'react'
import type { ArtifactDelivery, ArtifactTurn } from '@pixelsky/protocol'
import { openRightTab } from '../workspaceStore'

export interface ArtifactsFocus {
  sessionId: string
  /** 这一轮的用户消息；会话开头、第一条用户消息之前的改动为 null（和产物数据一致） */
  userItemId: string | null
  token: number
  at: number
}

/** 请求多久以内还算数：面板可能稍后才挂载、数据稍后才到，但很久以后打开产物页时不该再跳 */
export const FOCUS_MS = 10_000

/** 展开 diff 的文件数上限：再多就保持折叠，免得一次读太多 */
export const FOCUS_OPEN_MAX = 8

let current: ArtifactsFocus | null = null
let sequence = 0
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(l => l())
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function reviewTurn(sessionId: string, userItemId: string | null, now = Date.now()): void {
  current = { sessionId, userItemId, token: ++sequence, at: now }
  emit()
  openRightTab('artifacts')
}

export function finishArtifactsFocus(token: number): void {
  if (current?.token !== token) return
  current = null
  emit()
}

export function useArtifactsFocus(): ArtifactsFocus | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}

export const freshFocus = <T extends { at: number }>(focus: T | null, now = Date.now()): focus is T =>
  !!focus && now - focus.at < FOCUS_MS

/** 概况「产出」点了一个交付文件：打开产物页，产物面板读到后直接预览它 */
export interface PreviewRequest {
  item: ArtifactDelivery
  token: number
  at: number
}

let previewRequest: PreviewRequest | null = null

export function previewDelivery(item: ArtifactDelivery, now = Date.now()): void {
  previewRequest = { item, token: ++sequence, at: now }
  emit()
  openRightTab('artifacts')
}

export function finishPreviewRequest(token: number): void {
  if (previewRequest?.token !== token) return
  previewRequest = null
  emit()
}

export function usePreviewRequest(): PreviewRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => previewRequest,
    () => null,
  )
}

/** 产物数据里的这一轮 */
export function findFocusTurn(
  turns: readonly ArtifactTurn[],
  focus: Pick<ArtifactsFocus, 'sessionId' | 'userItemId'>,
): ArtifactTurn | null {
  return turns.find(t => t.sessionId === focus.sessionId && t.userItemId === focus.userItemId) ?? null
}

/** 产物面板里一轮的标识（TurnBlock 的 key 也用它） */
export const turnKey = (turn: Pick<ArtifactTurn, 'sessionId' | 'userItemId' | 'at'>): string =>
  turn.sessionId + ':' + (turn.userItemId ?? 'start') + ':' + turn.at
