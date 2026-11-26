// 成员卡（docs/ui/channels-member-tools.md §1.3、§1.4，样稿 docs/ui/channels-member-tools-mockup.html）：
// AI 成员用 member_update / member_remove 提议改、移出成员，你点了才生效；改了能改回去，移出能加回来
import { useMemo, useState } from 'react'
import { UserCog, UserMinus } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { Button, cn, useToast } from '@/ui'
import { effortLabel } from '@/features/engine/labels'
import type { AgentMember, ChannelMember, ChannelTextMessage } from '@/data/types'
import type {
  AgentConfig,
  ChannelMemberChange,
  MemberChangeAction,
  MemberChangeFields,
} from '../../../../shared/types/channels'
import { channelActions, useChannels } from './store'
import { AgentDialog } from './ChannelDialogs'

/** 「改回去」「加回来」能点多久（和主进程 MEMBER_UNDO_MS 一样） */
const UNDO_MS = 24 * 3600_000

const fieldText = (k: 'model' | 'effort', v: MemberChangeFields[typeof k]): string =>
  k === 'effort'
    ? v
      ? effortLabel(v as NonNullable<MemberChangeFields['effort']>)
      : tr('channels.memberChange.follow')
    : v || tr('channels.memberChange.follow')

/** 把卡上的值套到成员配置上：「打开设置再改…」的预填 */
function prefilled(config: AgentConfig, to: MemberChangeFields): AgentConfig {
  const settings = { ...config.settings }
  if ('model' in to) settings.model = to.model ?? undefined
  if ('effort' in to) settings.effort = to.effort ?? undefined
  return { ...config, settings, ...(to.instructions !== undefined ? { instructions: to.instructions } : {}) }
}

