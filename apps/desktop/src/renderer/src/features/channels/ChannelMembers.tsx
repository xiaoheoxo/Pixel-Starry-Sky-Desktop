import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage, type TranslationKey } from '../../i18n/core'
import { useEffect, useState, type ReactNode } from 'react'
import { codexPlainText } from '@pixelsky/protocol'
import {
  Archive,
  BookmarkPlus,
  ArchiveRestore,
  ArrowUpRight,
  Bot,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  Folder,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react'
import { Button, cn, IconButton, Select, Spinner, Switch, useComingSoon, useToast } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { effortLabel, PERMISSION_INFO, relativeTime } from '@/features/engine'
import type { AgentMember, Channel, ChannelAgentStatus, ChannelMember, HumanMember } from '@/data/types'
import type { AgentConfig, AgentPolicy, ChannelNotify, ChannelTaskStatus } from '../../../../shared/types/channels'
import { usesTaskCopies } from '../../../../shared/types/channels'
import { agentCredit, machineLabel, MemberAvatar } from './ChannelMessage'
import { channelLoad, dirConflicts, memberLoad } from './model'
import { AvatarPicker } from './AvatarPicker'
import { AgentDialog, ChannelDialog } from './ChannelDialogs'
import { SavePresetDialog } from './ChannelPresets'
import { channelActions, channelsLive, useChannels } from './store'
import { AddTeamAgentDialog, TeamSettingsDialog } from './TeamDialog'
import { PresenceAvatar, roleLabel } from './TeamParts'
import { costCell, durText, formatLastSeen, usageText } from './format'
import { formatTokens } from '@/features/usage/format'
import { AgentQueue, memberQueueTasks } from './AgentQueue'
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

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex min-h-7 items-center gap-1 px-2">
        <h3 className="min-w-0 flex-1 truncate text-label font-medium text-fg-muted">{title}</h3>
        {action}
      </div>
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
        const text = m?.kind === 'message' ? codexPlainText(m.text).replace(/\s+/g, ' ').trim() : null
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

/** 档案里的用量四格：耗时、token、30 天费用、今天（docs/ui/channels-local-rest.md §3.2） */
function UsageCells({ usage }: { usage: NonNullable<AgentMember['usage']> }) {
  const m = usage.month
  const month = costCell(m)
  const today = costCell(usage.today, true)
  const cells: [string, string, string][] = [
    [tr('channels.usage.time'), usage.ms > 0 ? durText(usage.ms) : '—', ''],
    [
      tr('channels.usage.tokens'),
      m.records > 0 ? formatTokens(m.input + m.cacheRead + m.cacheWrite + m.output) : '—',
      '',
    ],
    [tr('channels.usage.cost'), month.text, month.title],
    [tr('channels.usage.today'), today.text, today.title],
  ]
  return (
    <dd data-member-usage="" className="col-span-2 grid grid-cols-4 gap-1">
      {cells.map(([label, value, title]) => (
        <span key={label} className="flex min-w-0 flex-col rounded bg-surface px-1.5 py-1" title={title || undefined}>
          <span className="truncate text-fg-faint">{label}</span>
          <span className="truncate text-fg">{value}</span>
        </span>
      ))}
    </dd>
  )
}

/** 30 天每天做了几项的走势条，最后一根是今天 */
function DayBars({ days }: { days: number[] }) {
  const max = Math.max(...days, 1)
  return (
    <dd className="col-span-2">
      <div aria-hidden className="flex h-10 items-end gap-px">
        {days.map((n, i) => (
          <i
            key={i}
            title={tr('channels.usage.dayTasks', { n })}
            className={cn('flex-1 rounded-t-sm', n ? 'bg-accent opacity-75' : 'bg-line-subtle')}
            style={{ height: n ? 4 + (n / max) * 36 : 2 }}
          />
        ))}
      </div>
      <div className="flex justify-between text-fg-faint">
        <span>{tr('channels.usage.daysAgo')}</span>
        <span>{tr('channels.usage.today')}</span>
      </div>
    </dd>
  )
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
      {member.stats && (
        <dd className="col-span-2 text-fg-muted">
          {tr('channels.members.stats', {
            total: member.stats.total,
            done: member.stats.done,
            failed: member.stats.failed,
          })}
        </dd>
      )}
      {member.usage && <UsageCells usage={member.usage} />}
      {!!member.stats?.days?.some(n => n > 0) && <DayBars days={member.stats.days} />}
    </dl>
  )
}

