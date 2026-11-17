// 任务卡的失败原因和运行记录（docs/multica-learn.md §1、§2、§11.1）
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/ui'
import type { ChannelTask } from '@/data/types'
import type { ChannelRun } from '../../../../shared/types/channels'
import { STATUS_LABEL } from './ChannelTaskCard'
import { durText } from './format'
import { reasonText } from './runText'

/** 失败的卡在错误原文上面一行 */
export function RunReasonLine({ task, mine }: { task: ChannelTask; mine: boolean }) {
  useI18n()
  const text = task.status === 'failed' ? reasonText(task.reason, mine) : null
  if (!text) return null
  return (
    <p data-run-reason={task.reason} className="mt-1 text-meta font-medium break-words text-danger">
      {text}
    </p>
  )
}

/** 跑过两次以上：「运行 N 次」，点开每次一行 */
export function TaskRuns({
  task,
  mine,
  onOpenSession,
}: {
  task: ChannelTask
  mine: boolean
  onOpenSession: (sessionId: string) => void
}) {
  useI18n()
  const [open, setOpen] = useState(false)
  const runs = task.runs ?? []
  if (runs.length < 2) return null
  return (
    <div data-task-runs className="mt-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className="press inline-flex items-center gap-1 rounded px-1 text-meta text-fg-muted hover:bg-hover hover:text-fg"
      >
        {tr('run.count', { count: runs.length })}
        <ChevronDown size={12} strokeWidth={1.75} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ol className="mt-1 flex flex-col gap-0.5 border-l border-line-subtle pl-2.5">
          {[...runs].reverse().map(r => (
            <RunRow key={`${r.n}-${r.endedAt}`} run={r} mine={mine} onOpenSession={onOpenSession} />
          ))}
        </ol>
      )}
    </div>
  )
}

function RunRow({
  run,
  mine,
  onOpenSession,
}: {
  run: ChannelRun
  mine: boolean
  onOpenSession: (sessionId: string) => void
}) {
  const reason = run.status === 'failed' ? reasonText(run.reason, mine) : null
  const parts = [
    tr('run.nth', { n: run.n }),
    tr(STATUS_LABEL[run.status]),
    run.machine,
    run.model || run.engine,
    run.startedAt ? durText(run.endedAt - run.startedAt) : null,
  ].filter(Boolean)
  return (
    <li className="flex min-w-0 flex-col text-meta">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={cn('min-w-0 truncate', run.status === 'failed' ? 'text-danger' : 'text-fg-muted')}>
          {parts.join(' · ')}
        </span>
        {mine && run.sessionId && (
          <button
            type="button"
            onClick={() => onOpenSession(run.sessionId!)}
            className="press shrink-0 rounded px-1 text-accent-fg hover:bg-hover"
          >
            {tr('run.openSession')}
          </button>
        )}
      </span>
      {(reason || (run.status === 'failed' && run.error)) && (
        <span className="line-clamp-2 break-words text-fg-faint" title={run.error ?? undefined}>
          {reason ?? run.error}
        </span>
      )}
    </li>
  )
}
