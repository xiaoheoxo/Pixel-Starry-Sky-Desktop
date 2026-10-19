import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage, type TranslationKey } from '../../i18n/core'
import { useState, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Bot,
  ChevronDown,
  Ellipsis,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react'
import { Button, cn, IconButton, Select, Spinner, useComingSoon, useToast } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { relativeTime } from '@/features/engine'
import type { AgentMember, Channel, ChannelAgentStatus, ChannelMember, HumanMember } from '@/data/types'
import type { AgentConfig, AgentPolicy, ChannelNotify, ChannelTaskStatus } from '../../../../shared/types/channels'
import { agentMeta, MemberAvatar } from './ChannelMessage'
import { AgentDialog, ChannelDialog } from './ChannelDialogs'
import { channelActions, channelsLive, useChannels } from './store'
import { AddTeamAgentDialog, TeamSettingsDialog } from './TeamDialog'
import { PresenceAvatar, roleLabel } from './TeamParts'
import { formatLastSeen } from './format'
import { canAddAgent, canManageTeam, myRole, onlineCount } from './teamModel'

const STATUS_LABEL: Record<ChannelAgentStatus, TranslationKey> = {
  idle: 'channels.status.idle',
  running: 'channels.status.running',
  waiting: 'channels.status.waiting',
  offline: 'channels.status.offline',
}
const STATUS_DOT: Record<Exclude<ChannelAgentStatus, 'running'>, string> = {
  idle: 'bg-fg-faint',
  waiting: 'bg-warn',
  offline: 'bg-fg-faint',
}
const TASK_LABEL: Record<ChannelTaskStatus, TranslationKey> = {
  queued: 'channels.task.queued',
  approval: 'team.task.approvalShort',
  running: 'channels.task.running',
  waiting: 'channels.task.waiting',
  done: 'channels.task.done',
  failed: 'channels.task.failed',
  stopped: 'channels.task.stopped',
}

const NOTIFY_OPTIONS: readonly ChannelNotify[] = ['all', 'important', 'mute']

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 text-label font-medium text-fg-muted">{title}</h3>
      <div className="flex flex-col gap-px">{children}</div>
    </section>
  )
}

/**
 * 置顶的消息（docs/ui/channels-local-ai.md §3.1 #9）：派活时作为资料带上。只列读进来了的；
 * 点一条跳到时间线上那条消息，右边可以取消置顶
 */
function PinnedList({ channel, members }: { channel: Channel; members: readonly ChannelMember[] }) {
  useI18n()
  const toast = useToast()
  const messages = useChannels(s => s.messages[channel.id])
  const ids = channel.pinned ?? []
  if (!ids.length) return null
  const byId = new Map((messages ?? []).map(m => [m.id, m]))
  const name = (id: string) => members.find(m => m.id === id)?.name ?? '?'
  return (
    <Section title={tr('channels.members.pinned', { count: ids.length })}>
      <p className="px-2 pb-1 text-meta text-fg-faint">{tr('channels.members.pinnedHint')}</p>
      {ids.map(id => {
        const m = byId.get(id)
        const text = m?.kind === 'message' ? m.text.replace(/\s+/g, ' ').trim() : null
        return (
          <div
            key={id}
            data-pinned-item={id}
            className="group/pin flex min-w-0 items-center gap-1 rounded-md hover:bg-hover"
          >
            <button
              type="button"
              disabled={!text}
              onClick={() => void channelActions.focusMessage(channel.id, id)}
              className="press flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left disabled:cursor-default"
            >
              <Pin size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg-faint" />
              {text && m?.kind === 'message' ? (
                <span className="line-clamp-2 min-w-0 flex-1 text-meta break-words text-fg-secondary">
                  <span className="text-fg-muted">{name(m.authorId)}：</span>
                  {text}
                </span>
              ) : (
                <span className="min-w-0 flex-1 text-meta text-fg-faint">{tr('channels.members.pinnedOld')}</span>
              )}
            </button>
            {channel.scope === 'local' && !channel.archivedAt && (
              <IconButton
                icon={PinOff}
                label={tr('channels.unpin')}
                size={24}
                iconSize={12}
                className="mr-1 shrink-0 opacity-0 group-hover/pin:opacity-100 focus-visible:opacity-100"
                onClick={() =>
                  void channelActions
                    .pin(channel.id, id, false)
                    .catch(e => toast(tr('channels.pinFailed', { error: translateMessage((e as Error).message) })))
                }
              />
            )}
          </div>
        )
      })}
    </Section>
  )
}

