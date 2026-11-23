import { useLayoutEffect, useRef } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { motionEnabled } from '@/features/panes/motion'
import { cn } from './cn'

/** Match digits right to left, so adding a place does not animate unchanged suffixes. */
export function changedDiffDigits(before: string, after: string): number[] {
  const offset = before.length - after.length
  return [...after].flatMap((digit, index) => (digit === before[index + offset] ? [] : [index]))
}

function BouncingCount({ sign, value, className }: { sign: string; value: number; className: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const current = String(value)
  const previous = useRef(current)
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = current
    const digits = ref.current?.children
    if (!digits || before === current || !motionEnabled()) return
    for (const index of changedDiffDigits(before, current)) {
      const digit = digits[index + 1] // The first child is the fixed sign.
      if (!digit?.animate) continue
      // A new edit can arrive before the prior bounce settles. Restart only this digit.
      for (const animation of digit.getAnimations()) animation.cancel()
      digit.animate(
        [
          { transform: 'translateY(0)' },
          { transform: 'translateY(-0.24em) scale(1.08)', offset: 0.42 },
          { transform: 'translateY(0.04em)', offset: 0.78 },
          { transform: 'translateY(0)' },
        ],
        { duration: 230, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
      )
    }
  }, [current])
  return (
    <span className={className}>
      <span className="sr-only">{sign + current}</span>
      <span ref={ref} aria-hidden="true">
        <span>{sign}</span>
        {[...current].map((digit, index) => (
          <span key={current.length - index - 1} className="inline-block">
            {digit}
          </span>
        ))}
      </span>
    </span>
  )
}

/** 改动统计：绿色 +N、红色 −N。实时变更条可选择逐位跳动。 */
export function DiffStat({
  added,
  removed,
  className,
  animate = false,
}: {
  added: number
  removed: number
  className?: string
  animate?: boolean
}) {
  useI18n()
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 tabular-nums', className)}>
      {animate ? (
        <>
          <BouncingCount sign="+" value={added} className="text-success" />
          <BouncingCount sign="−" value={removed} className="text-danger" />
        </>
      ) : (
        <>
          <span className="text-success">+{added}</span>
          <span className="text-danger">−{removed}</span>
        </>
      )}
    </span>
  )
}
