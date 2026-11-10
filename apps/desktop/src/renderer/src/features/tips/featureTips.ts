import { useSyncExternalStore } from 'react'

// 功能提示（docs/ui/feature-tips.md）：第一次碰到某个功能时弹一次说明，看过的不再弹，入口旁的「?」常驻。
// 看过记录和总开关存本机，所有窗口共用；演示模式不弹也不写
export const TIPS_KEY = 'pixelsky.featureTips.v1'

export type TipId = 'flow' | 'subagent' | 'fast' | 'queue'

interface TipsState {
  seen: TipId[]
  off: boolean
}

const listeners = new Set<() => void>()
let fallback: TipsState = { seen: [], off: false }
let cache: { raw: string | null; state: TipsState } | null = null
/** 这一刻正在自动弹的那个：一次只弹一个，不连环弹 */
let showing: TipId | null = null

const demo = (): boolean => !!window.pixelsky?.demo

function parse(raw: string | null): TipsState {
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<TipsState>
    return { seen: Array.isArray(v.seen) ? v.seen : [], off: v.off === true }
  } catch {
    return { seen: [], off: false }
  }
}

export function readTips(): TipsState {
  try {
    if (!demo()) {
      const raw = localStorage.getItem(TIPS_KEY)
      // useSyncExternalStore 要求没变时返回同一个对象
      if (cache?.raw !== raw) cache = { raw, state: parse(raw) }
      return cache.state
    }
  } catch {
    // 存储不可用时用本窗口内的记录。
  }
  return fallback
}

function write(next: TipsState): void {
  fallback = next
  try {
    if (!demo()) localStorage.setItem(TIPS_KEY, JSON.stringify(next))
  } catch {
    // 本次仍然生效。
  }
  listeners.forEach(fn => fn())
}

export function markTipSeen(id: TipId): void {
  if (showing === id) showing = null
  const s = readTips()
  if (!s.seen.includes(id)) write({ ...s, seen: [...s.seen, id] })
}

export function setTipsOff(off: boolean): void {
  showing = null
  write({ ...readTips(), off })
}

/** 「全部重新显示」：清掉看过记录并打开总开关 */
export function resetTips(): void {
  showing = null
  write({ seen: [], off: false })
}

/** 该不该自动弹：没看过、没关、演示模式外，并且此刻没有提示在弹（同一个提示的第二个入口也不弹；拿到就占住） */
export function claimTip(id: TipId): boolean {
  const s = readTips()
  if (demo() || s.off || s.seen.includes(id)) return false
  if (showing) return false
  showing = id
  return true
}

/** 卸载时还没看完：让出位置，下次碰到再弹。只由 claimTip 拿到 true 的那个入口调用 */
export function releaseTip(id: TipId): void {
  if (showing === id) showing = null
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea === localStorage && (event.key === TIPS_KEY || event.key === null)) fn()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}

const EMPTY: TipsState = { seen: [], off: false }
export function useTips(): TipsState {
  return useSyncExternalStore(subscribe, readTips, () => EMPTY)
}
