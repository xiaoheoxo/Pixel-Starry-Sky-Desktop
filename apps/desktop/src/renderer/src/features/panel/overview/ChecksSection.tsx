// 概况 › 检查：做完自动检查的结果和页面截图，让它修、看页面；AI 审查还有几条没处理（docs/ui/review-pr-actions.md §2.2）
import { ListChecks } from 'lucide-react'
import { useToast } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { CheckSummary } from '@/features/checks/CheckSummary'
import { openSessionPage, sendCheckFix } from '@/features/checks/SessionCheckBar'
import { useSessionCheck } from '@/features/checks/sessionChecks'
import { checkAttentionKey, useDismissed } from './attentionDismissed'
import { checkHeadline } from './overviewModel'
import type { SectionProps } from './OverviewPanel'
import { Section } from './Section'
import { reviewCounts } from '@/features/session/review/reviewModel'
import { useSessionReviews } from '@/features/session/review/reviewStore'

export function ChecksSection({ sessionId, active }: SectionProps) {
  useI18n()
  const toast = useToast()
  const run = useSessionCheck(active ? sessionId : null)
  const dismissed = useDismissed()
  const reviews = useSessionReviews(active ? sessionId : null)
  const open = Object.values(reviews).reduce((n, r) => n + reviewCounts(r).open, 0)
  if (!run && !open) return null
  const reviewText = open ? tr('aiReview.checksGroup', { open }) : null
  if (!run)
    return (
      <Section id="checks" icon={ListChecks} title={tr('checks.title')} summary={reviewText ?? ''}>
        <p data-overview-ai-review className="text-meta text-fg-muted">
          {reviewText}
        </p>
      </Section>
    )
  const headline = checkHeadline(run)
  const sent = headline.bad && dismissed.has(checkAttentionKey(run.id))
  return (
    <Section
      id="checks"
      icon={ListChecks}
      title={tr('checks.title')}
      summary={sent ? tr('overview.checksFixSent') : headline.text}
      tone={headline.bad && !sent ? 'bad' : undefined}
    >
      <CheckSummary
        embedded
        run={run}
        onFix={() => sendCheckFix(sessionId, run, toast)}
        onOpenPage={url => openSessionPage(sessionId, url)}
      />
      {reviewText && (
        <p data-overview-ai-review className="pt-2 text-meta text-fg-muted">
          {reviewText}
        </p>
      )}
    </Section>
  )
}
