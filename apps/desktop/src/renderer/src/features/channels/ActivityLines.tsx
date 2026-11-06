import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import type { ReactNode } from 'react'
import { Check, Minus, X } from 'lucide-react'
import { cn, DiffStat, Spinner } from '@/ui'
import type { ChannelTask } from '@/data/types'
import { useNow } from '@/features/session/live/stepClock'
import { durText } from './format'
import { taskElapsed, type ActivityLine, type ActivityView } from './taskActivity'

function LineIcon({ state }: { state: ActivityLine['state'] }) {
  if (state === 'running') return <Spinner size={10} />
  if (state === 'failed') return <X size={11} strokeWidth={2} className="text-danger" />
  if (state === 'stopped') return <Minus size={11} strokeWidth={2} className="text-fg-faint" />
  return <Check size={11} strokeWidth={2} className="text-fg-faint" />
}

function Line({ line, now }: { line: ActivityLine; now: number }) {
  const running = line.state === 'running'
  const elapsed = line.since && now - line.since.at >= line.since.min ? now - line.since.at : null
  return (
    <li
      title={line.full || undefined}
      className={cn('flex min-w-0 items-center gap-1.5', running ? 'text-fg-secondary' : 'text-fg-muted')}
    >
      <span className="flex w-3 shrink-0 justify-center">
        <LineIcon state={line.state} />
      </span>
      <span className={cn(line.object ? 'shrink-0' : 'min-w-0 truncate')}>{line.verb}</span>
      {/* 对象可以省略，后面的行数、退出码、用时一直看得见 */}
      {line.object && <span className={cn('min-w-0 truncate font-mono', running && 'text-fg')}>{line.object}</span>}
      {!!(line.added || line.removed) && <DiffStat added={line.added ?? 0} removed={line.removed ?? 0} />}
      {line.exitCode !== undefined && (
        <span className="shrink-0 text-danger tabular-nums">
          {tr('progressLine.exitCode', { code: line.exitCode })}
        </span>
      )}
      {line.inner && <span className="min-w-0 truncate text-fg-faint">· {line.inner}</span>}
      {elapsed !== null && <span className="shrink-0 text-fg-faint tabular-nums">· {durText(elapsed)}</span>}
      {line.spent !== undefined && <span className="shrink-0 text-fg-faint tabular-nums">· {durText(line.spent)}</span>}
    </li>
  )
}

/** 模型在做什么（docs/ui/channels-live-activity.md）：最近一句 + 做完的几步 + 现在 */
export function ActivityLines({
  view,
  className,
  children,
}: {
  view: ActivityView
  className?: string
  /** 放在最后一行下面（失败时的重试、打开会话） */
  children?: ReactNode
}) {
  useI18n()
  const now = useNow(view.lines.some(l => l.since))
  const { head } = view
  return (
    // 时间线是 role="log"，每一步都念出来太吵
    <div aria-live="off" data-task-activity className={cn('min-w-0 text-meta leading-5', className)}>
      {head && (
        <p title={head.text} className={cn('truncate', head.kind === 'error' ? 'text-danger' : 'text-fg-secondary')}>
          {head.progress && <span className="mr-1.5 text-fg-muted tabular-nums">{head.progress}</span>}
          {head.text}
        </p>
      )}
      {view.lines.length > 0 && (
        <ol>
          {view.lines.map(line => (
            <Line key={line.id} line={line} now={now} />
          ))}
        </ol>
      )}
      {children}
    </div>
  )
}

/** 状态条上的总用时，自己每秒刷新，不带着整张卡一起重绘 */
export function TaskElapsed({ task }: { task: ChannelTask }) {
  useI18n()
  const now = useNow(task.status === 'running')
  const ms = taskElapsed(task, now)
  return ms === null ? null : <span className="font-normal opacity-80 tabular-nums">· {durText(ms)}</span>
}
