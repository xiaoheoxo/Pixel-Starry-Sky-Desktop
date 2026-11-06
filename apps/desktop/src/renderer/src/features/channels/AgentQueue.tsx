import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { Button, IconButton, cn, useToast } from '@/ui'
import type { AgentMember, ChannelTask } from '@/data/types'
import { channelActions } from './store'

/** 成员面板排队控制（docs/ui/channels-local-ai.md #5 / 样稿 scratch/.../channel-queue-control） */
export function AgentQueue({
  member,
  tasks,
  onFocus,
}: {
  member: AgentMember
  /** 该成员在本频道的进行中 + 排队中（不含停下等你的接力） */
  tasks: readonly ChannelTask[]
  onFocus: (taskId: string) => void
}) {
  useI18n()
  const toast = useToast()
  const running = tasks.filter(t => t.status === 'running' || t.status === 'waiting' || t.status === 'approval')
  const queued = tasks
    .filter(t => t.status === 'queued' && !t.relay?.held)
    .slice()
    .sort((a, b) => (a.ahead ?? 0) - (b.ahead ?? 0) || a.at - b.at)
  const items = [...running, ...queued]
  const fail = (e: unknown) =>
    toast(tr('channels.task.actionFailed', { error: translateMessage((e as Error).message) }))

  if (!items.length) {
    return (
      <div className="mt-1.5 rounded-md border border-dashed border-line-subtle px-2 py-1.5">
        <div className="flex items-center gap-1 text-meta text-fg-faint">
          <span className="font-medium text-fg-muted">{tr('channels.queue.title')}</span>
          <span className="ml-auto">{tr('channels.queue.idle')}</span>
        </div>
        <p className="mt-0.5 text-meta text-fg-faint">{tr('channels.queue.empty', { name: member.name })}</p>
      </div>
    )
  }

  const hint = queued.length ? tr('channels.queue.hint', { count: queued.length }) : tr('channels.queue.runningOnly')

  return (
    <div className="mt-1.5 overflow-hidden rounded-md border border-line-subtle">
      <div className="flex items-center gap-1 border-b border-line-subtle bg-subtle px-2 py-1 text-meta">
        <span className="font-medium text-fg-muted">{tr('channels.queue.title')}</span>
        <span className="ml-auto text-fg-faint">{hint}</span>
      </div>
      <ul className="flex flex-col">
        {items.map((task, idx) => {
          const isRunning = task.status !== 'queued'
          const qIndex = queued.findIndex(t => t.id === task.id)
          const canUp = !isRunning && qIndex > 0
          const canDown = !isRunning && qIndex >= 0 && qIndex < queued.length - 1
          const canFirst = !isRunning && qIndex > 0
          const canWithdraw = !isRunning
          return (
            <li
              key={task.id}
              className={cn(
                'flex items-start gap-2 border-b border-line-subtle px-2 py-1.5 last:border-b-0',
                isRunning && 'bg-accent-soft/30',
              )}
            >
              <span className="mt-0.5 w-4 shrink-0 text-center text-meta text-fg-faint">
                {isRunning ? '›' : idx + 1}
              </span>
              <button type="button" onClick={() => onFocus(task.id)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-meta font-medium text-fg">{task.title}</div>
                <div className="mt-0.5 text-meta text-fg-faint">
                  {isRunning ? tr('channels.queue.runningLock') : tr('channels.queue.position', { n: qIndex + 1 })}
                </div>
              </button>
              <div className="flex shrink-0 flex-col items-end gap-0.5">
                <div className="flex gap-0.5">
                  <IconButton
                    icon={ArrowUp}
                    label={tr('channels.queue.up')}
                    size={22}
                    iconSize={12}
                    disabled={!canUp}
                    onClick={() => void channelActions.queueControl(task.id, 'up').catch(fail)}
                  />
                  <IconButton
                    icon={ArrowDown}
                    label={tr('channels.queue.down')}
                    size={22}
                    iconSize={12}
                    disabled={!canDown}
                    onClick={() => void channelActions.queueControl(task.id, 'down').catch(fail)}
                  />
                </div>
                <div className="flex gap-0.5">
                  <Button
                    variant="ghost"
                    className="h-6 px-1.5 text-meta"
                    disabled={!canFirst}
                    title={tr('channels.queue.firstTitle')}
                    onClick={() => void channelActions.queueControl(task.id, 'first').catch(fail)}
                  >
                    {tr('channels.queue.first')}
                  </Button>
                  <IconButton
                    icon={X}
                    label={tr('channels.queue.withdraw')}
                    size={22}
                    iconSize={12}
                    disabled={!canWithdraw}
                    className="text-danger"
                    onClick={() => void channelActions.task(task.id, 'cancel').catch(fail)}
                  />
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 从频道消息里挑出该成员可调序的活（进行中 + 排队） */
export function memberQueueTasks(
  messages: readonly { kind: string; id: string }[] | undefined,
  memberId: string,
): ChannelTask[] {
  if (!messages) return []
  return messages.filter(
    (m): m is ChannelTask =>
      m.kind === 'task' &&
      (m as ChannelTask).assigneeId === memberId &&
      ['running', 'waiting', 'approval', 'queued'].includes((m as ChannelTask).status),
  )
}