function HumanRow({ member, team }: { member: HumanMember; team: boolean }) {
  useI18n()
  const online = !!member.online || !!member.you
  const seen = team && !online ? formatLastSeen(member.lastSeenAt, Date.now()) : null
  const role = !member.role
    ? null
    : team
      ? roleLabel(member.role)
      : tr(member.role === 'owner' ? 'channels.role.owner' : 'channels.role.member')
  return (
    <div className="flex h-9 min-w-0 items-center gap-2.5 rounded-md px-2">
      {team ? (
        <PresenceAvatar name={member.name} online={online} size={24} />
      ) : (
        <MemberAvatar member={member} size={24} />
      )}
      <span className="min-w-0 truncate text-list text-fg">{member.name}</span>
      {member.you && <span className="shrink-0 text-meta text-fg-muted">{tr('channels.youSuffix')}</span>}
      {(role || seen) && (
        <span className="ml-auto shrink-0 text-meta text-fg-faint">{[role, seen].filter(Boolean).join(' · ')}</span>
      )}
    </div>
  )
}

/** 第 3 行：当前任务（另有 N 项排队），空闲时上一项的结果 */
function agentLine(member: AgentMember, now: number): string {
  if (member.task)
    return member.queued ? `${member.task} · ${tr('channels.members.queued', { count: member.queued })}` : member.task
  if (member.status === 'idle' && member.last)
    return tr('channels.members.last', {
      status: tr(TASK_LABEL[member.last.status]),
      time: relativeTime(member.last.at, now),
    })
  return tr(STATUS_LABEL[member.status])
}

/** 档案（docs/ui/channels-phase-b.md §8）：职责、工作方式、最近 30 天、目录 */
function AgentDetails({ member }: { member: AgentMember }) {
  useI18n()
  const config = member.config
  if (!config) return null
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded-md bg-subtle px-2 py-1.5 text-meta">
      {config.instructions.trim() && (
        <>
          <dt className="text-fg-faint">{tr('channels.members.instructions')}</dt>
          <dd className="line-clamp-3 min-w-0 break-words text-fg-secondary">{config.instructions}</dd>
        </>
      )}
      <dt className="text-fg-faint">{tr('channels.members.mode')}</dt>
      <dd className="text-fg-secondary">
        {tr(config.mode === 'shared' ? 'channels.agent.mode.shared' : 'channels.agent.mode.perTask')}
      </dd>
      {member.stats && <dd className="col-span-2 text-fg-muted">{tr('channels.members.stats', member.stats)}</dd>}
    </dl>
  )
}

