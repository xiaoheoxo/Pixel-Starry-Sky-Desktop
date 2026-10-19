import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useMemo, useState } from 'react'
import {
  AtSign,
  ChevronDown,
  CloudOff,
  Ellipsis,
  Hash,
  LogOut,
  Plus,
  Search,
  Settings,
  Trash2,
  UserPlus,
} from 'lucide-react'
import { Avatar, Button, cn, CountBadge, IconButton, Spinner, useComingSoon, useToast } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { SidebarEmpty } from '@/features/sidebar/SidebarSection'
import { useAccount } from '@/features/account'
import type { AgentMember, Channel } from '@/data/types'
import type { PendingInvite, TeamInfo } from '../../../../shared/types/channels'
import { channelActions, channelsLive, selfMember, useChannels } from './store'
import { ChannelDialog } from './ChannelDialogs'
import { CreateTeamDialog, TeamSettingsDialog } from './TeamDialog'
import { roleLabel } from './TeamParts'
import { formatShortTime, formatSyncTime } from './format'
import { hitPlace, useChannelSearch } from './search'
import type { SearchFragment } from '@pixelsky/protocol'
import {
  ARCHIVED_SECTION,
  canCreateChannel,
  canManageTeam,
  groupChannels,
  onlineMembers,
  parseCollapsed,
  toggleCollapsed,
} from './teamModel'

const COLLAPSED_KEY = 'pixelsky.channels.collapsed'
/** 「已归档」默认收起：列表里记的是「展开了它」 */
const ARCHIVED_OPEN = 'archived:open'

/** 折叠的段（团队 id / 'local'）存在 localStorage，换电脑不同步 */
function useCollapsed(): [readonly string[], (id: string) => void] {
  const [list, setList] = useState<string[]>(() => {
    try {
      return parseCollapsed(localStorage.getItem(COLLAPSED_KEY))
    } catch {
      return []
    }
  })
  const toggle = (id: string) =>
    setList(current => {
      const next = toggleCollapsed(current, id)
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next))
      } catch {
        /* 存不了就只在本次运行里记住 */
      }
      return next
    })
  return [list, toggle]
}

function ChannelRow({ channel, selected, onSelect }: { channel: Channel; selected: boolean; onSelect: () => void }) {
  useI18n()
  const label = [
    channel.name,
    channel.unread > 0 ? tr('channels.unreadCount', { count: channel.unread }) : '',
    channel.mentioned ? tr('channels.mentioned') : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      aria-label={label}
      title={channel.topic ? `${channel.name}\n${channel.topic}` : channel.name}
      onClick={onSelect}
      className={cn(
        'flex h-8 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-2.5 text-left text-list transition-colors',
        selected ? 'bg-selected text-fg' : 'text-fg-secondary hover:bg-hover',
      )}
    >
      <Hash size={14} strokeWidth={1.5} className="shrink-0 text-fg-faint" />
      <span className={cn('min-w-0 flex-1 truncate', channel.unread > 0 && 'font-medium text-fg')}>{channel.name}</span>
      {channel.mentioned && <AtSign size={13} strokeWidth={2} className="shrink-0 text-accent-fg" />}
      {channel.unread > 0 && <CountBadge count={channel.unread} />}
    </button>
  )
}

