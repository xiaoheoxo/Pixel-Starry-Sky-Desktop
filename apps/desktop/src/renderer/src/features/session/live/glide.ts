// 「回到最新」的短滑动：每帧按当前的 scrollHeight 重算终点（滑动期间内容还在长也追得上），
// 离得远先跳到离底 1.5 屏处再缓动（不平滑滚过中间那一长段，沿途内容不用排版）。
// 用户的滚轮 / 触摸 / 按键 / 点按随时中止；滚动条、轮次条等元素外的操作把位置往上挪也算中止；动画关闭时直接跳。
// 纯函数（终点、缓动一步）可单独测

import { STICK_PX } from './scrollFollow'

/** 缓动时间常数（毫秒）：剩余距离每过这么久缩到 1/e */
export const GLIDE_EASE_MS = 95
/** 离得远时先跳到离底这么多屏的地方再缓动 */
export const GLIDE_LEAD_VIEWPORTS = 1.5
/** 保险：滑动超过这么久还没结束（后台标签 rAF 被暂停、内容一直在长）就直接到底，不让 jumping 一直挂着 */
export const GLIDE_SAFETY_MS = 2000
/** 一个外部写入把位置往上挪超过这么多像素，当作用户在别处滚动（拖滚动条、轮次条、搜索跳转）而中止 */
const UP_CANCEL_PX = 1
/** 一帧最多按这么久算（标签切回来时的一大段间隔不要一步走完） */
const MAX_FRAME_MS = 64

export interface GlideBox {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** 能滚到的最底位置 */
export const glideEnd = (box: GlideBox): number => Math.max(0, box.scrollHeight - box.clientHeight)

/** 开始滑动前的起点：离底超过 1.5 屏就先跳到离底 1.5 屏处，否则从原位置开始 */
export function glideStart(box: GlideBox): number {
  const end = glideEnd(box)
  const lead = box.clientHeight * GLIDE_LEAD_VIEWPORTS
  return end - box.scrollTop > lead ? end - lead : box.scrollTop
}

/** 缓动一步：剩余距离按指数缩小，不到半个像素就吸附到终点 */
export function approach(current: number, target: number, elapsed: number, ease = GLIDE_EASE_MS): number {
  const next = current + (target - current) * (1 - Math.exp(-Math.max(0, elapsed) / ease))
  return Math.abs(target - next) < 0.5 ? target : next
}

/** done：到底了（或保险超时、内容一直在长时追到贴底范围内）；cancel：被用户操作、往上的外部滚动、再次滑动或元素卸载打断 */
export type GlideEnd = 'done' | 'cancel'

export interface GlideOptions {
  /** 动画是否开着（motionEnabled()）；关了直接跳到底 */
  motion: boolean
  /** 结束回调：正常到底、被打断、保险超时都会调用，且只调用一次 */
  onEnd?: (reason: GlideEnd) => void
  safetyMs?: number
  /** 内容一直在长时，离底不到这么多像素就算追上（交给贴底接手），默认和贴底阈值一致 */
  catchUpPx?: number
  /** 测试注入 */
  raf?: (cb: (now: number) => void) => number
  caf?: (id: number) => void
}

/** 用户自己操作的事件：任何一个都中止滑动，把滚动权还给用户 */
const USER_EVENTS = ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown'] as const

/** 滑到底；返回取消函数（已经结束再调用无效） */
export function glideToEnd(el: HTMLElement, opts: GlideOptions): () => void {
  const raf = opts.raf ?? ((cb: (now: number) => void) => requestAnimationFrame(cb))
  const caf = opts.caf ?? ((id: number) => cancelAnimationFrame(id))
  if (!opts.motion) {
    el.scrollTop = glideEnd(el)
    opts.onEnd?.('done')
    return () => {}
  }
  let finished = false
  let frame = 0
  let current: number
  let written: number
  let last = 0
  let lastEnd = glideEnd(el)
  const catchUp = opts.catchUpPx ?? STICK_PX
  const cancel = (): void => finish('cancel')
  const finish = (reason: GlideEnd): void => {
    if (finished) return
    finished = true
    if (frame) caf(frame)
    frame = 0
    clearTimeout(safety)
    for (const name of USER_EVENTS) el.removeEventListener(name, cancel)
    if (reason === 'done') el.scrollTop = glideEnd(el)
    opts.onEnd?.(reason)
  }
  const safety = setTimeout(() => finish('done'), opts.safetyMs ?? GLIDE_SAFETY_MS)
  for (const name of USER_EVENTS) el.addEventListener(name, cancel, { passive: true })

  el.scrollTop = glideStart(el)
  current = el.scrollTop
  written = current
  lastEnd = glideEnd(el)
  const step = (now: number): void => {
    frame = 0
    if (finished) return
    if (!el.isConnected) return finish('cancel')
    const elapsed = last ? Math.min(now - last, MAX_FRAME_MS) : 16
    last = now
    // 别人在滑动期间写过 scrollTop：往下 / 量高度后的修正带上，不跟它对着干；
    // 往上超过 1px 且不是内容变矮被夹到底的，当作用户在元素外滚动（拖滚动条、点轮次条、搜索跳转）：中止，位置交给他
    const moved = el.scrollTop - written
    if (moved < -UP_CANCEL_PX && el.scrollTop < glideEnd(el) - UP_CANCEL_PX) return finish('cancel')
    if (Math.abs(moved) > 1) current += moved
    const target = glideEnd(el)
    const grew = target > lastEnd
    lastEnd = target
    current = approach(current, target, elapsed)
    el.scrollTop = current
    written = el.scrollTop
    if (current === target) return finish('done')
    // 内容还在长：缓动总落后「增长速度 × 时间常数」，可能永远差一点到不了；已经进了贴底范围就收尾，让贴底接手
    if (grew && target - current < catchUp) return finish('done')
    frame = raf(step)
  }
  frame = raf(step)
  return cancel
}
