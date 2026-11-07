// 概况 › PR：这个会话的 PR、状态、分支，打开和复制链接。数据和侧栏悬停卡同一份，主进程只查本机会话，远程机器上自然没有
import { Copy, ExternalLink, GitPullRequest } from 'lucide-react'
import { useToast } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { copyPrLink, openUrl, PrFacts } from '@/features/sidebar/PrCard'
import { visiblePrs } from '@/features/sidebar/sessionStatusModel'
import { useSessionStatus } from '@/features/sidebar/useSessionStatus'
import { prHeadline } from './overviewModel'
import type { SectionProps } from './OverviewPanel'
import { Section, SectionAction } from './Section'

export function PrSection({ sessionId, active }: SectionProps) {
  useI18n()
  const toast = useToast()
  const { prs, gh } = useSessionStatus()
  const list = active ? visiblePrs(prs[sessionId]) : []
  if (!list.length) return null
  const first = list[0]
  const headline = prHeadline(first)
  const summary = [list.length > 1 ? tr('overview.prCount', { count: list.length }) : null, headline?.text]
    .filter(Boolean)
    .join(' · ')
  return (
    <Section
      id="pr"
      icon={GitPullRequest}
      title={list.length > 1 ? tr('overview.pr') : `PR #${first.number}`}
      summary={<span className={headline?.bad ? 'text-danger' : undefined}>{summary}</span>}
    >
      {list.map(pr => (
        <div
          key={pr.url}
          data-overview-pr={pr.number}
          className="[&+&]:mt-2 [&+&]:border-t [&+&]:border-line-subtle [&+&]:pt-2"
        >
          <p title={pr.title} className="truncate text-fg-secondary">
            {list.length > 1 && `#${pr.number} `}
            {pr.title}
          </p>
          <p title={`${pr.head} → ${pr.base}`} className="mt-0.5 truncate font-mono text-meta text-fg-muted">
            {pr.head} → {pr.base}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-meta">
            <PrFacts pr={pr} gh={gh} />
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <SectionAction onClick={() => void openUrl(pr.url, toast)}>
              <ExternalLink size={13} strokeWidth={1.6} />
              {tr('sidebar.status.openPr')}
            </SectionAction>
            <SectionAction onClick={() => copyPrLink(pr.url, toast)}>
              <Copy size={13} strokeWidth={1.6} />
              {tr('sidebar.status.copyLink')}
            </SectionAction>
          </div>
        </div>
      ))}
    </Section>
  )
}
