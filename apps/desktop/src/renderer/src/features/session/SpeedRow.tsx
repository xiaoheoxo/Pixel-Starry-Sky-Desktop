import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
// 官方登录能开 Ultrafast 时，Fast 开关换成这一行（docs/codex-engine.md §3.5）：
// 普通、Fast 点一下；Ultrafast 按 8 倍扣，要按住 0.6 秒才开，提前松手或移开就取消
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Clock, Rocket, Zap } from 'lucide-react'
import { cn } from '@/ui'

export type Speed = 'off' | 'fast' | 'ultrafast'

const HOLD_MS = 600
/** 起飞动画的时长，和 globals.css 的 speed-launch 一致 */
const LAUNCH_MS = 620
/** 移出按钮多远算放弃（手抖不算） */
const SLOP = 8

const segment = (selected: boolean): string =>
  cn(
    'relative flex h-8 min-w-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border text-ui whitespace-nowrap select-none',
    selected
      ? 'border-line bg-surface font-medium text-fg shadow-sm'
      : 'border-transparent text-fg-muted hover:text-fg',
  )

export function SpeedRow({
  speed,
  pending,
  onChange,
}: {
  speed: Speed
  /** 这一轮跑着时改了，下一轮才生效 */
  pending: boolean
  onChange: (speed: Speed) => void
}) {
  useI18n()
  const [holding, setHolding] = useState(false)
  const [tooShort, setTooShort] = useState(false)
  const [launching, setLaunching] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const launchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopTimer = (): boolean => {
    const was = timer.current !== null
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    return was
  }
  const start = (): void => {
    if (speed === 'ultrafast' || timer.current !== null) return
    setTooShort(false)
    setHolding(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setHolding(false)
      setLaunching(true)
      launchTimer.current = setTimeout(() => setLaunching(false), LAUNCH_MS)
      onChange('ultrafast')
    }, HOLD_MS)
  }
  const cancel = (): void => {
    if (!stopTimer()) return
    setHolding(false)
    setTooShort(true)
  }
  // 菜单在按住时关掉不算按满；切走窗口收不到松手事件，当作取消
  useEffect(
    () => () => {
      stopTimer()
      if (launchTimer.current !== null) clearTimeout(launchTimer.current)
    },
    [],
  )
  useEffect(() => {
    if (!holding) return
    window.addEventListener('blur', cancel)
    return () => window.removeEventListener('blur', cancel)
  })

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>): void => {
    if (timer.current === null) return
    const r = e.currentTarget.getBoundingClientRect()
    if (
      e.clientX < r.left - SLOP ||
      e.clientX > r.right + SLOP ||
      e.clientY < r.top - SLOP ||
      e.clientY > r.bottom + SLOP
    )
      cancel()
  }
  const pick = (next: Speed): void => {
    setTooShort(false)
    onChange(next)
  }

  const speedName = (s: Speed): string => (s === 'off' ? tr('speed.off') : s === 'fast' ? 'Fast' : 'Ultrafast')
  const hint: ReactNode = holding
    ? tr('speed.holding')
    : tooShort
      ? tr('speed.tooShort')
      : pending
        ? tr('speed.next', { p0: speedName(speed) })
        : speed === 'ultrafast'
          ? tr('speed.ultrafastDesc')
          : `${tr(speed === 'fast' ? 'speed.fastDesc' : 'speed.offDesc')}${tr('speed.holdHint')}`
  const on = speed !== 'off'
  const Icon = speed === 'ultrafast' ? Rocket : Zap

  return (
    <div className="py-2">
      <span className="flex items-center gap-1.5 text-ui text-fg">
        <Icon size={14} strokeWidth={1.75} className={pending ? 'text-warn' : on ? 'text-accent' : 'text-fg-muted'} />
        {tr('speed.title')}
        {pending && (
          <span className="rounded-sm bg-subtle px-1.5 text-label leading-5 whitespace-nowrap text-fg-muted">
            {tr('codex.fastPending')}
          </span>
        )}
      </span>
      <div
        role="radiogroup"
        aria-label={tr('speed.title')}
        className="mt-1.5 grid grid-cols-[1fr_1fr_1.35fr] rounded-lg bg-subtle p-0.5"
      >
        <button
          type="button"
          role="radio"
          aria-checked={speed === 'off'}
          className={segment(speed === 'off')}
          onClick={() => pick('off')}
        >
          {tr('speed.off')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={speed === 'fast'}
          className={segment(speed === 'fast')}
          onClick={() => pick('fast')}
        >
          <Zap size={13} strokeWidth={1.75} className="shrink-0" />
          Fast
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={speed === 'ultrafast'}
          aria-label={tr('speed.holdLabel')}
          data-speed-ultrafast
          className={cn(
            segment(speed === 'ultrafast'),
            'touch-none',
            holding && 'text-fg',
            launching && 'speed-launch',
          )}
          // 读屏软件激活控件只发一次点击（没有指针和按键），按不住：这时已经读过「按住开启」和扣费，直接开
          onClick={e => {
            if (e.detail === 0 && speed !== 'ultrafast') pick('ultrafast')
          }}
          onPointerDown={e => {
            if (e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
            start()
          }}
          onPointerMove={onPointerMove}
          onPointerUp={cancel}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
          onKeyDown={e => {
            if (e.key !== ' ' && e.key !== 'Enter') return
            e.preventDefault()
            if (!e.repeat) start()
          }}
          onKeyUp={e => {
            if (e.key === ' ' || e.key === 'Enter') cancel()
          }}
        >
          {holding && <span className="speed-fill" data-speed-fill aria-hidden />}
          <span className="relative z-10 flex items-center gap-1.5">
            <span className="relative flex">
              <span className="speed-trail" aria-hidden />
              <Rocket size={13} strokeWidth={1.75} className="speed-rocket shrink-0" />
            </span>
            Ultrafast
          </span>
        </button>
      </div>
      <span
        data-speed-hint
        className={cn(
          'mt-1.5 flex items-start gap-1 text-meta',
          holding ? 'font-medium text-warn-fg' : pending ? 'text-fg-secondary' : 'text-fg-muted',
        )}
      >
        {pending && !holding && !tooShort && (
          <Clock size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warn" />
        )}
        {hint}
      </span>
    </div>
  )
}
