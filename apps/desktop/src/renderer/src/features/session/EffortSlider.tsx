import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
// 推理强度滑块（参考 JuCode 桌面版）：引擎支持几档就有几个停靠点，档位名写在下面。
// 拖动时圆点跟手，松手才提交（拖过几档也只改一次）；方向键 / Home / End 也能调。样式在 globals.css 的 .effort-*
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import type { Effort, EngineId } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { EFFORT_LABEL, effortLook } from '@/features/engine'

/** 指针位置最近的停靠点 */
function stopAt(x: number, left: number, width: number, count: number): number {
  if (count <= 1 || width <= 0) return 0
  const ratio = Math.min(1, Math.max(0, (x - left) / width))
  return Math.round(ratio * (count - 1))
}

function stepStop(key: string, idx: number, count: number): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(0, idx - 1)
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(count - 1, idx + 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

export function EffortSlider({
  efforts,
  effort,
  onChange,
  disabled = false,
  engine,
  defaultEffort = null,
}: {
  efforts: readonly Effort[]
  /** 当前强度；null（引擎默认）时圆点停在第一档之前的位置 = 第一档 */
  effort: Effort | null
  onChange: (e: Effort) => void
  disabled?: boolean
  /** 哪个引擎：决定各档的颜色和特效（effortLook） */
  engine: EngineId
  /** 新会话的默认档位：在它的档位名下面写一行小字「默认」（不在档位里时不写） */
  defaultEffort?: Effort | null
}) {
  useI18n()
  const rail = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const count = efforts.length
  const idx = Math.max(0, effort ? efforts.indexOf(effort) : 0)
  const shown = drag ?? idx
  const last = Math.max(1, count - 1)
  const pct = (i: number) => (count > 1 ? (i / last) * 100 : 0)
  // 拖动时按手上这一档显示
  const { accent, top, ultra } = effortLook(efforts[shown] ?? null, efforts, engine)
  const defaultIdx = defaultEffort ? efforts.indexOf(defaultEffort) : -1

  const commit = (i: number) => {
    const e = efforts[i]
    if (!disabled && e && e !== effort) onChange(e)
  }
  const stopFor = (e: PointerEvent) => {
    const r = rail.current!.getBoundingClientRect()
    return stopAt(e.clientX, r.left, r.width, count)
  }

  return (
    <div>
      <div
        className="effort-slider"
        style={accent ? ({ '--effort-accent': accent } as CSSProperties) : undefined}
        data-tinted={accent ? true : undefined}
        data-top={top || undefined}
        data-ultra={ultra || undefined}
        data-dragging={drag !== null || undefined}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={tr('session.Composer.reasoningEffort')}
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={shown}
        aria-valuetext={EFFORT_LABEL[efforts[shown]] ?? ''}
        aria-disabled={disabled}
        onPointerDown={e => {
          if (disabled || e.button !== 0 || !rail.current) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag(stopFor(e))
        }}
        onPointerMove={e => {
          if (drag !== null) setDrag(stopFor(e))
        }}
        onPointerUp={() => {
          if (drag === null) return
          const i = drag
          setDrag(null)
          commit(i)
        }}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(e: KeyboardEvent) => {
          if (disabled) return
          const next = stepStop(e.key, idx, count)
          if (next === null) return
          e.preventDefault()
          commit(next)
        }}
      >
        <div className="effort-rail" ref={rail}>
          <div className="effort-track" />
          <div className="effort-fill" style={{ width: `calc(${pct(shown)}% + 30px)` }} />
          {efforts.map((e, i) => (
            <span
              key={e}
              className="effort-stop"
              data-passed={i <= shown || undefined}
              style={{ left: `${pct(i)}%` }}
            />
          ))}
          <span className="effort-thumb" style={{ left: `${pct(shown)}%` }} />
        </div>
      </div>
      {/* 档位名：都居中在各自停靠点的正下方（和轨道用同一套 15px 内缩坐标） */}
      <div className="relative mx-[15px] mt-1.5 h-4">
        {efforts.map((e, i) => (
          <button
            key={e}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onClick={() => commit(i)}
            className={cn(
              'absolute text-label whitespace-nowrap transition-colors duration-(--dur-base)',
              i === shown ? 'font-medium text-fg' : 'text-fg-faint hover:text-fg-muted',
              '-translate-x-1/2',
            )}
            style={{ left: `${pct(i)}%` }}
          >
            {EFFORT_LABEL[e]}
          </button>
        ))}
      </div>
      {defaultIdx >= 0 && (
        <div className="relative mx-[15px] h-3.5" data-effort-default={efforts[defaultIdx]}>
          <span
            className="absolute -translate-x-1/2 text-[10px] leading-3.5 whitespace-nowrap text-fg-faint"
            style={{ left: `${pct(defaultIdx)}%` }}
          >
            {tr('effortDefaults.marker')}
          </span>
        </div>
      )}
    </div>
  )
}
