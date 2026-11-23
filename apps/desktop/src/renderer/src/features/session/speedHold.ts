// 点一下开关 Fast，按住 0.6 秒升到 Ultrafast（docs/codex-engine.md §3.5）：中途松手或移开就取消；开着 Ultrafast 时点一下关掉
import { useEffect, useRef, useState, type HTMLAttributes, type MouseEvent, type PointerEvent } from 'react'

export type Speed = 'off' | 'fast' | 'ultrafast'

const HOLD_MS = 600
/** 短于这个算点一下，之后才开始显示进度（globals.css 的 speed-fill 时长是两者之差） */
const CLICK_MS = 300
/** 起飞动画的时长，和 globals.css 的 speed-launch 一致 */
const LAUNCH_MS = 620
/** 「要按满」的提示留多久：不能一直盖着说明和「下一轮生效」 */
const HINT_MS = 3000
/** 移出按钮多远算放弃（手抖不算） */
const SLOP = 8

export interface SpeedHold {
  holding: boolean
  /** 没按满就放手了，提示还没过 */
  tooShort: boolean
  launching: boolean
  clearHint: () => void
  handlers: HTMLAttributes<HTMLButtonElement>
}

export function useSpeedHold(speed: Speed, onChange: (speed: Speed) => void): SpeedHold {
  const [holding, setHolding] = useState(false)
  const [tooShort, setTooShort] = useState(false)
  const [launching, setLaunching] = useState(false)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const launchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startedAt = useRef(0)
  const keyDown = useRef(false)
  // 这次按下已经有结果（按满或取消），松手后跟来的 click 不再算点一下
  const handled = useRef(false)

  const stop = (): void => {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current)
    if (showTimer.current !== null) clearTimeout(showTimer.current)
    holdTimer.current = showTimer.current = null
    setHolding(false)
  }
  const pick = (next: Speed): void => {
    setTooShort(false)
    onChange(next)
  }
  const toggle = (): void => pick(speed === 'off' ? 'fast' : 'off')
  const begin = (): void => {
    startedAt.current = performance.now()
    handled.current = false
    setTooShort(false)
    if (speed === 'ultrafast') return
    showTimer.current = setTimeout(() => setHolding(true), CLICK_MS)
    holdTimer.current = setTimeout(() => {
      stop()
      handled.current = true
      setLaunching(true)
      launchTimer.current = setTimeout(() => setLaunching(false), LAUNCH_MS)
      pick('ultrafast')
    }, HOLD_MS)
  }
  /** 按着的时候放弃：什么都不改，说一声要按满 */
  const abort = (): void => {
    handled.current = true
    if (holdTimer.current === null) return
    stop()
    setTooShort(true)
  }
  /** 松手：够快是点一下（返回 true），否则算没按满 */
  const release = (): boolean => {
    if (holdTimer.current === null) return !handled.current
    if (performance.now() - startedAt.current >= CLICK_MS) {
      abort()
      return false
    }
    stop()
    return true
  }
  // 菜单在按住时关掉不算按满；切走窗口收不到松手事件，当作放弃
  useEffect(
    () => () => {
      if (holdTimer.current !== null) clearTimeout(holdTimer.current)
      if (showTimer.current !== null) clearTimeout(showTimer.current)
      if (launchTimer.current !== null) clearTimeout(launchTimer.current)
    },
    [],
  )
  useEffect(() => {
    if (!tooShort) return
    const timer = setTimeout(() => setTooShort(false), HINT_MS)
    return () => clearTimeout(timer)
  }, [tooShort])
  useEffect(() => {
    if (!holding) return
    window.addEventListener('blur', abort)
    return () => window.removeEventListener('blur', abort)
  })

  const handlers: HTMLAttributes<HTMLButtonElement> = {
    // 读屏软件激活只发一次点击，按不住：依次走 普通 → Fast → Ultrafast → 普通，名字和状态都会读出来
    onClick: (e: MouseEvent) => {
      if (handled.current) {
        handled.current = false
        return
      }
      if (e.detail === 0) pick(speed === 'off' ? 'fast' : speed === 'fast' ? 'ultrafast' : 'off')
      else toggle()
    },
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      begin()
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      const r = e.currentTarget.getBoundingClientRect()
      if (
        e.buttons !== 0 &&
        (e.clientX < r.left - SLOP ||
          e.clientX > r.right + SLOP ||
          e.clientY < r.top - SLOP ||
          e.clientY > r.bottom + SLOP)
      )
        abort()
    },
    onPointerUp: () => void release(),
    onPointerCancel: abort,
    onLostPointerCapture: () => holdTimer.current !== null && abort(),
    onBlur: () => holdTimer.current !== null && abort(),
    onKeyDown: e => {
      if (e.key !== ' ' && e.key !== 'Enter') return
      e.preventDefault()
      if (e.repeat) return
      keyDown.current = true
      begin()
    },
    onKeyUp: e => {
      if ((e.key !== ' ' && e.key !== 'Enter') || !keyDown.current) return
      keyDown.current = false
      if (release()) toggle()
      handled.current = false
    },
  }
  return { holding, tooShort, launching, clearHint: () => setTooShort(false), handlers }
}