function Snippet({ parts }: { parts: readonly SearchFragment[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-accent-fg">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

/** 搜索时列表下面的「消息」段（docs/ui/channels-local-ai.md §3.1 #8）：点一条切到那个频道并跳到那条消息 */
function MessageHits({
  query,
  channels,
  names,
}: {
  query: string
  channels: readonly Channel[]
  names: ReadonlyMap<string, string>
}) {
  useI18n()
  const { hits, truncated, loading } = useChannelSearch(query, { limit: 50 })
  return (
    <section data-channel-search-hits="" className="mt-2 flex shrink-0 flex-col">
      <h3 className="flex h-7 items-center gap-1.5 px-2 text-label font-medium text-fg-muted">
        {tr('channels.search.messages')}
        {loading && <Spinner size={11} />}
      </h3>
      {!loading && hits.length === 0 && <SidebarEmpty>{tr('channels.search.noMessages')}</SidebarEmpty>}
      <div className="flex flex-col gap-px">
        {hits.map(hit => {
          const place = hitPlace(hit, channels, names)
          return (
            <button
              key={hit.messageId}
              type="button"
              data-search-hit={hit.messageId}
              onClick={() => void channelActions.focusMessage(hit.channelId, hit.messageId, hit.at)}
              className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-hover"
            >
              <span className="flex w-full min-w-0 items-center gap-2 text-label text-fg-faint">
                <span className="min-w-0 flex-1 truncate">
                  {tr('channels.search.place', { channel: place.channel, author: place.author })}
                  {place.archived && ` · ${tr('channels.search.archived')}`}
                </span>
                <span className="shrink-0">{formatShortTime(hit.at)}</span>
              </span>
              <span className="line-clamp-2 text-meta break-words text-fg-secondary">
                <Snippet parts={hit.snippet} />
              </span>
            </button>
          )
        })}
      </div>
      {truncated && (
        <p className="px-2.5 py-1 text-label text-fg-faint">{tr('channels.search.latest', { count: hits.length })}</p>
      )}
    </section>
  )
}

/** 邀请卡：别人邀请我加入团队，要点「加入」才加入（docs/ui/channels-phase-c.md §2.3） */
function InviteCard({ invite }: { invite: PendingInvite }) {
  useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const respond = (accept: boolean) => {
    if (busy) return
    setBusy(true)
    channelActions
      .respondInvite(invite.id, accept)
      .catch(e => toast(tr('channels.task.actionFailed', { error: translateMessage((e as Error).message) })))
      .finally(() => setBusy(false))
  }
  return (
    <div className="mb-2 rounded-lg border border-line-card bg-surface p-3 shadow-sm">
      <p className="text-meta text-fg-muted">{tr('team.invite.card', { inviter: invite.inviter })}</p>
      <p className="mt-0.5 truncate text-list font-medium text-fg" title={invite.teamName}>
        {tr('team.invite.cardTeam', { team: invite.teamName, role: roleLabel(invite.role) })}
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <Button className="h-7 px-2.5 text-meta" disabled={busy} onClick={() => respond(false)}>
          {tr('team.invite.decline')}
        </Button>
        <Button variant="primary" className="h-7 px-2.5 text-meta" disabled={busy} onClick={() => respond(true)}>
          {tr('team.invite.accept')}
        </Button>
      </div>
    </div>
  )
}

/** 段标题：折叠箭头、名字、（团队）在线头像 / 连不上云端的图标 / ⋯ 菜单、+ 新建频道 */
function SectionHeader({
  title,
  collapsed,
  onToggle,
  team,
  names,
  selfId,
  offlineTip,
  onMenu,
  onAdd,
}: {
  title: string
  collapsed: boolean
  onToggle: () => void
  team: TeamInfo | null
  names: ReadonlyMap<string, string>
  selfId: string | null
  offlineTip: string | null
  onMenu: (rect: DOMRect) => void
  onAdd: (() => void) | null
}) {
  useI18n()
  const online = team ? onlineMembers(team, names, selfId) : []
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 pr-1 pl-1">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={tr('team.section.toggle', { name: title })}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left text-label font-medium text-fg-muted hover:text-fg-secondary"
      >
        <ChevronDown
          size={12}
          strokeWidth={1.75}
          className={cn('shrink-0 transition-transform', collapsed && '-rotate-90')}
        />
        <h3 className="min-w-0 truncate">{title}</h3>
        {offlineTip && (
          <span title={offlineTip} aria-label={offlineTip} className="shrink-0 text-warn">
            <CloudOff size={13} strokeWidth={1.75} />
          </span>
        )}
      </button>
      {online.length > 0 && (
        <span
          className="flex shrink-0 items-center pr-0.5"
          title={tr('team.section.online', { names: online.map(m => m.name).join(', ') })}
        >
          {online.map((m, i) => (
            <Avatar key={m.id} name={m.name} size={16} className={cn('ring-2 ring-surface', i > 0 && '-ml-1')} />
          ))}
        </span>
      )}
      {team && (
        <IconButton
          icon={Ellipsis}
          label={tr('team.menu', { name: title })}
          size={22}
          iconSize={14}
          onClick={e => onMenu(e.currentTarget.getBoundingClientRect())}
        />
      )}
      {onAdd && (
        <IconButton
          icon={Plus}
          label={team ? tr('team.newChannelIn', { name: title }) : tr('channels.new')}
          size={22}
          iconSize={14}
          onClick={onAdd}
        />
      )}
    </div>
  )
}

/** 频道列表（docs/ui/channels.md §4，团队分段见 channels-phase-c.md §3.1）：搜索、本机 + 每个团队一段、邀请卡、新建频道 / 团队 */
export function ChannelList({
  channels,
  selectedId,
  onSelect,
  agents,
}: {
  channels: readonly Channel[]
  /** 新建频道时可以一起加进来的 AI 成员 */
  agents: readonly AgentMember[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  useI18n()
  const comingSoon = useComingSoon()
  const toast = useToast()
  const account = useAccount()
  const teams = useChannels(s => s.teams)
  const invites = useChannels(s => s.invites)
  const connection = useChannels(s => s.teamsConnection)
  const syncedAt = useChannels(s => s.teamsSyncedAt)
  const members = useChannels(s => s.members)
  const self = useChannels(selfMember)
  // 团队里我的 id 是账号的 owner key，和本机频道里的 you 不同
  const youIds = useMemo(() => new Set(members.filter(m => m.kind === 'human' && m.you).map(m => m.id)), [members])
  const selfInTeam = (team: TeamInfo): string | null => team.members.find(m => youIds.has(m.id))?.id ?? self?.id ?? null
  const names = useMemo(() => new Map(members.map(m => [m.id, m.name])), [members])
  const [query, setQuery] = useState('')
  const [collapsed, toggleCollapse] = useCollapsed()
  // 云端没有团队接口：不显示任何团队入口
  const teamUi = connection !== 'unavailable'
  const searching = query.trim().length > 0
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shown = q
      ? channels.filter(c => c.name.toLowerCase().includes(q) || c.topic?.toLowerCase().includes(q))
      : channels
    return groupChannels(shown, teamUi ? teams : [], { searching: q.length > 0 })
  }, [channels, teams, teamUi, query])
  const [dialog, setDialog] = useState<
    | { kind: 'channel'; teamId: string | null }
    | { kind: 'newTeam' }
    | { kind: 'settings'; teamId: string; tab: 'members' | 'settings'; focusInvite?: boolean }
    | { kind: 'leave'; team: TeamInfo }
    | null
  >(null)
  const [menu, setMenu] = useState<{ x: number; y: number; team: TeamInfo } | null>(null)
  const [busy, setBusy] = useState(false)

  const createLocal = () =>
    channelsLive ? setDialog({ kind: 'channel', teamId: null }) : comingSoon(tr('channels.new'))
  const offlineTip =
    connection === 'offline'
      ? syncedAt
        ? tr('team.offlineSynced', { time: formatSyncTime(syncedAt) })
        : tr('team.offline')
      : null

  const menuActions = (team: TeamInfo): MenuAction[] => [
    {
      label: tr('team.menu.settings'),
      icon: Settings,
      run: () => setDialog({ kind: 'settings', teamId: team.id, tab: 'members' }),
    },
    ...(canManageTeam(team.role)
      ? [
          {
            label: tr('team.menu.invite'),
            icon: UserPlus,
            run: () => setDialog({ kind: 'settings', teamId: team.id, tab: 'members', focusInvite: true }),
          },
          {
            label: tr('team.menu.delete'),
            icon: Trash2,
            danger: true,
            separator: true,
            run: () => setDialog({ kind: 'settings', teamId: team.id, tab: 'settings' }),
          },
        ]
      : [
          {
            label: tr('team.menu.leave'),
            icon: LogOut,
            danger: true,
            separator: true,
            run: () => setDialog({ kind: 'leave', team }),
          },
        ]),
  ]

  return (
    <nav
      aria-label={tr('channels.list')}
      className="flex w-[260px] shrink-0 flex-col border-r border-line-subtle @max-[700px]:w-[220px]"
    >
      <div className="shrink-0 px-3 pt-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-fg-muted focus-within:border-accent">
          <Search size={14} strokeWidth={1.5} className="shrink-0" />
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label={tr('channels.search')}
            placeholder={tr('channels.search')}
            className="min-w-0 flex-1 bg-transparent text-list text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-width:thin]">
        {teamUi && invites.map(invite => <InviteCard key={invite.id} invite={invite} />)}
        {sections.map(section => {
          const team = section.team
          const archived = section.id === ARCHIVED_SECTION
          const isCollapsed =
            !searching && (archived ? !collapsed.includes(ARCHIVED_OPEN) : collapsed.includes(section.id))
          // 「已归档」收起时，正在看的那个归档频道还留一行
          const rows = !isCollapsed
            ? section.channels
            : archived
              ? section.channels.filter(c => c.id === selectedId)
              : []
          return (
            <section key={section.id} className="flex shrink-0 flex-col" data-channel-section={section.id}>
              <SectionHeader
                title={
                  team
                    ? team.name
                    : archived
                      ? tr('channels.archived.section', { count: section.channels.length })
                      : tr('team.section.local')
                }
                collapsed={isCollapsed}
                onToggle={() => toggleCollapse(archived ? ARCHIVED_OPEN : section.id)}
                team={team}
                names={names}
                selfId={team ? selfInTeam(team) : (self?.id ?? null)}
                offlineTip={team ? offlineTip : null}
                onMenu={rect => team && setMenu({ x: rect.right - 180, y: rect.bottom + 4, team })}
                onAdd={
                  archived
                    ? null
                    : !team
                      ? createLocal
                      : canCreateChannel(team.role)
                        ? () => setDialog({ kind: 'channel', teamId: team.id })
                        : null
                }
              />
              {(!isCollapsed || rows.length > 0) && (
                <div className="flex flex-col gap-px">
                  {section.channels.length === 0 && searching && (
                    <SidebarEmpty>{tr('channels.searchEmpty')}</SidebarEmpty>
                  )}
                  {section.channels.length === 0 && !searching && team && (
                    <SidebarEmpty>{tr('team.section.empty')}</SidebarEmpty>
                  )}
                  {rows.map(c => (
                    <ChannelRow key={c.id} channel={c} selected={c.id === selectedId} onSelect={() => onSelect(c.id)} />
                  ))}
                </div>
              )}
            </section>
          )
        })}
        {sections.length === 0 && <SidebarEmpty>{tr('channels.searchEmpty')}</SidebarEmpty>}
        {searching && <MessageHits query={query} channels={channels} names={names} />}
        {!searching && teamUi && connection === 'signed-out' && (
          <div className="mt-2 flex flex-col items-start gap-2 rounded-lg px-2.5 py-2 text-meta text-fg-faint">
            <p>{tr('team.signedOut')}</p>
            <Button
              className="h-7 px-2.5 text-meta"
              disabled={account.status === 'signing-in'}
              onClick={() => void account.login()}
            >
              {tr('team.signIn')}
            </Button>
          </div>
        )}
        {!searching && teamUi && connection !== 'signed-out' && teams.length === 0 && (
          <button
            type="button"
            onClick={() => setDialog({ kind: 'newTeam' })}
            className="mt-1 flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-list text-fg-faint hover:bg-hover hover:text-fg-secondary"
          >
            <Plus size={14} strokeWidth={1.5} className="shrink-0" />
            <span className="min-w-0 truncate">{tr('team.section.newHint')}</span>
          </button>
        )}
      </div>
      <div className="flex shrink-0 gap-1 border-t border-line-subtle p-2">
        <button
          type="button"
          onClick={createLocal}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-list text-fg-secondary hover:bg-hover"
        >
          <Plus size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          <span className="truncate">{tr('channels.new')}</span>
        </button>
        {teamUi && connection !== 'signed-out' && (
          <button
            type="button"
            onClick={() => setDialog({ kind: 'newTeam' })}
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-list text-fg-secondary hover:bg-hover"
          >
            <Plus size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
            <span className="truncate">{tr('team.new')}</span>
          </button>
        )}
      </div>
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={tr('team.menu', { name: menu.team.name })}
          actions={menuActions(menu.team)}
          onClose={() => setMenu(null)}
        />
      )}
      {dialog?.kind === 'channel' && (
        <ChannelDialog channel={null} agents={agents} teamId={dialog.teamId} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'newTeam' && (
        <CreateTeamDialog
          onClose={() => setDialog(null)}
          onCreated={teamId => setDialog({ kind: 'settings', teamId, tab: 'members', focusInvite: true })}
        />
      )}
      {dialog?.kind === 'settings' && (
        <TeamSettingsDialog
          teamId={dialog.teamId}
          tab={dialog.tab}
          focusInvite={dialog.focusInvite}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'leave' && (
        <ConfirmDialog
          danger
          title={tr('team.leave.title', { name: dialog.team.name })}
          description={tr('team.leave.body')}
          confirmLabel={tr('team.leave.confirm')}
          cancelLabel={tr('channels.dialog.cancel')}
          busy={busy}
          onConfirm={() => {
            const team = dialog.team
            setBusy(true)
            channelActions
              .removeTeamMember(team.id, selfInTeam(team) ?? '')
              .then(
                () => setDialog(null),
                e => toast(tr('channels.task.actionFailed', { error: translateMessage((e as Error).message) })),
              )
              .finally(() => setBusy(false))
          }}
          onCancel={() => setDialog(null)}
        />
      )}
    </nav>
  )
}
