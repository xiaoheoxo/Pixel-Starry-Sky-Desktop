// 概况 › 要处理：下面各分组里要你动手的汇总，每条一个圆形图标（红 = 坏了、橙 = 要你处理，坏了的在前）和一个操作；
// 等审批在顶上的「正在」行（SessionHead），这里不列；没有就不显示（docs/ui/desktop-parity.md §3.1）
import { useEffect, type ReactNode } from 'react'
import { Activity, Gauge, GitPullRequest, ListChecks, Plug, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { ApprovalRequest } from '@pixelsky/protocol'
import { cn, useToast } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '@/i18n/core'
import { sendCheckFix, sendFix } from '@/features/checks/SessionCheckBar'
import { useSessionCheck } from '@/features/checks/sessionChecks'
import { useEngineState } from '@/features/engine'
import { planEntries, quotaEntries, tightestEntry } from '@/features/session/quota/quotaModel'
import { useMinuteNow } from '@/features/session/quota/quotaStore'
import { openUrl } from '@/features/sidebar/PrCard'
import { visiblePrs } from '@/features/sidebar/sessionStatusModel'
import { useSessionStatus } from '@/features/sidebar/useSessionStatus'
import { ToolError } from '../ToolsUi'
import { setDismissed, useDismissed } from './attentionDismissed'
import { useCompactAction } from './ContextSection'
import { useSessionContext, useSessionQuota, useSessionRecord, type OverviewMcp } from './overviewData'
import { prConflictRequest } from '../../../../../shared/types/session-status'
import { attentionItems, resolvedPrKeys, type AttentionAction, type AttentionItem } from './overviewModel'
import { useOverviewPrefs } from './overviewPrefs'
import type { SectionProps } from './OverviewPanel'
import { Section, SectionAction } from './Section'

const RANK = { bad: 0, warn: 1 }

const NO_PENDING: ApprovalRequest[] = []

const ICON: Record<AttentionItem['kind'], LucideIcon> = {
  approval: TriangleAlert,
  mcp: Plug,
  check: ListChecks,
  pr: GitPullRequest,
  context: Gauge,
  quota: Activity,
}

const LABEL: Record<Exclude<AttentionAction['kind'], 'compact'>, TranslationKey> = {
  approval: 'overview.attentionLocate',
  'mcp-login': 'connectors.login',
  'mcp-reconnect': 'connectors.reconnect',
  check: 'checks.fix',
  'pr-conflict': 'checks.fix',
  'pr-ci': 'sidebar.status.openPr',
}

export function AttentionSection({ sessionId, active, mcp }: SectionProps) {
  return active ? <AttentionBody sessionId={sessionId} mcp={mcp} /> : null
}

function AttentionBody({ sessionId, mcp }: { sessionId: string; mcp: OverviewMcp }) {
  useI18n()
  const toast = useToast()
  const pending = useEngineState(s => s.snapshots[sessionId]?.pending) ?? NO_PENDING
  const record = useSessionRecord(sessionId, true)
  const check = useSessionCheck(sessionId)
  const sessionPrs = useSessionStatus().prs[sessionId]
  const context = useSessionContext(sessionId, true)
  const { quota, planLimits } = useSessionQuota(sessionId)
  const now = useMinuteNow()
  const dismissed = useDismissed()
  const { hidden, collapsed } = useOverviewPrefs()
  useEffect(() => {
    for (const key of resolvedPrKeys(sessionPrs ?? [])) setDismissed(key, false)
  }, [sessionPrs])

  const items = attentionItems({
    pending,
    cwd: record?.cwd ?? null,
    connectors: mcp.list,
    report: mcp.report,
    check,
    prs: visiblePrs(sessionPrs),
    context,
    quota: quota ? tightestEntry([...quotaEntries(quota, now), ...planEntries(planLimits, now)]) : null,
    now,
    dismissed,
  })
    .filter(item => item.kind !== 'approval')
    .sort((a, b) => RANK[a.tone] - RANK[b.tone])
  if (!items.length) return null

  const act = (item: AttentionItem, action: Exclude<AttentionAction, { kind: 'compact' }>): void => {
    switch (action.kind) {
      case 'approval':
        return
      case 'mcp-login':
        return mcp.actions.login(action.name)
      case 'mcp-reconnect':
        return mcp.actions.reconnect(action.name)
      case 'check':
        return void sendCheckFix(sessionId, action.run, toast)
      case 'pr-conflict':
        return void sendFix(sessionId, prConflictRequest(action.pr), item.key, toast)
      case 'pr-ci':
        setDismissed(item.key, true)
        return void openUrl(action.pr.url, toast)
    }
  }
  const mcpBusy = (action: AttentionAction): boolean =>
    (action.kind === 'mcp-login' && mcp.actions.busy === `login:${action.name}`) ||
    (action.kind === 'mcp-reconnect' && mcp.actions.busy === `reconnect:${action.name}`)
  return (
    <Section
      id="attention"
      icon={TriangleAlert}
      attention
      title={tr('overview.attention')}
      count={items.length}
      summary={tr('overview.attentionCount', { count: items.length })}
    >
      {items.map(item => {
        const action = item.action
        if (action?.kind === 'compact') return <CompactRow key={item.key} item={item} sessionId={sessionId} />
        return (
          <Row
            key={item.key}
            item={item}
            button={
              action && (
                <SectionAction disabled={mcpBusy(action)} onClick={() => act(item, action)}>
                  {tr(LABEL[action.kind])}
                </SectionAction>
              )
            }
          />
        )
      })}
      {/* 操作的报错本来写在 MCP 分组里，它看不见时写在这 */}
      {mcp.error && (hidden.includes('mcp') || collapsed.includes('mcp')) && (
        <div className="mt-1.5">
          <ToolError error={mcp.error} />
        </div>
      )}
    </Section>
  )
}

/** 压缩的按钮和确认都带状态，每条一份就好，放在子组件里 */
function CompactRow({ item, sessionId }: { item: AttentionItem; sessionId: string }) {
  const compact = useCompactAction(sessionId)
  return <Row item={item} button={compact.button} below={compact.details} />
}

function Row({ item, button, below }: { item: AttentionItem; button?: ReactNode; below?: ReactNode }) {
  const Icon = ICON[item.kind]
  return (
    <div data-overview-attention={item.kind} data-tone={item.tone}>
      <div className="flex min-h-8 items-center gap-[9px] py-0.5">
        <span
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-full',
            item.tone === 'bad' ? 'bg-danger/15 text-danger' : 'bg-warn/18 text-warn-fg',
          )}
        >
          <Icon size={13} strokeWidth={1.6} />
        </span>
        <span className="min-w-0 flex-1">
          <span title={item.text} className="line-clamp-2 font-medium break-words text-fg">
            {item.text}
          </span>
          {item.sub && (
            <span title={item.sub} className="block truncate text-meta text-fg-muted">
              {item.sub}
            </span>
          )}
        </span>
        {button}
      </div>
      {below}
    </div>
  )
}
