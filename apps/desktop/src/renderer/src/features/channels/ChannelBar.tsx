// 频道区顶上的一条（docs/ui/channels-unify.md §1、§2）：谁能看到的标记、「消息 / 任务」切换。频道名在窗口顶栏里，这里不重复
import { useState } from 'react'
import { ArrowLeftRight, Lock, Settings, UserPlus, Users } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { cn } from '@/ui'
import { SEGMENT_TRACK, segmentItem } from '@/ui/Segmented'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import type { Channel } from '@/data/types'
import { useChannels } from './store'
import { canManageTeam } from './teamModel'
import { TeamSettingsDialog } from './TeamDialog'

export type ChannelTab = 'messages' | 'tasks'
/** 标签条上的一格：团队的频道多一格「我的协作」（docs/ui/channels-unify.md §7.2） */
export type BarTab = ChannelTab | 'side'

/** 「只有我」或「团队名 · N 人」 */
export function audienceLabel(
  channel: Pick<Channel, 'scope'>,
  team: { name: string; members: unknown[] } | null,
): string {
  return channel.scope === 'team' && team
    ? tr('unify.aud.team', { name: team.name, count: team.members.length })
    : tr('unify.aud.me')
}

export function ChannelBar({
  channel,
  tab,
  onTab,
  openTasks,
  onShare,
  onUnshare,
  side,
}: {
  channel: Channel
  tab: BarTab
  onTab: (tab: BarTab) => void
  /** 团队的频道、我不是观察者：有「我的协作」这一格；unread 是那一页里没读的 */
  side?: { unread: number } | null
  /** 还没结束的活有几件（写在「任务」上） */
  openTasks: number
  /** 只有我的频道：邀请队友（共享到团队）；没有时不出这一项 */
  onShare?: () => void
  /** 团队的频道、我是所有者：改回只有我 */
  onUnshare?: () => void
}) {
  useI18n()
  const team = useChannels(s => (channel.teamId ? (s.teams.find(t => t.id === channel.teamId) ?? null) : null))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [settings, setSettings] = useState<{ invite: boolean } | null>(null)
  const shared = channel.scope === 'team'
  const owner = canManageTeam(team?.role)
  const actions: MenuAction[] = shared
    ? [
        ...(team ? [{ label: tr('unify.aud.manage'), icon: Settings, run: () => setSettings({ invite: false }) }] : []),
        ...(team && owner
          ? [{ label: tr('unify.aud.invite'), icon: UserPlus, run: () => setSettings({ invite: true }) }]
          : []),
        ...(onUnshare && owner
          ? [{ label: tr('unify.unshare.action'), icon: ArrowLeftRight, separator: true, run: onUnshare }]
          : []),
      ]
    : onShare
      ? [{ label: tr('unify.aud.invite'), icon: UserPlus, run: onShare }]
      : []
  const Icon = shared ? Users : Lock
  const label = audienceLabel(channel, team)
  const pill = cn(
    'flex h-7 min-w-0 shrink items-center gap-1.5 rounded-full px-2.5 text-meta',
    shared ? 'bg-accent-soft text-accent-fg' : 'bg-subtle text-fg-secondary',
  )
  const hint = tr(shared ? 'unify.aud.teamBody' : 'unify.aud.meBody')
  return (
    <div data-channel-bar="" className="flex h-11 shrink-0 items-center gap-3 border-b border-line-subtle pr-3 pl-5">
      {actions.length > 0 ? (
        <button
          type="button"
          data-channel-audience={shared ? 'team' : 'me'}
          aria-haspopup="menu"
          aria-label={tr('unify.aud.label', { who: label })}
          title={hint}
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left, y: r.bottom + 4 })
          }}
          className={cn(pill, 'press hover:opacity-85')}
        >
          <Icon size={13} strokeWidth={1.75} className="shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      ) : (
        <span data-channel-audience={shared ? 'team' : 'me'} title={hint} className={pill}>
          <Icon size={13} strokeWidth={1.75} className="shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
        </span>
      )}
      <p className="min-w-0 flex-1 truncate text-meta text-fg-faint" title={channel.topic ?? undefined}>
        {channel.topic}
      </p>
      <div role="tablist" aria-label={tr('unify.tab.label')} className={SEGMENT_TRACK}>
        {(['messages', 'tasks', ...(side ? (['side'] as const) : [])] as const).map(v => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={tab === v}
            data-channel-tab={v}
            onClick={() => onTab(v)}
            className={cn(segmentItem(tab === v), 'px-2.5 text-meta')}
          >
            {v === 'messages'
              ? tr('unify.tab.messages')
              : v === 'side'
                ? side && side.unread > 0
                  ? tr('unify.tab.sideCount', { count: side.unread })
                  : tr('unify.tab.side')
                : openTasks > 0
                  ? tr('unify.tab.tasksCount', { count: openTasks })
                  : tr('unify.tab.tasks')}
          </button>
        ))}
      </div>
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={tr('unify.aud.title')}
          actions={actions}
          onClose={() => setMenu(null)}
        />
      )}
      {settings && channel.teamId && (
        <TeamSettingsDialog
          teamId={channel.teamId}
          tab="members"
          focusInvite={settings.invite}
          onClose={() => setSettings(null)}
        />
      )}
    </div>
  )
}