function AgentRow({
  member,
  live,
  team,
  canRemoveOthers,
  readOnly = false,
  onOpenSession,
  onEdit,
  onRemove,
  onPolicy,
}: {
  member: AgentMember
  live: boolean
  /** 团队频道 */
  team: boolean
  /** 归档的频道：不能移出成员（成员是全局的，照常能改） */
  readOnly?: boolean
  /** 所有者能把别人的 AI 成员移出频道 */
  canRemoveOthers: boolean
  onOpenSession: (id: string) => void
  onEdit: (config: AgentConfig) => void
  onRemove: (member: AgentMember) => void
  onPolicy: (member: AgentMember, policy: AgentPolicy) => void
}) {
  useI18n()
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const line = agentLine(member, Date.now())
  const status = tr(STATUS_LABEL[member.status])
  // 别人的 AI 成员：只读，没有「打开会话」和档案
  const foreign = team && member.mine === false
  const actions: MenuAction[] = foreign
    ? [{ label: tr('channels.members.remove'), icon: UserMinus, danger: true, run: () => onRemove(member) }]
    : [
        ...(member.config
          ? [{ label: tr('channels.members.edit'), icon: Pencil, run: () => onEdit(member.config!) }]
          : []),
        ...(member.sessionId
          ? [{ label: tr('channels.openSession'), icon: ArrowUpRight, run: () => onOpenSession(member.sessionId!) }]
          : []),
        ...(readOnly
          ? []
          : [
              {
                label: tr('channels.members.remove'),
                icon: UserMinus,
                danger: true,
                separator: true,
                run: () => onRemove(member),
              },
            ]),
      ]
  return (
    <div
      className={cn(
        'group/agent flex min-w-0 gap-2.5 rounded-md px-2 py-2 hover:bg-hover',
        member.status === 'offline' && 'opacity-60',
      )}
    >
      <span className="relative mt-0.5 h-fit shrink-0 self-start">
        <MemberAvatar member={member} size={28} />
        {member.status !== 'running' && (
          <span
            aria-hidden
            className={cn(
              'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface',
              STATUS_DOT[member.status],
            )}
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        {live && member.config && !foreign ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={tr('channels.members.details', { name: member.name })}
            onClick={() => setOpen(v => !v)}
            className="flex max-w-full min-w-0 items-center gap-1 text-left text-list font-medium text-fg"
          >
            <span className="truncate">{member.name}</span>
            <ChevronDown
              size={12}
              className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-180')}
            />
          </button>
        ) : (
          <div className="flex min-w-0 items-baseline gap-1 text-list font-medium text-fg">
            <span className="truncate">{member.name}</span>
            {foreign && member.ownerName && (
              <span className="shrink-0 text-meta font-normal text-fg-faint">
                · {tr('team.panel.agentOf', { owner: member.ownerName })}
              </span>
            )}
          </div>
        )}
        <div className="truncate text-meta text-fg-faint">
          {[agentMeta(member), member.project].filter(Boolean).join(' · ')}
        </div>
        <div
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-meta',
            member.status === 'waiting' ? 'text-warn' : 'text-fg-muted',
          )}
        >
          {member.status === 'running' && <Spinner size={11} />}
          <span className="min-w-0 truncate" title={member.task ? `${status} · ${line}` : line}>
            {line}
          </span>
        </div>
        {member.warning && <div className="text-meta text-warn">{translateMessage(member.warning)}</div>}
        {!!member.sharesDirWith?.length && (
          <div className="text-meta text-fg-faint">
            {tr('channels.members.sharesDir', { names: member.sharesDirWith.join('、') })}
          </div>
        )}
        {team && member.mine !== false && member.policy && (
          <div className="mt-1 flex items-center gap-2 text-meta text-fg-muted">
            <span className="shrink-0">{tr('team.panel.policyLabel')}</span>
            <Select
              label={tr('team.panel.policyLabel')}
              value={member.policy}
              options={[
                { value: 'approve', label: tr('team.policy.approve') },
                { value: 'team', label: tr('team.policy.team') },
              ]}
              onChange={policy => onPolicy(member, policy)}
              className="h-7 min-w-0 flex-1"
            />
          </div>
        )}
        {open && <AgentDetails member={member} />}
      </div>
      {foreign && !canRemoveOthers ? null : live ? (
        <IconButton
          icon={Ellipsis}
          label={tr('channels.members.menu', { name: member.name })}
          size={26}
          iconSize={14}
          className="shrink-0 opacity-0 group-hover/agent:opacity-100 focus-visible:opacity-100"
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.right - 180, y: r.bottom + 4 })
          }}
        />
      ) : (
        member.sessionId && (
          <IconButton
            icon={ArrowUpRight}
            label={tr('channels.openSession')}
            size={26}
            iconSize={14}
            className="shrink-0"
            onClick={() => onOpenSession(member.sessionId!)}
          />
        )
      )}
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={tr('channels.members.menu', { name: member.name })}
          actions={actions}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** 成员面板（docs/ui/channels.md §7，Phase B 见 channels-phase-b.md §8）：频道信息、真人成员、AI 成员 */
