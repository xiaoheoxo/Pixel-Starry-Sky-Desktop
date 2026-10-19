import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
// 子智能体的小框（docs/ui/subagent-box.md §3）：派发时一个，后台子智能体完成时再来一个；点开智能体追踪里的详情
import { Bot, ChevronRight, Terminal, Workflow, type LucideIcon } from 'lucide-react'
import type { AgentRuns, Item, NoticeTask } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { StatusDot, type DotStatus } from './StatusDot'
import { RUN_STATE_LABEL, formatDuration } from './agentTrace'
import { boxElapsed, completionBox, dispatchBox, type BoxIcon, type BoxModel, type BoxState } from './subagentBoxModel'
import { useOpenTrace } from './trace'
import { rowLook, useLiveOwned } from './liveOwner'

const ICON: Record<BoxIcon, LucideIcon> = { bot: Bot, workflow: Workflow, terminal: Terminal }

const DOT: Record<BoxState, DotStatus> = {
  running: 'running',
  approval: 'running',
  done: 'completed',
  failed: 'failed',
  stopped: 'interrupted',
  queued: 'pending',
}

/** 每秒走一次的当前时间，只在 active 时转 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function BoxView({ model }: { model: BoxModel }) {
  useI18n()
  const openTrace = useOpenTrace()
  const running = model.state === 'running' || model.state === 'approval'
  // 底部状态行在转时小框的圆点不再脉冲；等你批准时本来就没在干活，也不脉冲
  const pulse = rowLook(model.state === 'running', useLiveOwned()).pulse
  const now = useNow(running && model.startedAt > 0)
  const time = boxElapsed(model, now)
  const Icon = ICON[model.icon]
  const label = model.label || tr(model.icon === 'workflow' ? 'subagent.box.workflow' : 'subagent.box.untitled')
  const clickable = !!openTrace && !!model.target
  const status = model.state === 'approval' ? tr('subagent.box.approval') : RUN_STATE_LABEL[model.state]
  return (
    <button
      type="button"
      data-subagent-box={model.state}
      aria-busy={running || undefined}
      disabled={!clickable}
      title={model.summary || label}
      onClick={() => model.target && openTrace?.(model.target)}
      className={cn(
        'flex h-9 w-fit max-w-full min-w-[min(320px,100%)] items-center gap-2 rounded-lg border border-line bg-surface px-3 text-left text-list text-fg-secondary',
        clickable ? 'press hover:bg-hover' : 'cursor-default',
      )}
    >
      <Icon size={15} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
      <span data-box-label className="min-w-0 flex-1 truncate text-fg">
        {label}
      </span>
      {model.agents !== null && (
        <span className="shrink-0 text-meta text-fg-muted">{tr('subagent.box.agents', { n: model.agents })}</span>
      )}
      {model.model && (
        <span className="shrink-0 text-meta text-fg-muted" title={model.fullModel}>
          {model.model}
        </span>
      )}
      <span
        className={cn(
          'flex shrink-0 items-center gap-1 text-meta tabular-nums',
          model.state === 'approval' ? 'text-warn' : model.state === 'failed' ? 'text-danger' : 'text-fg-muted',
        )}
      >
        <StatusDot status={DOT[model.state]} still={!pulse} />
        {status}
        {time > 0 && <span className="text-fg-faint">{formatDuration(time)}</span>}
      </span>
      {clickable && <ChevronRight size={15} strokeWidth={1.5} className="shrink-0 text-fg-faint" />}
    </button>
  )
}

/** 派发小框：主智能体的 Agent / Task / Workflow 调用 */
export function SubagentDispatchBox({
  item,
  runs,
  approval,
}: {
  item: Extract<Item, { kind: 'tool' }>
  runs: AgentRuns | undefined
  approval: boolean
}) {
  return <BoxView model={dispatchBox(item, runs, approval)} />
}

/** 完成小框：后台任务结束的提示 */
export function SubagentCompletionBox({ task, runs }: { task: NoticeTask; runs: AgentRuns | undefined }) {
  return <BoxView model={completionBox(task, runs)} />
}
