// 「审查」：从对话里的改动卡片定位到产物面板里的这一轮（docs/ui/conversation-ux.md §2.1）。
// 对话那边调用 reviewTurn，打开右侧「产物」页并登记请求；产物面板读到数据后滚过去、闪一下、展开各文件的 diff
import { useSyncExternalStore } from 'react'
import type { ArtifactDelivery, ArtifactFile, ArtifactTurn } from '@pixelsky/protocol'
import { relativePath } from '@/features/coding/ai/turnChangesModel'
import { openRightTab } from '../workspaceStore'

export interface ArtifactsFocus {
  sessionId: string
  /** 这一轮的用户消息；会话开头、第一条用户消息之前的改动为 null（和产物数据一致） */
  userItemId: string | null
  file?: { path: string; cwd: string | null }
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
  requestFocus(sessionId, userItemId, now)
}

export function reviewTurnFile(sessionId: string, userItemId: string | null, path: string, cwd: string | null): void {
  requestFocus(sessionId, userItemId, Date.now(), { path, cwd })
}

function requestFocus(sessionId: string, userItemId: string | null, at: number, file?: ArtifactsFocus['file']): void {
  current = { sessionId, userItemId, token: ++sequence, at, ...(file ? { file } : {}) }
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

export function findFocusFile(turn: ArtifactTurn, target: NonNullable<ArtifactsFocus['file']>): ArtifactFile | null {
  const root = target.cwd ?? ''
  // Remote files follow their own workspace's path syntax, not the renderer's OS.
  const insensitive = /^(?:[a-z]:[\\/]|\\\\)/i.test(root || target.path)
  const key = (path: string) => {
    const relative = relativePath(root, path, insensitive)
    return insensitive ? relative.toLowerCase() : relative
  }
  const requested = key(target.path)
  return (
    turn.files.find(file => key(file.absolute) === requested) ??
    (!root ? turn.files.find(file => key(file.path) === requested) : undefined) ??
    null
  )
}

/** 产物面板里一轮的标识（TurnBlock 的 key 也用它） */
export const turnKey = (turn: Pick<ArtifactTurn, 'sessionId' | 'userItemId' | 'at'>): string =>
  turn.sessionId + ':' + (turn.userItemId ?? 'start') + ':' + turn.at
