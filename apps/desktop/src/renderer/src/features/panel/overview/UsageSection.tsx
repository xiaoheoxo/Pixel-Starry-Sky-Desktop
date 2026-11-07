// 概况 › 额度和用量：账号的时间窗口和余额（和输入框的额度按钮同一份数据），本会话的轮次、用时、Token、费用（算得出才显示）
import { useMemo, useRef } from 'react'
import { Activity } from 'lucide-react'
import type { Item } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { useAccount } from '@/features/account/useAccount'
import { useEngineState } from '@/features/engine'
import { percentText, quotaLayout } from '@/features/session/quota/quotaModel'
import { useMinuteNow } from '@/features/session/quota/quotaStore'
import { replyStatParts } from '@/features/session/turnStatsData'
import { useSettings } from '@/features/settings/SettingsProvider'
import { formatTokens } from '@/features/usage/format'
import { useSessionQuota } from './overviewData'
import { countsForUsage, quotaRows, sessionUsage, type SessionUsage } from './overviewModel'
import type { SectionProps } from './OverviewPanel'
import { Meter, Section, SectionAction, Stat } from './Section'

export function UsageSection({ sessionId, active }: SectionProps) {
  return active ? <UsageBody sessionId={sessionId} /> : null
}

function useSessionUsage(sessionId: string): SessionUsage | null {
  const kept = useRef<readonly Item[]>([])
  // 流式输出时 items 每来一个字都变，要算的这几条不变：引用都没变就不重算、不重新渲染
  const items = useEngineState(s => {
    const next = (s.snapshots[sessionId]?.items ?? []).filter(countsForUsage)
    const same = next.length === kept.current.length && next.every((item, i) => item === kept.current[i])
    return same ? kept.current : (kept.current = next)
  })
  return useMemo(() => sessionUsage(items), [items])
}

function UsageBody({ sessionId }: { sessionId: string }) {
  useI18n()
  const settings = useSettings()
  const { provider, quota, planLimits } = useSessionQuota(sessionId)
  const now = useMinuteNow()
  const { balanceText } = useAccount()
  const usage = useSessionUsage(sessionId)
  const rows =
    provider && quota && quota.status !== 'unsupported'
      ? quotaRows(quotaLayout(quota, { provider, now, balanceText, planLimits }))
      : []
  if (!rows.length && !usage) return null
  const parts = usage ? replyStatParts(usage.usage).parts : []
  const cost = parts.find(p => p.key === 'cost')
  const elapsed = usage && usage.usage.durationMs > 0 ? parts.find(p => p.key === 'elapsed') : undefined
  const windows = rows.flatMap(r => (r.percent === null ? [] : [`${r.name} ${percentText(r.percent)}`]))
  return (
    <Section
      id="usage"
      icon={Activity}
      title={tr('overview.usage')}
      summary={windows.slice(0, 2).join(' · ') || cost?.text}
      quietOpen
    >
      {rows.map(row => (
        <div key={row.id} title={row.hover} className="mb-[5px]">
          <div className="flex min-h-[22px] items-center gap-[7px] text-fg-secondary">
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
            <span className="text-meta whitespace-nowrap text-fg-muted tabular-nums">{row.value}</span>
          </div>
          {row.percent !== null && <Meter percent={row.percent} level={row.level} label={row.name} />}
        </div>
      ))}
      {usage && (
        <div className="mt-1.5 grid grid-cols-4 gap-0.5">
          <Stat value={usage.turns} label={tr('settings.usage.KpiCards.turns')} />
          {elapsed && <Stat value={elapsed.text} label={tr('goal.bar.statTime')} />}
          {usage.tokens !== null && <Stat value={formatTokens(usage.tokens)} label="Token" />}
          {cost && <Stat value={cost.text} label={tr('settings.replyStats.cost')} title={cost.title} />}
        </div>
      )}
      <div className="mt-1.5">
        <SectionAction onClick={() => settings.openSettings('usage')}>{tr('overview.usagePage')}</SectionAction>
      </div>
    </Section>
  )
}
