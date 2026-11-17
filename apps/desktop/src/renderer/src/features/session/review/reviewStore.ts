// 审查结果（docs/ui/review-pr-actions.md §2.4）：按会话存每轮的结果和每条的状态，存在本机 localStorage，
// 只留最近 SESSION_LIMIT 个会话；读写失败不影响使用。正在审、失败的原因只在内存里
import { useSyncExternalStore } from 'react'
import { isDemo } from '@/data'
import type { TurnReview } from './reviewModel'

const KEY = isDemo ? 'pixelsky.ai-review.demo.v1' : 'pixelsky.ai-review.v1'
const SESSION_LIMIT = 200

type Saved = Record<string, Record<string, TurnReview>>

let saved: Saved = {}
try {
  const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) saved = raw as Saved
} catch {
  /* 坏数据从空开始 */
}

export interface TurnReviewState {
  review: TurnReview | null
  /** 'review' 正在审，'recheck' 修完了正在复审 */
  running: 'review' | 'recheck' | null
  error: string | null
}

const running = new Map<string, 'review' | 'recheck'>()
const errors = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0
const emit = (): void => {
  version++
  listeners.forEach(l => l())
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
const key = (sessionId: string, turnKey: string): string => sessionId + '\n' + turnKey

function persist(): void {
  const ids = Object.keys(saved)
  // 只留最近的：新写的会话排在最后（删了再加）
  for (const id of ids.slice(0, Math.max(0, ids.length - SESSION_LIMIT))) delete saved[id]
  try {
    localStorage.setItem(KEY, JSON.stringify(saved))
  } catch {}
}

export const getReview = (sessionId: string, turnKey: string): TurnReview | null => saved[sessionId]?.[turnKey] ?? null

export const sessionReviews = (sessionId: string): Record<string, TurnReview> => saved[sessionId] ?? {}

export function setReview(sessionId: string, turnKey: string, review: TurnReview): void {
  const turns = { ...saved[sessionId], [turnKey]: review }
  delete saved[sessionId]
  saved = { ...saved, [sessionId]: turns }
  errors.delete(key(sessionId, turnKey))
  persist()
  emit()
}

export function updateReview(sessionId: string, turnKey: string, change: (r: TurnReview) => TurnReview): void {
  const current = getReview(sessionId, turnKey)
  if (current) setReview(sessionId, turnKey, change(current))
}

export function clearReview(sessionId: string, turnKey: string): void {
  if (!saved[sessionId]?.[turnKey] && !errors.has(key(sessionId, turnKey))) return
  const turns = { ...saved[sessionId] }
  delete turns[turnKey]
  saved = { ...saved, [sessionId]: turns }
  errors.delete(key(sessionId, turnKey))
  persist()
  emit()
}

export function setRunning(sessionId: string, turnKey: string, what: 'review' | 'recheck' | null): void {
  if (what) {
    running.set(key(sessionId, turnKey), what)
    errors.delete(key(sessionId, turnKey))
  } else running.delete(key(sessionId, turnKey))
  emit()
}

export const isRunning = (sessionId: string, turnKey: string): boolean => running.has(key(sessionId, turnKey))

export function setError(sessionId: string, turnKey: string, error: string): void {
  errors.set(key(sessionId, turnKey), error)
  emit()
}

const snap = (): number => version

export function useTurnReview(sessionId: string | null, turnKey: string): TurnReviewState {
  useSyncExternalStore(subscribe, snap, snap)
  if (!sessionId) return { review: null, running: null, error: null }
  return {
    review: getReview(sessionId, turnKey),
    running: running.get(key(sessionId, turnKey)) ?? null,
    error: errors.get(key(sessionId, turnKey)) ?? null,
  }
}

/** 这个会话的全部审查结果（复审监视用）；结果对象只在变化时换 */
export function useSessionReviews(sessionId: string | null): Record<string, TurnReview> {
  useSyncExternalStore(subscribe, snap, snap)
  return sessionId ? sessionReviews(sessionId) : {}
}
