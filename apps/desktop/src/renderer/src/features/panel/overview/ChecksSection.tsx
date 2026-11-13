// 概况 › 检查：做完自动检查的结果和页面截图，让它修、看页面
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

export function ChecksSection({ sessionId, active }: SectionProps) {
  useI18n()
  const toast = useToast()
  const run = useSessionCheck(active ? sessionId : null)
  const dismissed = useDismissed()
  if (!run) return null
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
    </Section>
  )
}
