// 概况 › 额度（「状态」里的一格）：最紧的那个窗口和照这个速度会不会提前用完。点开：账号的每个窗口（和输入框的额度按钮同一份数据），
// 条上竖线是这个窗口过了多少时间；本会话的轮次、用时、Token、费用（算得出才显示）、每轮 Token 的小柱图、按模型合计
import { useMemo, useRef } from 'react'
import { Activity, Check, TriangleAlert } from 'lucide-react'
import type { Item } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { useAccount } from '@/features/account/useAccount'
import { useEngineState } from '@/features/engine'
import { shortModel } from '@/features/session/live/agentTrace'
import {
  durationText,
  percentText,
  planEntries,
  quotaEntries,
  quotaLayout,
  resetShort,
  tightestEntry,
  type QuotaEntry,
} from '@/features/session/quota/quotaModel'
import { useMinuteNow } from '@/features/session/quota/quotaStore'
import { replyStatParts } from '@/features/session/turnStatsData'
import { useSettings } from '@/features/settings/SettingsProvider'
import { formatTokens } from '@/features/usage/format'
import { LEVEL_TONE } from './ContextSection'
import { useSessionQuota } from './overviewData'
import {
  countsForUsage,
  modelUsage,
  quotaPace,
  quotaRows,
  sessionUsage,
  windowElapsed,
  type SessionUsage,
} from './overviewModel'
import type { SectionProps } from './OverviewPanel'
import { Meter, NOTE, SECTION_LINKS, SectionLink, StatusTile, SUB_LABEL } from './Section'

/** 小柱图最多画最近这么多轮 */
const SPARK_TURNS = 12

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

/** 条加一道竖线：这个窗口已经过去的时间 */
function PaceBar({ entry, now, className }: { entry: QuotaEntry; now: number; className?: string }) {
  const elapsed = windowElapsed(entry, now)
  return (
    <span className={cn('relative block', className)}>
      <Meter percent={entry.percent} level={entry.level} label={entry.name} />
      {elapsed !== null && (
        <i
          title={tr('overview.paceElapsed', { percent: percentText(elapsed * 100) })}
          className="absolute -inset-y-0.5 -ml-px w-0.5 rounded-sm bg-fg opacity-55"
          style={{ left: `${elapsed * 100}%` }}
        />
      )}
    </span>
  )
}

function UsageBody({ sessionId }: { sessionId: string }) {
  useI18n()
  const settings = useSettings()
  const { provider, quota, planLimits } = useSessionQuota(sessionId)
  const now = useMinuteNow()
  const { balanceText } = useAccount()
  const usage = useSessionUsage(sessionId)
  const supported = !!provider && !!quota && quota.status !== 'unsupported'
  const entries = supported ? [...quotaEntries(quota, now), ...planEntries(planLimits, now)] : []
  const rows = supported ? quotaRows(quotaLayout(quota, { provider, now, balanceText, planLimits })) : []
  if (!rows.length && !usage) return null
  const parts = usage ? replyStatParts(usage.usage).parts : []
  const cost = parts.find(p => p.key === 'cost')
  const elapsed = usage && usage.usage.durationMs > 0 ? parts.find(p => p.key === 'elapsed') : undefined
  const tight = tightestEntry(entries)
  const pace = tight && quotaPace(tight, now)
  return (
    <StatusTile
      id="usage"
      icon={Activity}
      title={tight ? `${tr('overview.quota')} · ${tight.name}` : tr('overview.quota')}
      value={tight ? percentText(tight.percent) : (cost?.text ?? (usage?.tokens ? formatTokens(usage.tokens) : '—'))}
      folded={tight ? `${tr('overview.quota')} ${percentText(tight.percent)}` : undefined}
      tone={tight ? LEVEL_TONE[tight.level] : undefined}
      visual={tight && <PaceBar entry={tight} now={now} className="mt-[3px]" />}
      subTone={pace?.fast ? 'warn' : undefined}
      sub={
        pace?.fast
          ? tr('overview.paceEmptyShort', { time: durationText(pace.emptyIn) })
          : tight?.resetsAt != null
            ? resetShort(tight.resetsAt, now)
            : usage
              ? tr('overview.sessionTurns', { count: usage.turns })
              : undefined
      }
    >
      {rows.map(row => {
        const entry = row.percent !== null ? entries.find(e => e.id === row.id) : undefined
        if (!entry)
          return (
            <div key={row.id} title={row.hover} className="flex min-h-6 items-center gap-[7px] text-fg-secondary">
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <span className="whitespace-nowrap text-fg-muted tabular-nums">{row.value}</span>
            </div>
          )
        const p = quotaPace(entry, now)
        return (
          <div key={row.id} title={row.hover} className="[&+&]:mt-2.5">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="font-medium whitespace-nowrap text-fg">{entry.name}</span>
              <b className="text-list font-medium tabular-nums">{percentText(entry.percent)}</b>
              <span className="ml-auto truncate text-label text-fg-muted">
                {entry.resetsAt !== null ? resetShort(entry.resetsAt, now) : row.value}
              </span>
            </div>
            <PaceBar entry={entry} now={now} className="mt-[5px] [&>[role=progressbar]]:h-1.5" />
            {p && (
              <div
                className={cn('mt-[5px] flex items-center gap-1 text-label', p.fast ? 'text-warn-fg' : 'text-success')}
              >
                {p.fast ? (
                  <TriangleAlert size={12} strokeWidth={1.6} className="shrink-0" />
                ) : (
                  <Check size={12} strokeWidth={1.8} className="shrink-0" />
                )}
                {p.fast
                  ? tr('overview.paceFast', { time: durationText(p.emptyIn), early: durationText(p.early) })
                  : tr('overview.paceOk')}
              </div>
            )}
          </div>
        )
      })}
      {entries.some(e => windowElapsed(e, now) !== null) && <p className={NOTE}>{tr('overview.paceNote')}</p>}
      {usage && <SessionStats usage={usage} elapsed={elapsed?.text} cost={cost} />}
      <div className={SECTION_LINKS}>
        <SectionLink onClick={() => settings.openSettings('usage')}>{tr('overview.usagePage')}</SectionLink>
      </div>
    </StatusTile>
  )
}

