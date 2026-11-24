// 「谁能看到」（docs/ui/channels-unify.md §1）：新建频道、共享到团队时选只有我、某个团队，或顺手新建一个团队
import { useMemo, type ReactNode } from 'react'
import { Lock, Plus, Users, type LucideIcon } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Button, cn } from '@/ui'
import { useAccount } from '@/features/account'
import type { TeamInfo } from '../../../../shared/types/channels'
import { useChannels } from './store'
import { canCreateChannel } from './teamModel'

/** 只有我（本机频道） */
export const AUD_ME = 'me'
/** 新建一个团队再建频道 */
export const AUD_NEW = 'new'

const INPUT =
  'w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-composer-ring'

/** 团队里的人名，最多列 4 个 */
export function teamPeople(team: TeamInfo, names: ReadonlyMap<string, string>, limit = 4): string {
  const list = team.members.map(m => names.get(m.id)).filter((n): n is string => !!n)
  const shown = list.slice(0, limit).join(tr('channels.composer.nameSep'))
  return list.length > limit ? tr('unify.aud.namesMore', { names: shown, count: list.length - limit }) : shown
}

function Option({
  icon: Icon,
  title,
  hint,
  checked,
  disabled,
  onPick,
  value,
  children,
}: {
  icon: LucideIcon
  title: string
  hint: string
  checked: boolean
  disabled?: boolean
  onPick: () => void
  value: string
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border transition-colors',
        checked ? 'border-accent-line bg-accent-soft' : 'border-line-subtle bg-subtle',
        !checked && !disabled && 'hover:bg-hover',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled}
        data-audience={value}
        onClick={onPick}
        className="flex w-full min-w-0 items-start gap-2.5 rounded-lg px-3 py-2 text-left disabled:opacity-50"
      >
        <Icon
          size={15}
          strokeWidth={1.5}
          className={cn('mt-0.5 shrink-0', checked ? 'text-accent-fg' : 'text-fg-muted')}
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-list font-medium text-fg">{title}</span>
          <span className="text-meta break-words text-fg-muted">{hint}</span>
        </span>
      </button>
      {children}
    </div>
  )
}

/**
 * 选谁能看到。withMe：列不列「只有我」（共享到团队时不列）。
 * 选「新建团队…」时下面出团队名字的输入框；没登录时团队那几项换成登录入口，连不上云端时团队选不了
 */
export function AudiencePicker({
  value,
  onChange,
  teamName,
  onTeamName,
  withMe = true,
}: {
  value: string
  onChange: (value: string) => void
  teamName: string
  onTeamName: (name: string) => void
  withMe?: boolean
}) {
  useI18n()
  const account = useAccount()
  const teams = useChannels(s => s.teams)
  const connection = useChannels(s => s.teamsConnection)
  const members = useChannels(s => s.members)
  const names = useMemo(() => new Map(members.map(m => [m.id, m.name])), [members])
  // 云端没有团队接口：只有「只有我」，不用选
  if (connection === 'unavailable') return null
  const offline = connection === 'offline' || connection === 'connecting'
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 p-0 text-meta font-medium text-fg-muted">{tr('unify.aud.title')}</legend>
      <div role="radiogroup" aria-label={tr('unify.aud.title')} className="flex flex-col gap-1.5">
        {withMe && (
          <Option
            icon={Lock}
            value={AUD_ME}
            title={tr('unify.aud.me')}
            hint={tr('unify.aud.meHint')}
            checked={value === AUD_ME}
            onPick={() => onChange(AUD_ME)}
          />
        )}
        {connection === 'signed-out' ? (
          <div className="flex items-center gap-2.5 rounded-lg border border-line-subtle bg-subtle px-3 py-2">
            <Users size={15} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-list font-medium text-fg">{tr('unify.aud.signIn')}</span>
              <span className="text-meta text-fg-muted">{tr('unify.aud.signInHint')}</span>
            </span>
            <Button
              className="h-7 shrink-0 px-2.5 text-meta"
              disabled={account.status === 'signing-in'}
              onClick={() => void account.login()}
            >
              {tr('team.signIn')}
            </Button>
          </div>
        ) : (
          <>
            {teams
              .filter(t => canCreateChannel(t.role))
              .map(t => (
                <Option
                  key={t.id}
                  icon={Users}
                  value={t.id}
                  title={t.name}
                  hint={tr('unify.aud.teamHint', { count: t.members.length, names: teamPeople(t, names) })}
                  checked={value === t.id}
                  disabled={offline}
                  onPick={() => onChange(t.id)}
                />
              ))}
            <Option
              icon={Plus}
              value={AUD_NEW}
              title={tr('unify.aud.newTeam')}
              hint={tr('unify.aud.newTeamHint')}
              checked={value === AUD_NEW}
              disabled={offline}
              onPick={() => onChange(AUD_NEW)}
            >
              {value === AUD_NEW && (
                <label className="flex flex-col gap-1.5 px-3 pb-3">
                  <span className="text-meta font-medium text-fg-muted">{tr('team.create.name')}</span>
                  <input
                    value={teamName}
                    maxLength={40}
                    data-audience-team-name=""
                    onChange={e => onTeamName(e.target.value)}
                    className={INPUT}
                  />
                </label>
              )}
            </Option>
            {offline && <p className="text-meta text-warn">{tr('unify.aud.offline')}</p>}
          </>
        )}
      </div>
    </fieldset>
  )
}
