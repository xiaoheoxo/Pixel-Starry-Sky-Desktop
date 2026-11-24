// 「正在做」（docs/ui/channels-unify.md §2）：所有频道里每个 AI 成员手上的活，一个成员一格。代替频道页的时间线显示
import { useMemo, useState } from 'react'
import { Square, X } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { Button, cn, IconButton, Spinner, useToast } from '@/ui'
import { OPEN_SESSION_EVENT } from '@/features/engine'
import type { Channel } from '@/data/types'
import { channelActions, channelsLive, useChannels } from './store'
import { useNeeds } from './needs'
import { agentMeta, MemberAvatar } from './ChannelMessage'
import { STATUS_LABEL } from './ChannelTaskCard'
import { doingBoxes, type DoingBox, type DoingItem } from './unifyModel'

const openSession = (sessionId: string) =>
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId } }))

/** 跳到频道里那张卡；没有卡（团队的成员只知道在哪个频道）就进频道 */
const show = (channelId: string, taskId?: string) => {
  channelActions.openNeeds(false)
  if (taskId) void channelActions.focusMessage(channelId, taskId)
  else channelActions.select(channelId)
}

const small = 'h-7 px-2.5 text-meta'

function ChannelLinks({ channels }: { channels: readonly Channel[] }) {
  return (
    <>
      {channels.map((c, i) => (
        <span key={c.id}>
          {i > 0 && tr('channels.composer.nameSep')}
          <button type="button" className="press rounded-sm hover:text-fg hover:underline" onClick={() => show(c.id)}>
            # {c.name}
          </button>
        </span>
      ))}
    </>
  )
}

function ItemRow({ item, channel }: { item: DoingItem; channel: Channel | undefined }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const stop = () => {
    setBusy(true)
    channelActions
      .task(item.taskId, 'stop')
      .catch((e: unknown) => toast(tr('channels.task.actionFailed', { error: translateMessage((e as Error).message) })))
      .finally(() => setBusy(false))
  }
  const waiting = item.status === 'waiting'
  return (
    <li
      data-doing-item={item.taskId}
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line-subtle bg-surface px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-meta">
        {item.status === 'running' && <Spinner size={11} className="shrink-0 text-accent-fg" mono />}
        <span className={cn('shrink-0 font-medium', waiting ? 'text-warn' : 'text-accent-fg')}>
          {tr(STATUS_LABEL[item.status])}
        </span>
        {channel && <span className="min-w-0 truncate text-fg-faint"># {channel.name}</span>}
      </div>
      <p className="text-list break-words text-fg">{item.title}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button className={small} onClick={() => show(item.channelId, item.taskId)}>
          {tr('needs.view')}
        </Button>
        {item.sessionId && (
          <Button variant="ghost" className={small} onClick={() => openSession(item.sessionId!)}>
            {tr('needs.openSession')}
          </Button>
        )}
        {channelsLive && !waiting && (
          <Button variant="ghost" icon={Square} className={small} disabled={busy} onClick={stop}>
            {tr('channels.task.stop')}
          </Button>
        )}
      </div>
    </li>
  )
}

function Box({ box, channels }: { box: DoingBox; channels: readonly Channel[] }) {
  const { member, items } = box
  const team = !!member.teamAgentId
  const busy = team || items.length > 0
  return (
    <li data-doing-box={member.id} className="flex min-w-0 flex-col gap-2 rounded-xl bg-subtle p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <MemberAvatar member={member} size={28} />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-baseline gap-1.5 text-list font-medium text-fg">
            <span className="min-w-0 truncate">{member.name}</span>
            {member.mine === false && member.ownerName && (
              <span className="shrink-0 text-meta font-normal text-fg-faint">
                {tr('team.panel.agentOf', { owner: member.ownerName })}
              </span>
            )}
          </p>
          <p className="truncate text-meta text-fg-faint">
            {[agentMeta(member), member.project].filter(Boolean).join(' · ')}
          </p>
        </div>
        <span className={cn('shrink-0 text-meta', busy ? 'text-accent-fg' : 'text-fg-faint')}>
          {team
            ? tr(member.status === 'waiting' ? 'channels.status.waiting' : 'channels.status.running')
            : items.length > 0
              ? tr('unify.doing.count', { count: items.length })
              : tr('channels.status.idle')}
        </span>
      </div>
      {team ? (
        <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line-subtle bg-surface px-3 py-2">
          <p className="text-list break-words text-fg">{member.task || tr('unify.doing.noTitle')}</p>
          <p className="text-meta text-fg-faint">
            <ChannelLinks channels={box.channels} />
          </p>
        </div>
      ) : items.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {items.map(it => (
            <ItemRow key={it.taskId} item={it} channel={channels.find(c => c.id === it.channelId)} />
          ))}
        </ul>
      ) : (
        <p className="text-meta text-fg-faint">
          {box.channels.length > 0 ? (
            <>
              {tr('unify.doing.in')} <ChannelLinks channels={box.channels} />
            </>
          ) : (
            tr('unify.doing.noChannel')
          )}
        </p>
      )}
    </li>
  )
}

export function DoingView() {
  useI18n()
  const members = useChannels(s => s.members)
  const channels = useChannels(s => s.channels)
  const { needs, following } = useNeeds()
  const { mine, team } = useMemo(
    () => doingBoxes(members, channels, following, needs),
    [members, channels, following, needs],
  )
  const grid = 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3'
  return (
    <section
      aria-label={tr('unify.doing.title')}
      data-doing-view=""
      className="conversation-view flex min-w-[360px] flex-1 flex-col"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 px-5">
        <h2 className="shrink-0 text-ui font-medium text-fg">{tr('unify.doing.title')}</h2>
        <p className="min-w-0 flex-1 truncate text-meta text-fg-faint">{tr('unify.doing.hint')}</p>
        <IconButton
          icon={X}
          label={tr('unify.doing.close')}
          size={28}
          iconSize={15}
          onClick={() => channelActions.openNeeds(false)}
        />
      </div>
      <div className="selectable min-h-0 flex-1 overflow-y-auto px-5 pb-6 [scrollbar-width:thin]">
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h3 className="text-label font-medium text-fg-muted">{tr('unify.doing.mine', { count: mine.length })}</h3>
            {mine.length === 0 ? (
              <p className="py-4 text-list text-fg-faint">{tr('unify.doing.empty')}</p>
            ) : (
              <ul className={grid}>
                {mine.map(b => (
                  <Box key={b.member.id} box={b} channels={channels} />
                ))}
              </ul>
            )}
          </div>
          {team.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-label font-medium text-fg-muted">{tr('unify.doing.team', { count: team.length })}</h3>
              <ul className={grid}>
                {team.map(b => (
                  <Box key={b.member.id} box={b} channels={channels} />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
