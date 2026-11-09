import { tr } from '../../i18n/core'
import type { ModelTurnUsage, TurnUsage } from '@pixelsky/protocol'
import type { ReplyStatKey } from '../settings/replyStats'
import { outputSpeed } from '@pixelsky/protocol'
import { actualMoney, formatCost, formatDuration, formatFirstToken, formatTokens } from '../usage/format'

interface StatPart {
  key: ReplyStatKey
  text: string
  title: string
  mono?: boolean
}
type CountKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'requests'
const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** 所有模型先汇总再计算比例；缺失的计数不当成零，也不展示不完整的合计。 */
export function replyStatParts(usage: TurnUsage): { parts: StatPart[]; detail: string } {
  const entries = Object.entries(usage.models)
  if (!entries.length) return { parts: [], detail: '' }
  const sum = (key: CountKey): number | null => {
    let total = 0
    for (const [, model] of entries) {
      if (!known(model[key])) return null
      total += model[key]
    }
    return Number.isFinite(total) ? total : null
  }
  const input = sum('input'),
    output = sum('output'),
    cacheRead = sum('cacheRead'),
    cacheWrite = sum('cacheWrite'),
    requests = sum('requests')
  const totalInput = input !== null && cacheRead !== null && cacheWrite !== null ? input + cacheRead + cacheWrite : null
  const totalTokens = totalInput !== null && output !== null ? totalInput + output : null
  const hitRate = totalInput !== null && totalInput > 0 && cacheRead !== null ? cacheRead / totalInput : null
  const costs = entries.map(([, m]) => m.costUsd).filter(known)
  const cost = costs.reduce((a, b) => a + b, 0)
  const platform = !!usage.settlement || entries.some(([, m]) => m.costSource && m.costSource !== 'estimate')
  const pending = entries.some(([, m]) => m.costSource === 'pending')
  const subscription = entries.some(([, m]) => m.billing === 'subscription')
  const costText = platform
    ? !costs.length
      ? pending
        ? tr('billing.pending')
        : '—'
      : `${costs.length < entries.length ? '≥ ' : ''}${subscription ? tr('billing.subscription') + ' ' : ''}${actualMoney(cost)}`
    : !costs.length
      ? null
      : `${costs.length < entries.length ? '≥' : '≈'} ${cost > 0 && cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`}`
  const amount = (m: ModelTurnUsage): number => (known(m.input) ? m.input : 0) + (known(m.output) ? m.output : 0)
  const sorted = [...entries].sort((a, b) => amount(b[1]) - amount(a[1]))
  const tokens = (n: unknown): string => (known(n) ? formatTokens(n) : '—')
  const detail = sorted
    .map(([name, m]) =>
      tr('session.turnStatsData.uncachedInputCacheRead', {
        p0: name,
        p1: tokens(m.input),
        p2: tokens(m.cacheRead),
        p3: tokens(m.cacheWrite),
        p4: tokens(m.output),
        p5: known(m.requests) ? m.requests : '—',
        p6: formatCost(known(m.costUsd) ? m.costUsd : null, m.costSource, m.billing),
      }),
    )
    .join('\n')
  const parts: StatPart[] = []
  if (known(usage.durationMs))
    parts.push({
      key: 'elapsed',
      text: formatDuration(usage.durationMs),
      get title() {
        return tr('session.turnStatsData.totalDuration')
      },
    })
  if (totalInput !== null && output !== null)
    parts.push({
      key: 'tokens',
      text: `↑${formatTokens(totalInput)} ↓${formatTokens(output)}`,
      get title() {
        return tr('session.turnStatsData.inputIncludingCacheReads')
      },
    })
  if (costText)
    parts.push({
      key: 'cost',
      text: costText,
      get title() {
        return platform
          ? tr(pending ? 'billing.pending' : costs.length < entries.length ? 'billing.unavailable' : 'billing.actual')
          : usage.estimate === 'official'
            ? tr('customApi.costEstimateShort')
            : tr('session.turnStatsData.costEngineEstimate')
      },
    })
  parts.push({
    key: 'model',
    text: `${sorted[0][0]}${sorted.length > 1 ? ` +${sorted.length - 1}` : ''}`,
    get title() {
      return tr('session.ModelSourceMenu.model')
    },
    mono: true,
  })
  const count = (key: ReplyStatKey, label: string, value: number | null, title: string): void => {
    if (value !== null) parts.push({ key, text: `${label} ${formatTokens(value)}`, title })
  }
  count(
    'inputTokens',
    tr('session.turnStatsData.input'),
    input,
    tr('session.turnStatsData.uncachedInputTokensExcluding'),
  )
  count('outputTokens', tr('session.live.SessionStrips.output'), output, tr('session.turnStatsData.outputTokens'))
  count(
    'totalTokens',
    tr('session.turnStatsData.total'),
    totalTokens,
    tr('session.turnStatsData.totalTokensUncachedInput'),
  )
  count('cacheRead', tr('session.turnStatsData.cacheRead'), cacheRead, tr('session.turnStatsData.cacheReadTokens'))
  count('cacheWrite', tr('session.turnStatsData.cacheWrite'), cacheWrite, tr('session.turnStatsData.cacheWriteTokens'))
  if (hitRate !== null)
    parts.push({
      key: 'cacheHitRate',
      text: tr('session.turnStatsData.cacheHit', { p0: (hitRate * 100).toFixed(1).replace(/\.0$/, '') }),
      get title() {
        return tr('session.turnStatsData.cacheReadAllInput')
      },
    })
  if (requests !== null)
    parts.push({
      key: 'requests',
      text: tr('session.turnStatsData.requests', { p0: requests }),
      get title() {
        return tr('session.turnStatsData.sumOfRequestCounts')
      },
    })
  // 速度：各模型量到的输出合计 ÷ 生成时间合计（不含等首字和跑工具）；首字只记在第一个请求的模型上
  const timed = entries.filter(([, m]) => known(m.genMs) && known(m.genOutput))
  const speed = outputSpeed({
    genMs: timed.reduce((a, [, m]) => a + m.genMs!, 0),
    genOutput: timed.reduce((a, [, m]) => a + m.genOutput!, 0),
  })
  if (speed !== null)
    parts.push({
      key: 'speed',
      text: `${Math.round(speed)} tok/s`,
      get title() {
        return tr('usageColumns.speedHelpLocal')
      },
    })
  const firsts = entries.map(([, m]) => m.firstTokenMs).filter(known)
  if (firsts.length)
    parts.push({
      key: 'firstToken',
      text: `${tr('settings.usage.RemoteCallsTable.firstToken')} ${formatFirstToken(Math.min(...firsts))}`,
      get title() {
        return tr('usageColumns.firstTokenHelpLocal')
      },
    })
  return { parts, detail }
}
