// 事项唤醒（docs/multica-learn.md §11.6）在卡上的样子：挂着的规则一行一条（能取消）、唤醒卡写明是哪条规则开的、
// 运行记录和消息上的「唤醒」小标签
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useState } from 'react'
import { AlarmClock, X } from 'lucide-react'
import { IconButton, cn, useToast } from '@/ui'
import type { Channel, ChannelMember, ChannelTask } from '@/data/types'
import type { ChannelWakeup } from '../../../../shared/types/channels'
import { channelActions, useChannels } from './store'
import { isWakeupCard, liveWakeups, recentEndedWakeup, wakeupHead, wakeupMeta, wakeupOrigin } from './wakeupModel'

type Members = ReadonlyMap<string, ChannelMember>

/** 能挂 / 取消唤醒：只有本机频道，归档的只读（团队频道第一版还不支持，docs/multica-learn.md §11.6） */
export const canWakeup = (channel: Pick<Channel, 'scope' | 'archivedAt'> | null | undefined): boolean =>
  !!channel && channel.scope === 'local' && !channel.archivedAt

/** 一条规则：「⏰ 每天 09:00 叫 审查员 · 检查 CI · 下次 明天 09:00 · 截止 11-25 ×」 */
function WakeupRow({
  channelId,
  rule,
  membersById,
  flow,
  editable,
}: {
  channelId: string
  rule: ChannelWakeup
  membersById: Members
  flow: boolean
  editable: boolean
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const now = Date.now()
  const head = wakeupHead(rule, membersById.get(rule.memberId)?.name ?? '?', now, flow)
  const by = membersById.get(rule.by)
  const meta = [
    ...wakeupMeta(rule, now),
    by?.kind === 'agent' ? tr('wakeup.line.byAi', { name: by.name }) : '',
    rule.fired > 0 && rule.when.kind === 'every' ? tr('wakeup.line.fired', { n: rule.fired }) : '',
  ].filter(Boolean)
  const cancel = () => {
    setBusy(true)
    channelActions
      .wakeup(channelId, { op: 'cancel', id: rule.id })
      .catch(e => toast(tr('wakeup.line.cancelFailed', { error: translateMessage((e as Error).message) })))
      .finally(() => setBusy(false))
  }
  return (
    <p data-wakeup={rule.id} className="mt-1 flex min-w-0 items-center gap-1 text-meta text-fg-muted">
      <AlarmClock size={12} strokeWidth={1.75} className="shrink-0 text-accent-fg" aria-hidden />
      <span className="min-w-0 truncate" title={[head, ...meta].join(' · ') + `\n${rule.text}`}>
        {head}
        <span className="text-fg-faint"> · {rule.text}</span>
      </span>
      {meta.length > 0 && <span className="shrink-0 text-fg-faint tabular-nums">· {meta.join(' · ')}</span>}
      {editable && (
        <IconButton
          icon={X}
          label={tr('wakeup.line.cancel')}
          size={18}
          iconSize={11}
          disabled={busy}
          onClick={cancel}
        />
      )}
    </p>
  )
}

/** 挂在这张卡（任务卡 / 流程卡）上的规则；最近一天里失效取消或作废的写一行原因 */
export function WakeupRules({
  channel,
  on,
  membersById,
  flow = false,
  className,
}: {
  channel: Channel | null
  on: string
  membersById: Members
  flow?: boolean
  className?: string
}) {
  useI18n()
  const live = liveWakeups(channel, on)
  const ended = live.length ? null : recentEndedWakeup(channel, on, Date.now())
  if (!channel || (!live.length && !ended)) return null
  const editable = canWakeup(channel)
  return (
    <div data-wakeups={on} className={cn('flex min-w-0 flex-col', className)}>
      {live.map(w => (
        <WakeupRow
          key={w.id}
          channelId={channel.id}
          rule={w}
          membersById={membersById}
          flow={flow}
          editable={editable}
        />
      ))}
      {ended && (
        <p data-wakeup-ended={ended.state} className="mt-1 flex min-w-0 items-center gap-1 text-meta text-fg-faint">
          <AlarmClock size={12} strokeWidth={1.75} className="shrink-0" aria-hidden />
          <span className="min-w-0 truncate" title={ended.text}>
            {ended.state === 'expired'
              ? tr('wakeup.line.expired')
              : tr('wakeup.line.cancelled', { note: translateMessage(ended.endNote) })}
          </span>
        </p>
      )}
    </div>
  )
}

/** 唤醒卡：写明是哪条规则开的、盯着哪张卡（点了跳过去）；规则还活着时那一行也放在这里，能取消 */
export function WakeupOrigin(props: { channel: Channel | null; task: ChannelTask; membersById: Members }) {
  // 只有唤醒卡才订阅频道消息（普通卡不用跟着每条消息的变化重画）
  return isWakeupCard(props.channel, props.task) ? <OriginLine {...props} /> : null
}

function OriginLine({
  channel,
  task,
  membersById,
}: {
  channel: Channel | null
  task: ChannelTask
  membersById: Members
}) {
  useI18n()
  const messages = useChannels(s => s.messages[task.channelId])
  const origin = wakeupOrigin(channel, task, messages)
  if (!origin) return null
  const watched = origin.on ? messages?.find(m => m.id === origin.on) : undefined
  const flow = watched?.kind === 'message' && !!watched.flow
  const title =
    watched?.kind === 'task'
      ? watched.title
      : watched?.kind === 'message' && watched.flow
        ? tr('wakeup.origin.flow', { title: watched.flow.title })
        : null
  const text = title ? tr('wakeup.origin', { title }) : tr('wakeup.origin.unknown')
  return (
    <div data-wakeup-card className="mt-1 flex min-w-0 flex-col">
      {watched ? (
        <button
          type="button"
          onClick={() => void channelActions.focusMessage(task.channelId, watched.id)}
          className="press inline-flex max-w-full items-center gap-1 self-start rounded px-1 text-meta text-fg-muted hover:bg-hover hover:text-fg"
        >
          <AlarmClock size={12} strokeWidth={1.75} className="shrink-0 text-accent-fg" aria-hidden />
          <span className="truncate">{text}</span>
        </button>
      ) : (
        <p className="flex min-w-0 items-center gap-1 text-meta text-fg-muted">
          <AlarmClock size={12} strokeWidth={1.75} className="shrink-0 text-accent-fg" aria-hidden />
          <span className="truncate">{text}</span>
        </p>
      )}
      {channel && origin.rule?.state === 'active' && (
        <WakeupRow
          channelId={channel.id}
          rule={origin.rule}
          membersById={membersById}
          flow={flow}
          editable={canWakeup(channel)}
        />
      )}
    </div>
  )
}

/** 运行记录、消息上的小标签 */
export function WakeupTag({ text, className }: { text: string; className?: string }) {
  return (
    <span
      data-wakeup-tag
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 text-label text-accent-fg',
        className,
      )}
    >
      <AlarmClock size={10} strokeWidth={2} aria-hidden />
      {text}
    </span>
  )
}