function SessionStats({
  usage,
  elapsed,
  cost,
}: {
  usage: SessionUsage
  elapsed?: string
  cost?: { text: string; title?: string }
}) {
  const turns = usage.perTurn.slice(-SPARK_TURNS)
  const top = Math.max(...turns)
  const peak = usage.perTurn.indexOf(Math.max(...usage.perTurn))
  const models = modelUsage(usage.usage)
  const most = Math.max(...models.map(m => m.tokens))
  // 平台结算的费用是整轮的，分不到模型上：只在没有结算时按模型写费用
  const perModelCost = !usage.usage.settlement
  const stats = [
    { label: tr('overview.statTurns'), value: String(usage.turns) },
    elapsed && { label: tr('overview.statTime'), value: elapsed },
    usage.tokens !== null && { label: 'Token', value: formatTokens(usage.tokens) },
    cost && { label: tr('overview.statCost'), value: cost.text, title: cost.title },
  ].filter(s => !!s)
  return (
    <>
      <div className={SUB_LABEL}>{tr('overview.thisSession')}</div>
      <div className="grid grid-cols-4 gap-1.5 pt-0.5 pb-0.5">
        {stats.map(s => (
          <div
            key={s.label}
            title={'title' in s ? s.title : undefined}
            className="min-w-0 rounded-lg bg-ov-chip px-2 py-[5px]"
          >
            <b className="block truncate text-prose leading-[1.25] font-medium tabular-nums">{s.value}</b>
            <span className="block truncate text-label text-fg-muted">{s.label}</span>
          </div>
        ))}
      </div>
      {turns.length > 1 && (
        <>
          <div aria-label={tr('overview.perTurn')} className="mt-2 mb-0.5 flex h-[38px] items-end gap-1">
            {turns.map((t, i) => (
              <i
                key={i}
                title={formatTokens(t)}
                className={cn(
                  'min-h-[3px] flex-1 rounded-t-[4px] rounded-b-[2px]',
                  i === turns.length - 1 ? 'bg-accent' : 'bg-fg/16',
                )}
                style={{ height: `${Math.round((t / top) * 100)}%` }}
              />
            ))}
          </div>
          <div className="flex justify-between text-label text-fg-faint">
            <span>{tr('overview.perTurn')}</span>
            <span>{tr('overview.perTurnMax', { n: peak + 1, tokens: formatTokens(usage.perTurn[peak]!) })}</span>
          </div>
        </>
      )}
      {models.length > 0 && (
        <div className="mt-1.5 grid grid-cols-[max-content_minmax(20px,1fr)_auto_auto] items-center gap-x-2 gap-y-1 text-fg-secondary">
          {models.map(m => {
            const c = perModelCost ? replyStatParts(m.usage).parts.find(p => p.key === 'cost') : undefined
            return (
              <div key={m.model} className="contents">
                <span title={m.model}>{shortModel(m.model)}</span>
                <Meter percent={(m.tokens / most) * 100} muted />
                <span className="text-right text-fg-muted tabular-nums">{formatTokens(m.tokens)}</span>
                <span title={c?.title} className="text-right text-fg tabular-nums">
                  {c?.text}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