export function ChannelMembers({
  channel,
  members,
  allMembers,
  onClose,
  onOpenSession,
}: {
  channel: Channel
  members: readonly ChannelMember[]
  /** 全部成员（「从已有成员添加」用） */
  allMembers: readonly ChannelMember[]
  onClose: () => void
  onOpenSession: (sessionId: string) => void
}) {
  useI18n()
  const comingSoon = useComingSoon()
  const toast = useToast()
  const live = channelsLive
  const [dialog, setDialog] = useState<
    | { kind: 'agent'; editing: AgentConfig | null }
    | { kind: 'channel' }
    | { kind: 'delete' }
    | { kind: 'remove'; member: AgentMember }
    | { kind: 'policy'; member: AgentMember }
    | { kind: 'addTeamAgent' }
    | { kind: 'invite' }
    | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [channelMenu, setChannelMenu] = useState<{ x: number; y: number } | null>(null)
  const humans = members.filter((m): m is HumanMember => m.kind === 'human')
  const agents = members.filter((m): m is AgentMember => m.kind === 'agent')
  // 可以加进来的：我自己的全局 AI 成员（别人的、团队频道里登记的不算）
  const others = allMembers.filter(
    (m): m is AgentMember =>
      m.kind === 'agent' && !channel.memberIds.includes(m.id) && m.mine !== false && !m.teamAgentId,
  )
  const team = channel.scope === 'team'
  const role = useChannels(s => myRole(s.teams, channel.teamId))
  const teamName = useChannels(s => s.teams.find(t => t.id === channel.teamId)?.name ?? null)
  const owner = canManageTeam(role)
  const confirm = (fn: () => Promise<void>) => {
    setBusy(true)
    fn()
      .then(
        () => setDialog(null),
        e => toast(tr('channels.task.actionFailed', { error: translateMessage((e as Error).message) })),
      )
      .finally(() => setBusy(false))
  }
  const policyFailed = (e: unknown) =>
    toast(tr('channels.task.actionFailed', { error: translateMessage((e as Error).message) }))
  // 归档的频道只读（docs/ui/channels-local-ai.md §3.1 #11）：只能恢复、删除，成员和设置都不能改
  const archived = !!channel.archivedAt
  const setArchived = (on: boolean) =>
    void channelActions.updateChannel(channel.id, { archived: on }).catch(policyFailed)
  return (
    <aside
      aria-label={tr('channels.members.title')}
      className="flex h-full w-[300px] flex-col border-l border-line-subtle"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-1 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-ui font-medium text-fg">{tr('channels.members.title')}</h2>
        {live && (
          <IconButton
            icon={Ellipsis}
            label={tr('channels.members.channelMenu')}
            size={28}
            iconSize={15}
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect()
              setChannelMenu({ x: r.right - 180, y: r.bottom + 4 })
            }}
          />
        )}
        <IconButton icon={X} label={tr('channels.members.hide')} size={28} iconSize={15} onClick={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pt-1 pb-4 [scrollbar-width:thin]">
        <dl className="mx-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-list">
          <dt className="text-fg-faint">{tr('channels.members.topic')}</dt>
          <dd className={cn('min-w-0 break-words', channel.topic ? 'text-fg-secondary' : 'text-fg-faint')}>
            {channel.topic ?? tr('channels.members.noTopic')}
          </dd>
          {team && teamName && (
            <>
              <dt className="text-fg-faint">{tr('team.panel.team')}</dt>
              <dd className="min-w-0 truncate text-fg-secondary">{teamName}</dd>
            </>
          )}
          {channel.project && !team && (
            <>
              <dt className="text-fg-faint">{tr('channels.members.project')}</dt>
              <dd className="min-w-0 truncate text-fg-secondary">{channel.project}</dd>
            </>
          )}
          <dt className="text-fg-faint">{tr('channels.members.type')}</dt>
          <dd className="text-fg-secondary">
            {tr(channel.scope === 'team' ? 'channels.scope.team' : 'channels.scope.local')}
          </dd>
          {!team && (
            <>
              <dt className="self-center text-fg-faint">{tr('channels.members.notify')}</dt>
              <dd className="min-w-0">
                <Select
                  label={tr('channels.members.notify')}
                  value={channel.notify ?? 'all'}
                  disabled={archived}
                  options={NOTIFY_OPTIONS.map(v => ({ value: v, label: tr(`channels.notify.level.${v}`) }))}
                  onChange={v =>
                    void channelActions
                      .updateChannel(channel.id, { notify: v })
                      .catch(e =>
                        toast(tr('channels.task.actionFailed', { error: translateMessage((e as Error).message) })),
                      )
                  }
                  className="h-7 w-full"
                />
              </dd>
            </>
          )}
          {channel.notes && (
            <>
              <dt className="text-fg-faint">{tr('channels.members.notes')}</dt>
              <dd
                data-channel-notes
                className="selectable min-w-0 text-meta leading-5 break-words whitespace-pre-wrap text-fg-secondary"
              >
                {channel.notes}
              </dd>
            </>
          )}
        </dl>
        <PinnedList channel={channel} members={allMembers} />
        <Section
          title={
            team
              ? tr('team.panel.humans', { count: humans.length, online: onlineCount(humans) })
              : tr('channels.members.humans', { count: humans.length })
          }
        >
          {humans.map(m => (
            <HumanRow key={m.id} member={m} team={team} />
          ))}
        </Section>
        <Section
          title={
            team
              ? tr('team.panel.agents', { count: agents.length })
              : tr('channels.members.agents', { count: agents.length })
          }
        >
          {agents.map(m => (
            <AgentRow
              key={m.id}
              member={m}
              live={live}
              team={team}
              canRemoveOthers={live && owner}
              readOnly={archived}
              onPolicy={(member, policy) =>
                policy === 'team'
                  ? setDialog({ kind: 'policy', member })
                  : void channelActions.setAgentPolicy(channel.id, member.id, policy).catch(policyFailed)
              }
              onOpenSession={onOpenSession}
              onEdit={config => setDialog({ kind: 'agent', editing: config })}
              onRemove={member => setDialog({ kind: 'remove', member })}
            />
          ))}
        </Section>
      </div>
      {/* 归档的频道：输入框的位置有「恢复频道」，这里不再放按钮 */}
      {!archived && (
        <div className="flex shrink-0 flex-col gap-2 border-t border-line-subtle p-3">
          {team ? (
            <>
              {canAddAgent(role) && (
                <Button
                  icon={Bot}
                  className="w-full justify-center"
                  onClick={() => setDialog({ kind: 'addTeamAgent' })}
                >
                  {tr('team.panel.addMine')}
                </Button>
              )}
              {owner && (
                <Button
                  icon={UserPlus}
                  variant="ghost"
                  className="w-full justify-center"
                  onClick={() => setDialog({ kind: 'invite' })}
                >
                  {tr('team.panel.invite')}
                </Button>
              )}
            </>
          ) : (
            <Button
              icon={Bot}
              className="w-full justify-center"
              onClick={() =>
                live ? setDialog({ kind: 'agent', editing: null }) : comingSoon(tr('channels.members.addAgent'))
              }
            >
              {tr('channels.members.addAgent')}
            </Button>
          )}
        </div>
      )}
      {channelMenu && (
        <ActionMenu
          x={channelMenu.x}
          y={channelMenu.y}
          label={tr('channels.members.channelMenu')}
          actions={[
            ...(archived
              ? [{ label: tr('channels.channel.restore'), icon: ArchiveRestore, run: () => setArchived(false) }]
              : [{ label: tr('channels.channel.edit'), icon: Pencil, run: () => setDialog({ kind: 'channel' }) }]),
            ...(!team && !archived
              ? [{ label: tr('channels.channel.archive'), icon: Archive, run: () => setArchived(true) }]
              : []),
            {
              label: tr('channels.channel.delete'),
              icon: Trash2,
              danger: true,
              separator: true,
              run: () => setDialog({ kind: 'delete' }),
            },
          ]}
          onClose={() => setChannelMenu(null)}
        />
      )}
      {dialog?.kind === 'addTeamAgent' && (
        <AddTeamAgentDialog channelId={channel.id} candidates={others} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'invite' && channel.teamId && (
        <TeamSettingsDialog teamId={channel.teamId} tab="members" focusInvite onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'policy' && (
        <ConfirmDialog
          title={tr('team.policy.confirmTitle')}
          description={tr('team.policy.confirmBody')}
          confirmLabel={tr('team.policy.confirm')}
          cancelLabel={tr('channels.dialog.cancel')}
          busy={busy}
          onConfirm={() => confirm(() => channelActions.setAgentPolicy(channel.id, dialog.member.id, 'team'))}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'agent' && (
        <AgentDialog channel={channel} editing={dialog.editing} others={others} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'channel' && <ChannelDialog channel={channel} agents={[]} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          danger
          title={tr('channels.channel.deleteTitle', { name: channel.name })}
          description={tr('channels.channel.deleteBody')}
          confirmLabel={tr('channels.channel.deleteConfirm')}
          cancelLabel={tr('channels.dialog.cancel')}
          busy={busy}
          onConfirm={() => confirm(() => channelActions.deleteChannel(channel.id))}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'remove' && (
        <ConfirmDialog
          danger
          title={tr('channels.members.removeTitle', { name: dialog.member.name })}
          description={
            dialog.member.task || dialog.member.queued
              ? tr('channels.members.removeBody', { count: (dialog.member.task ? 1 : 0) + (dialog.member.queued ?? 0) })
              : tr('channels.members.removeBodyIdle')
          }
          confirmLabel={tr('channels.members.remove')}
          cancelLabel={tr('channels.dialog.cancel')}
          busy={busy}
          onConfirm={() => confirm(() => channelActions.removeMember(channel.id, dialog.member.id))}
          onCancel={() => setDialog(null)}
        />
      )}
    </aside>
  )
}
