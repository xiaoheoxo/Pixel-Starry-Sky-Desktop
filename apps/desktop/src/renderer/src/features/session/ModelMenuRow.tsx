import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { getModelPosition, type ModelDetailChannel } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { tr } from '@/i18n/core'
import { MENU_ROW, highlightParts } from '@/features/model-channels/menuModel'
import { compactMenuPrice, type MenuModelPrice } from '@/features/model-channels/modelRoleGuide'

/** 紧凑两行模型菜单的第二行高度（30px 基础行 + 18px 一句话用途 = 48px） */
export const MODEL_DETAIL_LINE_PX = 18

/** 搜索命中的那一段标出来 */
export function Mark({ text, query }: { text: string; query: string }) {
  const parts = highlightParts(text, query)
  if (!parts) return <>{text}</>
  return (
    <>
      {parts[0]}
      <mark className="rounded-sm bg-warn/25 px-px text-inherit">{parts[1]}</mark>
      {parts[2]}
    </>
  )
}

/**
 * 输入框模型菜单的一行（紧凑两行，docs/ui/agnes-model-guide-plan.md §3.2）：
 * - 第 1 行：勾、模型名、定位标签、自填标记、简短补充说明；右侧是（按通道过滤后的）紧凑单价、倍率与执行者；
 * - 第 2 行：单行截断的一句话用途说明；完整说明与参考价依据放进悬停提示，不把菜单撑成 72px 三行大卡。
 */
export function ModelRow({
  title,
  modelId,
  channel,
  mono,
  desc,
  descMono,
  guide,
  position,
  price,
  customEdited,
  meta,
  chip,
  query = '',
  selected,
  active,
  off,
  offTitle,
  indent,
  onPick,
  onHover,
}: {
  title: string
  modelId?: string | null
  channel?: ModelDetailChannel
  mono?: boolean
  desc?: string
  descMono?: boolean
  guide?: { main: string; evaluator: string }
  position?: string
  price?: MenuModelPrice
  customEdited?: boolean
  meta?: ReactNode
  chip?: ReactNode
  query?: string
  selected?: boolean
  /** 键盘或鼠标停在这行 */
  active?: boolean
  /** 这个对话跑不了 / 执行者不可用：灰掉不能点 */
  off?: boolean
  offTitle?: string
  indent?: boolean
  onPick?: () => void
  onHover?: () => void
}) {
  const isFlagship = getModelPosition(modelId ?? title) === 'flagship'
  const compactPrice = channel ? compactMenuPrice(channel, price) : undefined
  const fullPriceLine = price
    ? `${tr('modelChannels.menu.priceValue', {
        currency: price.price.currency,
        input: String(price.price.input),
        output: String(price.price.output),
      })} · ${tr(`modelChannels.menu.priceBasis.${price.basis}`)}`
    : undefined
  const hoverTitle =
    [off ? offTitle : undefined, modelId && modelId !== title ? modelId : undefined, guide?.main, fullPriceLine]
      .filter(Boolean)
      .join('\n') || undefined

  return (
    <div
      data-model-row
      data-active={active || undefined}
      data-selected={selected || undefined}
      title={hoverTitle}
      onMouseEnter={onHover}
      style={{ minHeight: MENU_ROW + (guide?.main ? MODEL_DETAIL_LINE_PX : 0) }}
      className={cn(
        'group flex min-w-0 items-center gap-2 rounded-md pr-1.5',
        indent ? 'pl-6' : 'pl-1.5',
        selected ? 'bg-selected' : active && 'bg-hover',
      )}
    >
      <button
        type="button"
        data-menu-item
        disabled={off || !onPick}
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center gap-2 self-stretch py-1 text-left disabled:cursor-default"
      >
        {/* 勾放最左边一列：每行的模型名对齐 */}
        <span className="flex w-3.5 shrink-0 justify-center">
          {selected && <Check size={13} strokeWidth={2.25} className="text-accent-fg" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'min-w-0 truncate',
                mono ? 'font-mono text-meta' : 'text-ui',
                off ? 'text-fg-faint' : 'text-fg',
              )}
            >
              <Mark text={title} query={query} />
            </span>
            {position && (
              <span
                data-model-position
                className={cn(
                  'shrink-0 rounded px-1 py-px text-label font-medium',
                  isFlagship ? 'bg-accent-soft text-accent-fg' : 'bg-subtle text-fg-secondary',
                )}
              >
                {position}
              </span>
            )}
            {customEdited && (
              <span className="shrink-0 rounded bg-subtle px-1 py-px text-label text-fg-muted">
                {tr('modelDetails.editedBadge')}
              </span>
            )}
            {desc && (
              <span className={cn('min-w-0 flex-1 truncate text-label text-fg-faint', descMono && 'font-mono')}>
                <Mark text={desc} query={query} />
              </span>
            )}
          </span>
          {guide?.main && (
            <span data-model-guide className="block min-w-0 truncate text-label text-fg-muted">
              <Mark text={guide.main} query={query} />
            </span>
          )}
        </span>
      </button>
      {(compactPrice || meta || chip) && (
        <span className="flex shrink-0 items-center gap-1.5 text-label text-fg-muted tabular-nums">
          {compactPrice && (
            <span
              data-model-price
              className={cn(
                'rounded px-1.5 py-px text-label tabular-nums',
                compactPrice.custom ? 'bg-accent-soft text-accent-fg' : 'bg-subtle text-fg-muted',
              )}
            >
              {compactPrice.text}
            </span>
          )}
          {meta}
          {chip}
        </span>
      )}
    </div>
  )
}
