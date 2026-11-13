// 概况 › PR：这个会话的 PR。状态圆标（开放绿、草稿灰、已合并强调色、已关闭红）、「#128」加粗跟标题，第二行分支和仓库，
// 一排标签：状态、检查、冲突、增删；有冲突时「让它修」是主按钮。数据和侧栏悬停卡同一份，主进程只查本机会话，远程机器上自然没有
import { Check, CircleDashed, Copy, ExternalLink, GitPullRequest, RefreshCw, X } from 'lucide-react'
import { cn, IconButton, useToast } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { sendFix } from '@/features/checks/SessionCheckBar'
import { copyPrLink, openUrl, PrFacts } from '@/features/sidebar/PrCard'
import { PR_STATE, visiblePrs } from '@/features/sidebar/sessionStatusModel'
import { useSessionStatus } from '@/features/sidebar/useSessionStatus'
import { prConflictRequest, type SessionPr } from '../../../../../shared/types/session-status'
import { DiffBlocks } from './ChangesSection'
import { prConflictKey, prHeadline } from './overviewModel'
import type { SectionProps } from './OverviewPanel'
import { Pill, Section, Tag, type TagTone } from './Section'

const STATE_TONE: Record<SessionPr['state'], TagTone> = {
  open: 'ok',
  draft: 'default',
  merged: 'accent',
  closed: 'bad',
}
const ICON_TONE: Record<SessionPr['state'], string> = {
  open: 'bg-success/14 text-success',
  draft: 'bg-ov-chip text-fg-muted',
  merged: 'bg-accent-soft text-accent-fg',
  closed: 'bg-danger/15 text-danger',
}

export function PrSection({ sessionId, active }: SectionProps) {
  useI18n()
  const { prs, gh } = useSessionStatus()
  const list = active ? visiblePrs(prs[sessionId]) : []
  if (!list.length) return null
  const first = list[0]!
  const headline = prHeadline(first)
  const summary = [
    `#${first.number}`,
    list.length > 1 ? tr('overview.prCount', { count: list.length }) : null,
    headline?.text,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Section
      id="pr"
      icon={GitPullRequest}
      title={tr('overview.pr')}
      count={list.length > 1 ? list.length : undefined}
      summary={summary}
      tone={headline?.bad ? 'bad' : undefined}
    >
      {list.map(pr => (
        <PrCard key={pr.url} pr={pr} gh={gh} sessionId={sessionId} />
      ))}
    </Section>
  )
}

function PrCard({ pr, gh, sessionId }: { pr: SessionPr; gh: string; sessionId: string }) {
  const toast = useToast()
  const conflict = pr.state === 'open' && pr.conflict
  return (
    <div data-overview-pr={pr.number} className="[&+&]:mt-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('grid size-6 shrink-0 place-items-center rounded-full', ICON_TONE[pr.state])}>
          <GitPullRequest size={13} strokeWidth={1.6} />
        </span>
        <span title={pr.title} className="min-w-0 flex-1 truncate text-fg">
          <b className="mr-1 font-semibold">#{pr.number}</b>
          {pr.title}
        </span>
      </div>
      <div
        title={`${pr.head} → ${pr.base} · ${pr.repo}`}
        className="truncate pt-0.5 pl-8 font-mono text-label text-fg-faint"
      >
        {pr.head} → {pr.base} · {pr.repo}
      </div>
      <div className="flex flex-wrap items-center gap-[5px] pt-1.5 pl-8">
        {pr.unknown ? (
          <span className="text-meta">
            <PrFacts pr={pr} gh={gh} />
          </span>
        ) : (
          <>
            <Tag tone={STATE_TONE[pr.state]}>{tr(PR_STATE[pr.state])}</Tag>
            {pr.state === 'open' &&
              (pr.ci === 'pass' ? (
                <Tag tone="ok" icon={Check}>
                  {tr('sidebar.status.pr.ciPass')}
                </Tag>
              ) : pr.ci === 'pending' ? (
                <Tag tone="warn" icon={RefreshCw}>
                  {tr('sidebar.status.pr.ciPending')}
                </Tag>
              ) : pr.ci === 'fail' ? (
                <Tag tone="bad" icon={X}>
                  {pr.ciFailed > 0
                    ? tr('sidebar.status.pr.ciFail', { count: pr.ciFailed })
                    : tr('sidebar.status.pr.ciFailAny')}
                </Tag>
              ) : (
                <Tag icon={CircleDashed}>{tr('overview.prNoChecks')}</Tag>
              ))}
            {conflict && (
              <Tag tone="bad" icon={X}>
                {tr('sidebar.status.pr.conflict')}
              </Tag>
            )}
            <span className="ml-0.5 text-label tabular-nums">
              <span className="text-success">+{pr.additions}</span> <span className="text-danger">−{pr.deletions}</span>
            </span>
            <DiffBlocks added={pr.additions} removed={pr.deletions} />
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pt-2 pl-8">
        {conflict && (
          <Pill tone="primary" onClick={() => void sendFix(sessionId, prConflictRequest(pr), prConflictKey(pr), toast)}>
            {tr('checks.fix')}
          </Pill>
        )}
        <Pill onClick={() => void openUrl(pr.url, toast)}>
          <ExternalLink size={13} strokeWidth={1.6} />
          {tr('sidebar.status.openPr')}
        </Pill>
        <IconButton
          icon={Copy}
          label={tr('sidebar.status.copyLink')}
          size={22}
          iconSize={13}
          onClick={() => copyPrLink(pr.url, toast)}
        />
      </div>
    </div>
  )
}
