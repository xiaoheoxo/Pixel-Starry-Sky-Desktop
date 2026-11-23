import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { ModelEvidence, ModelIq } from '@pixelsky/protocol'
import { cn } from '@/ui/cn'
import { tr } from '@/i18n/core'
import type { modelRoleGuide, MenuModelPrice } from '@/features/model-channels/modelRoleGuide'
import { highlightParts, MENU_ROW } from '@/features/model-channels/menuModel'

/** 搜索命中的那一段标出来 */
function Mark({ text, query }: { text: string; query: string }) {
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

export const MODEL_DETAIL_LINE_PX = 14

/** 勾、模型名、来源和可选的用途说明，右侧保留倍率和执行者。 */
export function ModelRow({
  title,
  mono,
  desc,
  descMono,
  position,
  iq,
  price,
  evidence,
  referenceOnly,
  guide,
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
  mono?: boolean
  desc?: string
  descMono?: boolean
  position?: string
  iq?: ModelIq
  price?: MenuModelPrice
  evidence?: ModelEvidence
  referenceOnly?: boolean
  guide?: ReturnType<typeof modelRoleGuide>
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
  const referenceNotice = referenceOnly && tr('modelChannels.menu.relayBenchmarkHint')
  const benchmark = [
    evidence?.arc2Xhigh !== undefined &&
      tr('modelChannels.menu.arcBenchmark', { score: evidence.arc2Xhigh, weight: iq?.arcWeight ?? 0 }),
    evidence?.terminal41 &&
      tr('modelChannels.menu.terminalBenchmark', {
        score: evidence.terminal41.score,
        effort: evidence.terminal41.effort,
      }),
  ]
    .filter(Boolean)
    .join(' ')
  const priceValue =
    price &&
    tr('modelChannels.menu.priceValue', {
      currency: price.price.currency,
      input: price.price.input,
      output: price.price.output,
    })
  const priceDescription = price && tr(`modelChannels.menu.priceBasis.${price.basis}`)
  return (
    <div
      data-model-row
      data-active={active || undefined}
      data-selected={selected || undefined}
      title={
        [
          off && offTitle,
          guide?.main,
          guide?.evaluator && `${tr('subagentRoute.advisor.evaluator')}: ${guide.evaluator}`,
          benchmark,
          benchmark && referenceNotice,
        ]
          .filter(Boolean)
          .join(' ') || undefined
      }
      onMouseEnter={onHover}
      style={{ minHeight: MENU_ROW + (Number(!!guide?.main) + Number(!!priceValue)) * MODEL_DETAIL_LINE_PX }}
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
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0 whitespace-normal">
            <span
              className={cn(
                'min-w-0 max-w-full [overflow-wrap:anywhere]',
                mono ? 'font-mono text-meta' : 'text-ui',
                off ? 'text-fg-faint' : 'text-fg',
              )}
            >
              <Mark text={title} query={query} />
            </span>
            {position && (
              <span className="shrink-0 rounded bg-subtle px-1 text-label font-medium text-fg-secondary">
                {position}
              </span>
            )}
            {iq && (
              <span
                data-model-iq
                title={[
                  tr('modelChannels.menu.iqHint', {
                    score: iq.score,
                    effort: iq.effort,
                    n: iq.cohortSize,
                    radar: iq.radarScore,
                    analysis: iq.analysisScore,
                    radarWeight: iq.radarWeight,
                    analysisWeight: iq.analysisWeight,
                    disagreement: iq.disagreement,
                  }),
                  benchmark,
                  referenceNotice,
                ]
                  .filter(Boolean)
                  .join(' ')}
                className="shrink-0 rounded bg-subtle px-1 text-label font-medium text-fg-secondary tabular-nums"
              >
                {referenceOnly ? tr('modelChannels.menu.iqReference', { score: iq.score }) : `IQ ${iq.score}`}
              </span>
            )}
            {!iq && benchmark && (
              <span
                title={[benchmark, referenceNotice].filter(Boolean).join(' ')}
                className="shrink-0 rounded bg-subtle px-1 text-label text-fg-muted"
              >
                {tr('modelChannels.menu.benchmark')}
              </span>
            )}
            {desc && (
              <span
                className={cn(
                  'min-w-0 max-w-full text-label text-fg-faint [overflow-wrap:anywhere]',
                  descMono && 'font-mono',
                )}
              >
                <Mark text={desc} query={query} />
              </span>
            )}
          </span>
          {guide?.main && (
            <span
              data-model-guide
              className="block min-w-0 text-label whitespace-normal text-fg-muted [overflow-wrap:anywhere]"
            >
              <Mark text={guide.main} query={query} />
            </span>
          )}
          {priceValue && (
            <span
              data-model-price
              title={`${priceValue} · ${priceDescription}`}
              className="block min-w-0 text-label whitespace-normal text-fg-muted tabular-nums [overflow-wrap:anywhere]"
            >
              {priceValue} ·{' '}
              {tr(price?.basis === 'custom' ? 'modelChannels.menu.priceCustom' : 'modelChannels.menu.priceReference')}
            </span>
          )}
        </span>
      </button>
      {(meta || chip) && (
        <span className="flex shrink-0 items-center gap-1.5 text-label text-fg-muted tabular-nums">
          {meta}
          {chip}
        </span>
      )}
    </div>
  )
}
