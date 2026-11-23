import { useLayoutEffect, useRef } from 'react'
import { motionEnabled } from '@/features/panes/motion'

/** 从个位往前对齐比较：多了一位时，没变的尾数不动 */
export function changedDigits(before: string, after: string): number[] {
  const offset = before.length - after.length
  return [...after].flatMap((digit, i) => (digit === before[i + offset] ? [] : [i]))
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
    for (const index of changedDigits(before, current)) {
      const digit = digits[index]
      // 上一次还没跳完又来新改动：只让这一位重新跳
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
      <span aria-hidden="true">
        {sign}
        <span ref={ref}>
          {[...current].map((digit, i) => (
            <span key={current.length - i} className="inline-block">
              {digit}
            </span>
          ))}
        </span>
      </span>
    </span>
  )
}

/** 改动统计，数字变了时变的那几位跳一下（运行中的改动条） */
export function BouncingDiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums">
      <BouncingCount sign="+" value={added} className="text-success" />
      <BouncingCount sign="−" value={removed} className="text-danger" />
    </span>
  )
}
