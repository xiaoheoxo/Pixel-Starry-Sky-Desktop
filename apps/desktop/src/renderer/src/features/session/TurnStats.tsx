import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Fragment, type ReactNode } from 'react'
import type { TurnUsage } from '@pixelsky/protocol'
import { useReplyStats } from '@/features/settings/replyStats'
import { replyStatParts } from './turnStatsData'

export type { TurnUsage } from '@pixelsky/protocol'

/** 每轮回复下方的可选统计；预览和真实会话共用同一套汇总及格式化规则。 */
export function TurnStats({
  usage,
  className,
  leading,
}: {
  usage: TurnUsage
  className?: string
  leading?: ReactNode
}) {
  useI18n()
  const selected = useReplyStats()
  const { parts: available, detail } = replyStatParts(usage)
  const parts = available.filter(part => selected.includes(part.key))
  // 统计全部关闭时只留回复操作；两者都没有时不产生 DOM
  if (!parts.length)
    return leading ? (
      <div data-turn-stats className={`group/message flex items-center ${className ?? ''}`}>
        {leading}
      </div>
    ) : null
  return (
    <div
      data-turn-stats
      className={`group/message flex flex-wrap items-center gap-x-1.5 gap-y-1 text-meta text-fg-faint tabular-nums ${className ?? ''}`}
      title={detail}
      aria-label={tr('session.TurnStats.replyStatistics')}
    >
      {leading}
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 && <span aria-hidden>·</span>}
          <span data-stat={part.key} className={part.mono ? 'font-mono' : undefined} title={`${part.title}\n${detail}`}>
            {part.text}
          </span>
        </Fragment>
      ))}
    </div>
  )
}