export function MemberChangeCard({
  message,
  membersById,
  readOnly,
}: {
  message: ChannelTextMessage
  membersById: ReadonlyMap<string, ChannelMember>
  readOnly: boolean
}) {
  useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const ch = message.memberChange as ChannelMemberChange
  const target = membersById.get(ch.memberId)
  const agent = target?.kind === 'agent' ? (target as AgentMember) : null
  const name = target?.name ?? '?'
  const self = ch.memberId === message.authorId
  const channels = useChannels(s => s.channels)
  const allMembers = useChannels(s => s.members)
  const messages = useChannels(s => s.messages[message.channelId])
  const channel = channels.find(c => c.id === message.channelId)

  // 提示：现在的情况（只在等你点时显示）
  const hints = useMemo(() => {
    if (ch.state !== 'open' || !channel) return []
    const out: { text: string; warn?: boolean }[] = []
    const load = channel.load?.[ch.memberId]
    if (ch.op === 'update') {
      const elsewhere = channels
        .filter(c => c.id !== channel.id && !c.archivedAt && c.memberIds.includes(ch.memberId))
        .map(c => `#${c.name}`)
      if (elsewhere.length)
        out.push({ warn: true, text: tr('channels.memberChange.elsewhere', { name, channels: elsewhere.join('、') }) })
      if (agent?.config?.mode === 'shared' && ch.to && ('model' in ch.to || 'effort' in ch.to))
        out.push({ text: tr('channels.memberChange.shared', { name }) })
      else if (load?.running) out.push({ text: tr('channels.memberChange.busy', { name }) })
      else out.push({ text: tr('channels.memberChange.next') })
    } else {
      if (channel.lead === ch.memberId) out.push({ warn: true, text: tr('channels.memberChange.lead', { name }) })
      const steps = (messages ?? []).reduce((n, m) => {
        if (m.kind !== 'message' || !m.flow || m.flow.status === 'done' || m.flow.status === 'stopped') return n
        return n + m.flow.steps.filter(s => s.memberId === ch.memberId && s.status !== 'delivered').length
      }, 0)
      if (steps) out.push({ warn: true, text: tr('channels.memberChange.flow', { name, count: steps }) })
      out.push({
        text: [
          load?.queued ? tr('channels.memberChange.queued', { count: load.queued }) : '',
          load?.running ? tr('channels.memberChange.running') : '',
          tr('channels.memberChange.keep'),
        ]
          .filter(Boolean)
          .join(''),
      })
    }
    return out
  }, [ch, channel, channels, messages, agent, name])

  const act = (action: MemberChangeAction) => {
    setBusy(true)
    channelActions
      .memberChange(message.channelId, message.id, action)
      .catch(e => toast(tr('channels.proposal.failed', { error: translateMessage((e as Error).message) })))
      .finally(() => setBusy(false))
  }

  const rows = ch.op === 'update' ? (['model', 'effort'] as const).filter(k => ch.to && k in ch.to) : []
  const role = ch.op === 'update' && ch.to?.instructions !== undefined
  const canUndo =
    !readOnly && ch.state === 'done' && !ch.adjusted && Date.now() - (ch.decidedAt ?? 0) < UNDO_MS && !!target
  const result =
    ch.state === 'done'
      ? ch.op === 'remove'
        ? tr('channels.memberChange.removed')
        : tr(ch.adjusted ? 'channels.memberChange.adjusted' : 'channels.memberChange.updated')
      : ch.state === 'undone'
        ? tr(ch.op === 'remove' ? 'channels.memberChange.readded' : 'channels.memberChange.reverted')
        : ch.state === 'dismissed'
          ? tr('channels.memberChange.dismissed')
          : ch.state === 'stale'
            ? tr(
                ch.why === 'replaced'
                  ? 'channels.memberChange.replaced'
                  : ch.why === 'gone'
                    ? 'channels.memberChange.gone'
                    : 'channels.memberChange.changed',
                { name },
              )
            : null
  const others = useMemo(
    () =>
      allMembers.filter(
        (m): m is AgentMember =>
          m.kind === 'agent' && !channel?.memberIds.includes(m.id) && m.mine !== false && !m.teamAgentId,
      ),
    [allMembers, channel],
  )

  return (
    <div
      data-member-change={ch.state}
      className={cn(
        'mt-1 flex max-w-[36rem] flex-col gap-1.5 rounded-lg border border-line-card bg-surface px-3 py-2',
        ch.state === 'open' && (ch.op === 'remove' ? 'border-l-2 border-l-danger' : 'border-l-2 border-l-warn'),
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-meta font-medium text-fg-secondary">
        {ch.op === 'remove' ? (
          <UserMinus size={13} strokeWidth={1.5} className="shrink-0" />
        ) : (
          <UserCog size={13} strokeWidth={1.5} className="shrink-0" />
        )}
        <span className="min-w-0 truncate">
          {ch.op === 'remove'
            ? tr('channels.memberChange.removeTitle', { name })
            : self
              ? tr('channels.memberChange.selfTitle')
              : tr('channels.memberChange.updateTitle', { name })}
        </span>
      </div>
      {rows.length > 0 && (
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-ui">
          {rows.map(k => (
            <div key={k} className="contents">
              <span className="text-fg-muted">{tr(`channels.memberChange.field.${k}`)}</span>
              <span className="min-w-0 break-words">
                <span className="text-fg-muted line-through">{fieldText(k, ch.from?.[k] ?? null)}</span>
                <span className="px-1.5 text-fg-faint">→</span>
                <span className="font-medium text-fg">{fieldText(k, ch.to?.[k] ?? null)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {role && (
        <details className="text-meta" open={ch.state === 'open'}>
          <summary className="cursor-pointer text-accent-fg">{tr('channels.memberChange.roleChanged')}</summary>
          <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
            {(['from', 'to'] as const).map(side => (
              <div key={side} className="rounded-md bg-subtle px-2 py-1">
                <span className="block text-label text-fg-muted">
                  {tr(side === 'from' ? 'channels.memberChange.before' : 'channels.memberChange.after')}
                </span>
                <span className="break-words whitespace-pre-wrap text-fg-body">{ch[side]?.instructions}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      <p className="text-meta break-words text-fg-secondary">
        <span className="text-fg-muted">{tr('channels.memberChange.reason')}</span>
        {ch.reason}
      </p>
      {hints.length > 0 && (
        <div className="flex flex-col gap-1">
          {hints.map(h => (
            <span
              key={h.text}
              className={cn(
                'rounded-md px-2 py-0.5 text-meta',
                h.warn ? 'bg-warn/10 text-warn' : 'bg-subtle text-fg-secondary',
              )}
            >
              {h.text}
            </span>
          ))}
        </div>
      )}
      {ch.state === 'open' && !readOnly ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="primary" className="h-7 px-2.5 text-meta" disabled={busy} onClick={() => act('accept')}>
            {tr(ch.op === 'remove' ? 'channels.memberChange.remove' : 'channels.memberChange.apply')}
          </Button>
          <Button className="h-7 px-2.5 text-meta" disabled={busy} onClick={() => act('dismiss')}>
            {tr('channels.proposal.dismiss')}
          </Button>
          {ch.op === 'update' && agent?.config && channel && (
            <Button variant="ghost" className="h-7 px-2.5 text-meta" disabled={busy} onClick={() => setEditing(true)}>
              {tr('channels.memberChange.edit')}
            </Button>
          )}
        </div>
      ) : result ? (
        <span
          className={cn(
            'flex flex-wrap items-baseline gap-x-2 text-meta',
            ch.state === 'done' ? 'text-success' : ch.state === 'stale' ? 'text-warn' : 'text-fg-faint',
          )}
        >
          {result}
          {canUndo && (
            <button
              type="button"
              className="text-accent-fg hover:underline disabled:opacity-50"
              disabled={busy}
              onClick={() => act('undo')}
            >
              {tr(ch.op === 'remove' ? 'channels.memberChange.readd' : 'channels.memberChange.revert')}
            </button>
          )}
        </span>
      ) : null}
      {editing && agent?.config && channel && (
        <AgentDialog
          channel={channel}
          editing={prefilled(agent.config, ch.to ?? {})}
          others={others}
          onClose={() => setEditing(false)}
          onSaved={() => channelActions.memberChange(message.channelId, message.id, 'adjusted')}
        />
      )}
    </div>
  )
}
