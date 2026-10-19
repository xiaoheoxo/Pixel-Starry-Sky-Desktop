import type { ExtStoreCheckReport } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { issueText } from '@/features/settings/extensions/model'
import { ISSUE_GROUP_KEYS, ISSUE_GROUP_TITLE, groupIssues, type IssueGroupKey } from './publishModel'

const TONE: Record<IssueGroupKey, string> = { reject: 'text-danger', hint: 'text-warn', note: 'text-fg-muted' }

/** 检查结果：「要改的 / 建议 / 提示」三组（和审核页同一种分组）；null 表示这台电脑上没有逐条结果 */
export function CheckReport({ report }: { report: ExtStoreCheckReport | null }) {
  const { locale, t } = useI18n()
  if (!report) return <p className="text-ui text-fg-faint">{t('extstore.publish.report.noLocal')}</p>
  if (report.incomplete) return <p className="text-ui text-warn">{t('extstore.publish.report.incomplete')}</p>
  const groups = groupIssues(report.issues)
  if (ISSUE_GROUP_KEYS.every(k => groups[k].length === 0))
    return <p className="text-ui text-fg-muted">{t('extstore.publish.report.clean')}</p>
  return (
    <div data-check-report className="space-y-2">
      {ISSUE_GROUP_KEYS.map(key =>
        groups[key].length === 0 ? null : (
          <div key={key} data-issue-group={key}>
            <div className="mb-1 text-meta text-fg-faint">
              {t(ISSUE_GROUP_TITLE[key])}（{groups[key].length}）
            </div>
            <ul className="space-y-1">
              {groups[key].map((issue, n) => (
                <li key={n} className={cn('text-ui', TONE[key])}>
                  {issueText(issue, locale)}
                  {issue.path && <span className="ml-1 text-meta text-fg-faint">{issue.path}</span>}
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </div>
  )
}
