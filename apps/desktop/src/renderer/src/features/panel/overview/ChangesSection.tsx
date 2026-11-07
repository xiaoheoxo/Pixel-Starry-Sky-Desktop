// 概况 › 改动：未提交的文件（这一轮改的在前、带增删），审查、提交、同步
import { FileDiff } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { useTurnChanges } from '@/features/coding/ai/useTurnChanges'
import { CommitButton, openChanges, SyncButton } from '@/features/session/ComposerGit'
import type { GitStatus } from '../../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { reviewTurn } from '../artifacts/focus'
import { requestGitFile } from '../git/GitPanel'
import { changeCount } from '../git/gitModel'
import { useGitStatus } from '../git/summary'
import { openRightTab } from '../workspaceStore'
import { changeRows } from './overviewModel'
import type { SectionProps } from './OverviewPanel'
import { Section, SECTION_ACTION, SECTION_ROW, SectionAction } from './Section'

export function ChangesSection({ sessionId, active }: SectionProps) {
  useI18n()
  const target = active ? { sessionId } : null
  const status = useGitStatus(target)
  const count = status?.repo ? changeCount(status) : 0
  if (!target || !status || !count) return null
  return (
    <Section
      id="changes"
      icon={FileDiff}
      title={tr('overview.changes')}
      summary={tr('git.composer.changes', { n: count })}
    >
      {/* 放在子组件里：useTurnChanges 流式输出时每来一个字都重算，折叠着不用算 */}
      <ChangesBody sessionId={sessionId} target={target} status={status} />
    </Section>
  )
}

function ChangesBody({ sessionId, target, status }: { sessionId: string; target: WorkspaceRef; status: GitStatus }) {
  useI18n()
  const turn = useTurnChanges(sessionId)
  const { rows, more } = changeRows(status, turn)
  return (
    <>
      {rows.map(row => (
        <button
          key={row.path}
          type="button"
          title={row.label}
          className={SECTION_ROW}
          onClick={() => {
            openRightTab('git')
            requestGitFile(row.path)
          }}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-meta">{row.label}</span>
          {row.turn && (
            <>
              <span className="shrink-0 rounded-sm border border-line px-[5px] text-label whitespace-nowrap text-fg-muted">
                {tr('overview.thisTurn')}
              </span>
              <span className="shrink-0 text-meta whitespace-nowrap tabular-nums">
                <span className="text-success">+{row.turn.added}</span>{' '}
                <span className="text-danger">−{row.turn.removed}</span>
              </span>
            </>
          )}
        </button>
      ))}
      {more > 0 && (
        <button
          type="button"
          onClick={openChanges}
          className="press mt-0.5 h-6 text-meta text-accent-fg hover:underline"
        >
          {tr('artifacts.moreFiles', { count: more })}
        </button>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {turn && (
          <SectionAction onClick={() => reviewTurn(sessionId, turn.turnKey === 'start' ? null : turn.turnKey)}>
            {tr('session.ChangedFilesCard.review')}
          </SectionAction>
        )}
        <CommitButton target={target} status={status} chip={SECTION_ACTION} />
        <SyncButton target={target} status={status} chip={SECTION_ACTION} />
      </div>
    </>
  )
}
