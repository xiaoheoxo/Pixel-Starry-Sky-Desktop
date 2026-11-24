// 频道的「任务」页（docs/ui/channels-unify.md §2）：这个频道里的任务卡按状态分组；只看已经读进来的消息，能往前翻
import { useMemo, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage, type TranslationKey } from '../../i18n/core'
import { cn, Spinner, useToast } from '@/ui'
import { SEGMENT_TRACK, segmentItem } from '@/ui/Segmented'
import type { Channel, ChannelMember, ChannelMessage } from '@/data/types'
import { ChannelTaskCard, type TaskCardActions } from './ChannelTaskCard'
import { groupTasks, type TaskFilter, type TaskGroupId } from './unifyModel'

const GROUP_LABEL: Record<TaskGroupId, TranslationKey> = {
  mine: 'unify.tasks.mine',
  running: 'unify.tasks.running',
  queued: 'unify.tasks.queued',
  others: 'unify.tasks.others',
  ended: 'unify.tasks.ended',
}
const FILTERS: readonly TaskFilter[] = ['all', 'sent', 'received']

export function ChannelTasks({
  channel,
  messages,
  members,
  more,
  onLoadOlder,
  taskActions,
}: {
  channel: Channel
  messages: readonly ChannelMessage[]
  members: readonly ChannelMember[]
  /** 前面还有更早的消息没读进来 */
  more?: boolean
  onLoadOlder?: () => Promise<void>
  taskActions: TaskCardActions
}) {
  useI18n()
  const toast = useToast()
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [loading, setLoading] = useState(false)
  const team = channel.scope === 'team'
  const selfId = taskActions.selfId ?? null
  const groups = useMemo(() => groupTasks(messages, selfId, team ? filter : 'all'), [messages, selfId, team, filter])
  const membersById = useMemo(() => new Map(members.map(m => [m.id, m])), [members])
  const loadOlder = () => {
    if (!onLoadOlder || loading) return
    setLoading(true)
    void onLoadOlder()
      .catch((e: unknown) =>
        toast(tr('channels.loadOlderFailed', { error: translateMessage((e as Error)?.message ?? String(e)) })),
      )
      .finally(() => setLoading(false))
  }
  return (
    <div
      data-channel-tasks=""
      aria-label={tr('unify.tab.tasks')}
      className="conversation-scroller selectable relative min-h-0 flex-1 overflow-y-auto"
    >
      <div className="conversation-inset conversation-reading flex flex-col gap-5 pt-5 pb-6">
        {team && (
          <div role="radiogroup" aria-label={tr('unify.tasks.filter')} className={cn(SEGMENT_TRACK, 'self-start')}>
            {FILTERS.map(f => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                data-task-filter={f}
                onClick={() => setFilter(f)}
                className={cn(segmentItem(filter === f), 'px-2.5 text-meta')}
              >
                {tr(`unify.tasks.filter.${f}`)}
              </button>
            ))}
          </div>
        )}
        {groups.length === 0 && (
          <p className="py-10 text-center text-list text-fg-faint">
            {tr(filter === 'all' || !team ? 'unify.tasks.empty' : 'unify.tasks.emptyFiltered')}
          </p>
        )}
        {groups.map(g => (
          <section key={g.id} data-task-group={g.id} className="flex flex-col gap-2">
            <h3 className={cn('text-label font-medium', g.id === 'mine' ? 'text-warn' : 'text-fg-muted')}>
              {tr(GROUP_LABEL[g.id], { count: g.tasks.length })}
            </h3>
            {g.tasks.map(task => (
              <ChannelTaskCard key={task.id} task={task} membersById={membersById} {...taskActions} />
            ))}
          </section>
        ))}
        {more && (
          <div className="flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={loadOlder}
              disabled={loading}
              className="inline-flex h-7 items-center gap-2 rounded-md px-3 text-meta text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-60"
            >
              {loading && <Spinner size={11} />}
              {tr('channels.loadOlder')}
            </button>
            <p className="text-meta text-fg-faint">{tr('unify.tasks.partial')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