function LeadTag() {
  return (
    <span className="shrink-0 rounded bg-accent/10 px-1.5 text-label font-normal text-accent">
      {tr('channels.members.lead')}
    </span>
  )
}

/** 目录行：项目 · 主目录 / 副本 / 每项单独副本 · 远端机器 */
function dirText(member: AgentMember, copyName: string | undefined): string {
  const config = member.config
  return [
    member.project,
    config &&
      (usesTaskCopies(config)
        ? tr('channels.members.taskCopies')
        : config.copyId
          ? (copyName ?? tr('machines.copy'))
          : tr('channels.agent.mainTree')),
    member.machineId !== 'local' && machineLabel(member),
  ]
    .filter(Boolean)
    .join(' · ')
}

function AgentRow({
  member,
  channelId,
  live,
  team,
  canRemoveOthers,
  readOnly = false,
  lead,
  queued,
  dirPeers,
  copyName,
  onOpenSession,
  onEdit,
  onDuplicate,
  onRemove,
  onPolicy,
}: {
  member: AgentMember
  /** 是这个频道的牵头成员 */
  lead: boolean
  /** 这个频道里排队的活数（channels-side-panels §4.3） */
  queued: number
  /** 和频道里别的成员共用目录时和谁共用（docs/ui/channel-member-row.md §2） */
  dirPeers: string[]
  /** 成员绑的 Git 副本的名字；还没读到是 undefined */
  copyName: string | undefined
  onDuplicate: (config: AgentConfig) => void
  channelId: string
  live: boolean
  /** 团队频道 */
  team: boolean
  readOnly?: boolean
  canRemoveOthers: boolean
  onOpenSession: (id: string) => void
  onEdit: (config: AgentConfig) => void
  onRemove: (member: AgentMember) => void
  onPolicy: (member: AgentMember, policy: AgentPolicy) => void
}) {
  useI18n()
  const messages = useChannels(s => s.messages[channelId])
  const [open, setOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  // 队列清空后收起：下次有新的排队不自己弹开
  if (queueOpen && queued === 0) setQueueOpen(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const line = agentLine(member, Date.now())
  const status = tr(STATUS_LABEL[member.status])
  // 别人的 AI 成员：只读，没有「打开会话」和档案
  const foreign = team && member.mine === false
  const config = member.config
  const settings = config?.settings
  // 自己设过的才出标签；没设是跟随引擎默认
  const tags = [
    settings?.effort && effortLabel(settings.effort),
    settings?.fast && 'Fast',
    settings?.ultracode && 'Ultracode',
  ].filter((t): t is string => !!t)
  const where = dirText(member, copyName)
  const role = config?.instructions.trim().split('\n')[0]
  const sharesText = dirPeers.length
    ? tr('channels.members.sharesDir', { names: dirPeers.join(tr('channels.composer.nameSep')) })
    : undefined
  // 演示成员没有 config，演示模式也让换（只改内存）
  const canChangeAvatar = !readOnly && member.mine !== false && (!!config || !channelsLive)
  const actions: MenuAction[] = foreign
    ? [{ label: tr('channels.members.remove'), icon: UserMinus, danger: true, run: () => onRemove(member) }]
    : [
        ...(member.config
          ? [{ label: tr('channels.members.edit'), icon: Pencil, run: () => onEdit(member.config!) }]
          : []),
        // 复制：新成员加进这个频道，所以归档的频道、团队频道（成员要另外登记）没有
        ...(member.config && !readOnly && !team
          ? [{ label: tr('channels.members.duplicate'), icon: Copy, run: () => onDuplicate(member.config!) }]
          : []),
        ...(member.sessionId || member.boundSession
          ? [
              {
                label: tr('channels.openSession'),
                icon: ArrowUpRight,
                run: () => onOpenSession((member.sessionId ?? member.boundSession?.id)!),
              },
            ]
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
        'group/agent flex min-w-0 flex-wrap gap-x-2.5 rounded-lg bg-surface px-2.5 py-2',
        member.status === 'offline' && 'opacity-60',
      )}
    >
      <span className="relative mt-0.5 h-fit shrink-0 self-start">
        <AvatarPicker member={member} size={28} editable={canChangeAvatar} />
        {member.status !== 'running' && (
          <span
            aria-hidden
            className={cn(
              'absolute -bottom-0.5 -left-0.5 size-2.5 rounded-full ring-2 ring-surface',
              STATUS_DOT[member.status],
            )}
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        {!foreign ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={tr('channels.members.details', { name: member.name })}
            onClick={() => setOpen(v => !v)}
            className="flex max-w-full min-w-0 items-center gap-1 text-left text-list font-medium text-fg"
          >
            <span className="truncate">{member.name}</span>
            {lead && <LeadTag />}
            <ChevronDown
              size={12}
              className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-180')}
            />
          </button>
        ) : (
          <div className="flex min-w-0 items-baseline gap-1 text-list font-medium text-fg">
            <span className="truncate">{member.name}</span>
            {lead && <LeadTag />}
            {foreign && member.ownerName && (
              <span className="shrink-0 text-meta font-normal text-fg-faint">
                · {tr('team.panel.agentOf', { owner: member.ownerName })}
              </span>
            )}
          </div>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-meta">
          <span className="min-w-0 truncate text-fg-secondary">
            {[agentCredit(member), member.model].filter(Boolean).join(' · ') || tr('channels.agent.default')}
          </span>
          {tags.map(t => (
            <span key={t} className="shrink-0 rounded bg-subtle px-1.5 text-label text-fg-muted">
              {t}
            </span>
          ))}
          {settings?.permissionMode && (
            <span
              className={cn(
                'shrink-0 rounded px-1.5 text-label',
                settings.permissionMode === 'full' ? 'bg-warn/10 text-warn' : 'bg-subtle text-fg-muted',
              )}
            >
              {PERMISSION_INFO[settings.permissionMode].label}
            </span>
          )}
        </div>
        {where && (
          <div data-member-dir className="flex min-w-0 items-center gap-1.5 text-meta text-fg-muted" title={sharesText}>
            <Folder size={12} className="shrink-0 text-fg-faint" />
            <span className="min-w-0 truncate">{where}</span>
            {sharesText && <span className="sr-only">{sharesText}</span>}
          </div>
        )}
        {role && (
          <div className="truncate text-meta text-fg-secondary" title={role}>
            {role}
          </div>
        )}
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
        {!foreign && queued > 0 && (
          <button
            type="button"
            aria-expanded={open || queueOpen}
            onClick={() => setQueueOpen(v => !v)}
            className="press mt-0.5 inline-flex items-center gap-0.5 rounded bg-subtle px-1.5 text-label text-fg-muted hover:text-fg"
          >
            {tr('channels.members.queuedCount', { count: queued })}
            <ChevronDown size={11} className={cn('transition-transform', (open || queueOpen) && 'rotate-180')} />
          </button>
        )}
        {member.warning && <div className="text-meta text-warn">{translateMessage(member.warning)}</div>}
        {member.config?.bound &&
          (member.boundSession ? (
            <button
              type="button"
              data-bound-session
              onClick={() => onOpenSession(member.boundSession!.id)}
              className="block max-w-full truncate text-left text-meta text-fg-muted hover:text-fg"
            >
              {tr('channels.members.bound', { title: member.boundSession.title })}
            </button>
          ) : (
            <div className="text-meta text-fg-faint">{tr('channels.members.boundGone')}</div>
          ))}

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
      {/* 档案和排队各管各的，两个都开着时队列只出一份；另起一行占满卡片宽度（夹在头像和按钮中间放不下） */}
      {!foreign && (open || (queueOpen && queued > 0)) && (
        <div className="w-full min-w-0">
          <AgentQueue
            member={member}
            tasks={memberQueueTasks(messages, member.id)}
            onFocus={id => void channelActions.focusMessage(channelId, id)}
          />
        </div>
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

/** 成员绑的 Git 副本的名字（copyId → 名字）：只读绑了副本的成员所在的项目；读不到的行里写「Git 副本」 */
function useCopyNames(agents: readonly AgentMember[]): Map<string, string> {
  const projectIds = [...new Set(agents.filter(a => a.config?.copyId).map(a => a.config!.projectId))].sort().join('\n')
  const [names, setNames] = useState(() => new Map<string, string>())
  useEffect(() => {
    const machines = window.pixelsky?.machines
    if (!projectIds || !machines) return
    let alive = true
    void Promise.all(projectIds.split('\n').map(id => machines.workspaces(id).catch(() => []))).then(lists => {
      if (alive) setNames(new Map(lists.flat().flatMap(w => (w.copyId ? [[w.copyId, w.name] as const] : []))))
    })
    return () => {
      alive = false
    }
  }, [projectIds])
  return names
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
    | { kind: 'agent'; editing: AgentConfig | null; from?: AgentConfig }
    | { kind: 'channel' }
    | { kind: 'savePreset' }
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
  const copyNames = useCopyNames(agents)
  const copyNameOf = (a: AgentMember) => (a.config?.copyId ? copyNames.get(a.config.copyId) : undefined)
  const conflicts = dirConflicts(agents, a => dirText(a, copyNameOf(a)))
  const load = channelLoad(channel, agents)
  const [moreOpen, setMoreOpen] = useState(false)
  // 牵头的候选照频道设置对话框：这个频道里本机的 AI 成员
  const leadOptions = agents.filter(m => m.machineId === 'local')
  const leadShown = leadOptions.find(m => m.id === channel.lead)?.id ?? ''
  const usage = channel.scope === 'local' ? usageText(channel.usage) : null
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
  const update = (patch: Parameters<typeof channelActions.updateChannel>[1]) =>
    void channelActions.updateChannel(channel.id, patch).catch(policyFailed)
  const setArchived = (on: boolean) => update({ archived: on })
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
        <div className="mx-2 flex flex-col gap-1.5 text-list">
          {channel.topic && <p className="min-w-0 break-words text-fg-secondary">{channel.topic}</p>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
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
                    onChange={v => update({ notify: v })}
                    className="h-7 w-full"
                  />
                </dd>
              </>
            )}
          </dl>
        </div>
        <Section
          title={
            team
              ? tr('team.panel.agents', { count: agents.length })
              : tr('channels.members.agents', { count: agents.length })
          }
          action={
            archived ? null : team ? (
              <>
                {canAddAgent(role) && (
                  <Button
                    icon={Bot}
                    variant="ghost"
                    className="h-7 px-2 text-meta"
                    onClick={() => setDialog({ kind: 'addTeamAgent' })}
                  >
                    {tr('team.panel.addMine')}
                  </Button>
                )}
                {owner && (
                  <Button
                    icon={UserPlus}
                    variant="ghost"
                    className="h-7 px-2 text-meta"
                    onClick={() => setDialog({ kind: 'invite' })}
                  >
                    {tr('team.panel.invite')}
                  </Button>
                )}
              </>
            ) : (
              <Button
                icon={Bot}
                variant="ghost"
                className="h-7 px-2 text-meta"
                aria-label={tr('channels.members.addAgent')}
                onClick={() =>
                  live ? setDialog({ kind: 'agent', editing: null }) : comingSoon(tr('channels.members.addAgent'))
                }
              >
                {tr('channels.members.add')}
              </Button>
            )
          }
        >
          <p className="px-2 pb-1 text-meta text-fg-muted">
            {agents.length
              ? [
                  load.running
                    ? tr('channels.members.runningCount', { count: load.running })
                    : tr('channels.members.noneRunning'),
                  load.queued
                    ? tr('channels.members.queuedCount', { count: load.queued })
                    : tr('channels.members.noneQueued'),
                ].join(' · ')
              : tr('channels.members.noAgents')}
          </p>
          {conflicts.map(c => {
            const editing = archived ? undefined : agents.find(a => a.id === c.editId)?.config
            return (
              <div
                key={c.names.join('\n')}
                data-dir-conflict
                className="mx-1 mb-1 flex min-w-0 items-start gap-2 rounded-md bg-warn/10 px-2 py-1.5 text-meta text-warn"
              >
                <span className="min-w-0 flex-1 break-words">
                  {tr('channels.members.dirConflict', {
                    names: c.names.join(tr('channels.composer.nameSep')),
                    dir: c.dir,
                  })}
                </span>
                {editing && live && (
                  <button
                    type="button"
                    onClick={() => setDialog({ kind: 'agent', editing })}
                    className="press shrink-0 font-medium underline-offset-2 hover:underline"
                  >
                    {tr('channels.members.changeDir')}
                  </button>
                )}
              </div>
            )
          })}
          <div className="flex flex-col gap-1.5">
            {agents.map(m => (
              <AgentRow
                key={m.id}
                member={m}
                lead={channel.lead === m.id}
                queued={memberLoad(channel, m).queued}
                dirPeers={(m.sharesDirWith ?? []).filter(n => n !== m.name && agents.some(a => a.name === n))}
                copyName={copyNameOf(m)}
                onDuplicate={config => setDialog({ kind: 'agent', editing: null, from: config })}
                channelId={channel.id}
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
          </div>
        </Section>
        {!team && !archived && leadOptions.length > 0 && (
          <Section title={tr('channels.members.dispatch')}>
            <div className="flex flex-col gap-2 px-2">
              <div className="flex min-w-0 items-center gap-2 text-list" title={tr('channels.dialog.leadHint')}>
                <span className="shrink-0 text-fg-secondary">{tr('channels.dialog.lead')}</span>
                <Select
                  label={tr('channels.dialog.lead')}
                  value={leadShown}
                  options={[
                    { value: '', label: tr('channels.dialog.leadNone') },
                    ...leadOptions.map(m => ({ value: m.id, label: m.name })),
                  ]}
                  onChange={v => update({ lead: v || null })}
                  className="h-7 min-w-0 flex-1"
                />
              </div>
              {leadShown && (
                <div className="flex min-w-0 items-center gap-2" title={tr('channels.dialog.leadRouteHint')}>
                  <span className="min-w-0 flex-1 text-list text-fg-secondary">{tr('channels.dialog.leadRoute')}</span>
                  <Switch
                    size="sm"
                    checked={channel.leadRoute !== false}
                    label={tr('channels.dialog.leadRoute')}
                    onChange={on => update({ leadRoute: on })}
                  />
                </div>
              )}
              <div className="flex min-w-0 items-center gap-2" title={tr('channels.dialog.relayHint')}>
                <span className="min-w-0 flex-1 text-list text-fg-secondary">{tr('channels.dialog.relay')}</span>
                <Switch
                  size="sm"
                  checked={channel.relay === true}
                  label={tr('channels.dialog.relay')}
                  onChange={on => update({ relay: on })}
                />
              </div>
            </div>
          </Section>
        )}
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
        {(channel.notes || usage) && (
          <section className="flex flex-col gap-1">
            <button
              type="button"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(v => !v)}
              className="press flex items-center gap-1 rounded-md px-2 py-1 text-left text-label font-medium text-fg-muted hover:bg-hover"
            >
              <ChevronRight size={12} className={cn('shrink-0 transition-transform', moreOpen && 'rotate-90')} />
              {tr('channels.members.more')}
            </button>
            {moreOpen && (
              <dl className="mx-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-list">
                {usage && (
                  <dd
                    data-channel-usage=""
                    className="col-span-2 text-meta text-fg-muted"
                    title={usage.title || undefined}
                  >
                    {tr('channels.usage.channel', { usage: usage.text })}
                  </dd>
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
            )}
          </section>
        )}
      </div>
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
              ? [
                  {
                    label: tr('channels.channel.savePreset'),
                    icon: BookmarkPlus,
                    run: () => setDialog({ kind: 'savePreset' }),
                  },
                ]
              : []),
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
        <AgentDialog
          channel={channel}
          editing={dialog.editing}
          from={dialog.from}
          others={others}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'savePreset' && <SavePresetDialog channel={channel} onClose={() => setDialog(null)} />}
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
