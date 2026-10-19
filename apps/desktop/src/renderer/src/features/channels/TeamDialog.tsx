// 新建团队、团队设置（docs/ui/channels-phase-c.md §3.2）。演示模式也能用，只改内存。
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LogOut, Trash2, X } from 'lucide-react'
import { Avatar, Button, cn, EngineIcon, IconButton, Select, useToast } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import type { AgentMember } from '@/data/types'
import type { TeamInfo, TeamRole } from '../../../../shared/types/channels'
import { channelActions, selfIdIn, useChannels } from './store'
import { formatLastSeen } from './format'
import { PresenceDot, PresenceAvatar, roleLabel, roleOptions } from './TeamParts'
import { canManageTeam, inviteDaysLeft, isValidEmail, normalizeEmail, sortTeamMembers } from './teamModel'
import { useFollowedDraft } from '@/ui/useFollowedDraft'

const INPUT =
  'w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-composer-ring disabled:opacity-60'

const errorText = (error: unknown) => translateMessage((error as Error)?.message ?? String(error))

// ---------------------------------------------------------------------------
// 新建团队
// ---------------------------------------------------------------------------

/** 新建团队：只有名字；建好后交给调用方打开团队设置（成员页，焦点在邀请输入框） */
export function CreateTeamDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (teamId: string) => void }) {
  useI18n()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    channelActions.createTeam(name).then(
      id => {
        onClose()
        onCreated(id)
      },
      e => {
        setError(errorText(e))
        setBusy(false)
      },
    )
  }
  return (
    <ConfirmDialog
      title={tr('team.create.title')}
      confirmLabel={tr('team.create.confirm')}
      cancelLabel={tr('channels.dialog.cancel')}
      busy={busy}
      error={error}
      focusInput
      confirmDisabled={!name.trim()}
      onConfirm={submit}
      onCancel={onClose}
      description={
        <form
          className="flex flex-col gap-3"
          onSubmit={e => {
            e.preventDefault()
            submit()
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-meta font-medium text-fg-muted">{tr('team.create.name')}</span>
            <input value={name} maxLength={40} onChange={e => setName(e.target.value)} className={INPUT} />
          </label>
          <p className="text-meta text-fg-faint">{tr('team.create.hint')}</p>
          <button type="submit" hidden />
        </form>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// 团队设置
// ---------------------------------------------------------------------------

type Tab = 'members' | 'settings'
type Confirm = { kind: 'remove'; userId: string } | { kind: 'leave' } | { kind: 'delete' } | null

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="px-2 text-label font-medium text-fg-muted">{title}</h4>
      {children}
    </section>
  )
}

/** 团队设置对话框（宽 560px）：成员 / 设置 两个标签 */
export function TeamSettingsDialog({
  teamId,
  tab: initialTab = 'members',
  focusInvite,
  onClose,
}: {
  teamId: string
  tab?: Tab
  /** 新建团队后打开：焦点给邀请输入框 */
  focusInvite?: boolean
  onClose: () => void
}) {
  useI18n()
  const team = useChannels(s => s.teams.find(t => t.id === teamId) ?? null)
  // 被移出、解散、退出之后团队没了，对话框跟着关
  useEffect(() => {
    if (!team) onClose()
  }, [team])
  if (!team) return null
  return <TeamSettings team={team} initialTab={initialTab} focusInvite={focusInvite} onClose={onClose} />
}

function TeamSettings({
  team,
  initialTab,
  focusInvite,
  onClose,
}: {
  team: TeamInfo
  initialTab: Tab
  focusInvite?: boolean
  onClose: () => void
}) {
  useI18n()
  const toast = useToast()
  const titleId = useId()
  const box = useRef<HTMLDivElement>(null)
  const inviteInput = useRef<HTMLInputElement>(null)
  const confirming = useRef(false)
  const members = useChannels(s => s.members)
  const selfId = useChannels(s =>
    selfIdIn(
      s,
      team.members.map(m => m.id),
    ),
  )
  const self = useChannels(s => s.members.find(m => m.id === selfId) ?? null)
  const names = useMemo(() => new Map(members.map(m => [m.id, m.name])), [members])
  const owner = canManageTeam(team.role)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Exclude<TeamRole, 'owner'>>('member')
  const [inviteError, setInviteError] = useState<string | null>(null)
  // 打开时成员可能还没加载完、团队名可能在别处改了：没动过的框跟着最新值
  const [teamName, setTeamName] = useFollowedDraft(team.name)
  const [displayName, setDisplayName] = useFollowedDraft(self?.name ?? '')
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [typed, setTyped] = useState('')
  confirming.current = confirm !== null
  // Esc 和点背景一样：保存 / 邀请进行中不关
  const busyRef = useRef(busy)
  busyRef.current = busy
  const now = Date.now()
  const sorted = useMemo(() => sortTeamMembers(team.members, names), [team.members, names])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    if (focusInvite) inviteInput.current?.focus()
    else box.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && !confirming.current && !busyRef.current) {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const run = (fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return
    setBusy(true)
    fn()
      .then(
        () => after?.(),
        e => toast(tr('channels.task.actionFailed', { error: errorText(e) })),
      )
      .finally(() => setBusy(false))
  }

  const sendInvite = () => {
    const address = normalizeEmail(email)
    if (!address) return setInviteError(tr('team.error.emailEmpty'))
    if (!isValidEmail(address)) return setInviteError(tr('team.error.emailInvalid'))
    setInviteError(null)
    run(
      () => channelActions.invite(team.id, address, inviteRole),
      () => {
        setEmail('')
        toast(tr('team.invite.sent', { email: address }))
      },
    )
  }

  const dirtyName = owner && !!teamName.trim() && teamName.trim() !== team.name
  const dirtyDisplay = !!displayName.trim() && displayName.trim() !== (self?.name ?? '')
  const save = () =>
    run(
      async () => {
        if (dirtyName) await channelActions.updateTeam(team.id, teamName.trim())
        if (dirtyDisplay) await channelActions.setDisplayName(team.id, displayName.trim())
      },
      () => toast(tr('team.settings.saved')),
    )

  const removing = confirm?.kind === 'remove' ? confirm.userId : null

  return createPortal(
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center bg-scrim p-4"
      onMouseDown={e => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="pop-in flex max-h-[min(640px,calc(100vh-32px))] w-[560px] max-w-full flex-col rounded-xl border border-line-card bg-popover text-fg shadow-popover outline-none"
      >
        <div className="flex shrink-0 items-center gap-2 pt-4 pr-3 pl-5">
          <h3 id={titleId} className="min-w-0 flex-1 truncate text-section font-semibold">
            {tr('team.settings.title')}
            <span className="ml-2 font-normal text-fg-muted">{team.name}</span>
          </h3>
          <IconButton icon={X} label={tr('team.settings.close')} size={28} iconSize={15} onClick={onClose} />
        </div>
        <div role="tablist" className="flex shrink-0 gap-4 border-b border-line-subtle px-5">
          {(['members', 'settings'] as const).map(id => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                '-mb-px h-9 border-b-2 text-ui transition-colors',
                tab === id
                  ? 'border-accent font-medium text-fg'
                  : 'border-transparent text-fg-muted hover:text-fg-secondary',
              )}
            >
              {tr(id === 'members' ? 'team.tab.members' : 'team.tab.settings')}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4 [scrollbar-width:thin]">
          {tab === 'members' ? (
            <>
              {owner && (
                <form
                  className="mx-2 flex flex-col gap-1.5"
                  onSubmit={e => {
                    e.preventDefault()
                    sendInvite()
                  }}
                >
                  <span className="text-meta font-medium text-fg-muted">{tr('team.invite.label')}</span>
                  <div className="flex items-center gap-2">
                    <input
                      ref={inviteInput}
                      type="email"
                      value={email}
                      aria-label={tr('team.invite.email')}
                      placeholder={tr('team.invite.email')}
                      onChange={e => {
                        setEmail(e.target.value)
                        setInviteError(null)
                      }}
                      className={INPUT}
                    />
                    <Select
                      label={tr('team.invite.roleLabel')}
                      value={inviteRole}
                      options={roleOptions()}
                      onChange={setInviteRole}
                      className="w-[112px] shrink-0"
                    />
                    <Button type="submit" variant="primary" disabled={busy || !email.trim()}>
                      {tr('team.invite.send')}
                    </Button>
                  </div>
                  {inviteError && (
                    <p role="alert" className="text-meta text-danger">
                      {inviteError}
                    </p>
                  )}
                </form>
              )}
              <Section title={tr('team.members.count', { count: team.members.length })}>
                {sorted.map(m => {
                  const you = m.id === selfId
                  const online = m.online || you
                  const name = names.get(m.id) ?? m.email ?? '?'
                  const seen = online ? null : formatLastSeen(m.lastSeenAt, now)
                  return (
                    <div key={m.id} className="flex h-11 min-w-0 items-center gap-2.5 rounded-md px-2 hover:bg-hover">
                      <PresenceAvatar name={name} size={28} />
                      <span className="min-w-0 truncate text-list text-fg">{name}</span>
                      {you && <span className="shrink-0 text-meta text-fg-muted">{tr('channels.youSuffix')}</span>}
                      {online ? (
                        <span className="flex shrink-0 items-center gap-1 text-meta text-fg-muted">
                          <PresenceDot online />
                          {tr('team.members.online')}
                        </span>
                      ) : (
                        seen && <span className="shrink-0 truncate text-meta text-fg-faint">{seen}</span>
                      )}
                      <span className="ml-auto flex shrink-0 items-center gap-2">
                        {owner && m.role !== 'owner' ? (
                          <>
                            <Select
                              label={tr('team.members.roleOf', { name })}
                              value={m.role as Exclude<TeamRole, 'owner'>}
                              options={roleOptions()}
                              onChange={role => run(() => channelActions.setRole(team.id, m.id, role))}
                              disabled={busy}
                              className="w-[112px]"
                            />
                            <Button
                              variant="ghost"
                              className="h-7 px-2.5 text-meta"
                              disabled={busy}
                              onClick={() => setConfirm({ kind: 'remove', userId: m.id })}
                            >
                              {tr('team.members.remove')}
                            </Button>
                          </>
                        ) : (
                          <span className="text-meta text-fg-faint">{roleLabel(m.role)}</span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </Section>
              {owner && team.invites.length > 0 && (
                <Section title={tr('team.members.pending', { count: team.invites.length })}>
                  {team.invites.map(invite => {
                    const days = inviteDaysLeft(invite.expiresAt, now)
                    return (
                      <div
                        key={invite.id}
                        className="flex h-11 min-w-0 items-center gap-2.5 rounded-md px-2 hover:bg-hover"
                      >
                        <Avatar name="?" size={28} className="opacity-60" />
                        <span className="min-w-0 truncate text-list text-fg">{invite.email}</span>
                        <span className="ml-auto shrink-0 text-meta text-fg-faint">
                          {days > 0
                            ? tr('team.invite.expires', { role: roleLabel(invite.role), days })
                            : tr('team.invite.expiresToday', { role: roleLabel(invite.role) })}
                        </span>
                        <Button
                          variant="ghost"
                          className="h-7 shrink-0 px-2.5 text-meta"
                          disabled={busy}
                          onClick={() => run(() => channelActions.revokeInvite(team.id, invite.id))}
                        >
                          {tr('team.invite.revoke')}
                        </Button>
                      </div>
                    )
                  })}
                </Section>
              )}
            </>
          ) : (
            <form
              className="mx-2 flex flex-col gap-4"
              onSubmit={e => {
                e.preventDefault()
                save()
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-meta font-medium text-fg-muted">{tr('team.settings.name')}</span>
                <input
                  value={teamName}
                  maxLength={40}
                  disabled={!owner}
                  onChange={e => setTeamName(e.target.value)}
                  className={INPUT}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-meta font-medium text-fg-muted">{tr('team.settings.displayName')}</span>
                <input
                  value={displayName}
                  maxLength={32}
                  onChange={e => setDisplayName(e.target.value)}
                  className={INPUT}
                />
              </label>
              <div>
                <Button type="submit" variant="primary" disabled={busy || (!dirtyName && !dirtyDisplay)}>
                  {tr('team.settings.save')}
                </Button>
              </div>
              <section className="flex flex-col gap-2 border-t border-line-subtle pt-4">
                <h4 className="text-meta font-medium text-danger">{tr('team.danger.title')}</h4>
                {owner ? (
                  <div className="flex items-center gap-3">
                    <p className="min-w-0 flex-1 text-meta text-fg-muted">{tr('team.delete.hint')}</p>
                    <Button
                      icon={Trash2}
                      className="shrink-0 border-danger/50 text-danger hover:border-danger"
                      disabled={busy}
                      onClick={() => {
                        setTyped('')
                        setConfirm({ kind: 'delete' })
                      }}
                    >
                      {tr('team.menu.delete')}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <p className="min-w-0 flex-1 text-meta text-fg-muted">{tr('team.leave.hint')}</p>
                    <Button
                      icon={LogOut}
                      className="shrink-0 border-danger/50 text-danger hover:border-danger"
                      disabled={busy}
                      onClick={() => setConfirm({ kind: 'leave' })}
                    >
                      {tr('team.leave.confirm')}
                    </Button>
                  </div>
                )}
              </section>
            </form>
          )}
        </div>
      </div>
      {removing && (
        <ConfirmDialog
          danger
          title={tr('team.members.removeTitle', { name: names.get(removing) ?? '?' })}
          description={tr('team.members.removeBody')}
          confirmLabel={tr('team.members.remove')}
          cancelLabel={tr('channels.dialog.cancel')}
          busy={busy}
          onConfirm={() =>
            run(
              () => channelActions.removeTeamMember(team.id, removing),
              () => setConfirm(null),
            )
          }
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'leave' && (
        <ConfirmDialog
          danger
          title={tr('team.leave.title', { name: team.name })}
          description={tr('team.leave.body')}
          confirmLabel={tr('team.leave.confirm')}
          cancelLabel={tr('channels.dialog.cancel')}
          busy={busy}
          onConfirm={() =>
            run(
              () => channelActions.removeTeamMember(team.id, selfId ?? ''),
              () => setConfirm(null),
            )
          }
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'delete' && (
        <ConfirmDialog
          danger
          title={tr('team.delete.title', { name: team.name })}
          focusInput
          confirmDisabled={typed.trim() !== team.name}
          description={
            <div className="flex flex-col gap-3">
              <p>{tr('team.delete.body')}</p>
              <label className="flex flex-col gap-1.5">
                <span className="text-meta font-medium text-fg-muted">
                  {tr('team.delete.type', { name: team.name })}
                </span>
                <input value={typed} onChange={e => setTyped(e.target.value)} className={INPUT} />
              </label>
            </div>
          }
          confirmLabel={tr('team.delete.confirm')}
          cancelLabel={tr('channels.dialog.cancel')}
          busy={busy}
          onConfirm={() =>
            run(
              () => channelActions.deleteTeam(team.id),
              () => setConfirm(null),
            )
          }
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// 把我的 AI 成员加进团队频道
// ---------------------------------------------------------------------------

/** 添加我的 AI 成员（docs/ui/channels-phase-c.md §3.3、§7）：只列自己的全局 AI 成员，写明哪些信息会同步给团队 */
export function AddTeamAgentDialog({
  channelId,
  candidates,
  onClose,
}: {
  channelId: string
  candidates: readonly AgentMember[]
  onClose: () => void
}) {
  useI18n()
  const [picked, setPicked] = useState<string | null>(candidates[0]?.id ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    if (!picked || busy) return
    setBusy(true)
    setError(null)
    channelActions.addMember(channelId, picked).then(onClose, e => {
      setError(errorText(e))
      setBusy(false)
    })
  }
  return (
    <ConfirmDialog
      title={tr('team.addAgent.title')}
      confirmLabel={tr('team.addAgent.add')}
      cancelLabel={tr('channels.dialog.cancel')}
      busy={busy}
      error={error}
      confirmDisabled={!picked}
      onConfirm={submit}
      onCancel={onClose}
      description={
        <div className="flex flex-col gap-3">
          {candidates.length === 0 ? (
            <p className="text-fg-muted">{tr('team.addAgent.empty')}</p>
          ) : (
            <div
              role="radiogroup"
              aria-label={tr('team.addAgent.title')}
              className="flex max-h-56 flex-col gap-px overflow-y-auto"
            >
              {candidates.map(a => (
                <label key={a.id} className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-1 hover:bg-hover">
                  <input type="radio" name="team-agent" checked={picked === a.id} onChange={() => setPicked(a.id)} />
                  <EngineIcon engine={a.engine} size={14} />
                  <span className="min-w-0 truncate text-list text-fg">{a.name}</span>
                  {a.project && <span className="ml-auto shrink-0 text-meta text-fg-faint">{a.project}</span>}
                </label>
              ))}
            </div>
          )}
          <p className="text-meta text-fg-muted">{tr('team.addAgent.privacy')}</p>
          <p className="text-meta text-fg-faint">{tr('team.addAgent.policyNote')}</p>
        </div>
      }
    />
  )
}
