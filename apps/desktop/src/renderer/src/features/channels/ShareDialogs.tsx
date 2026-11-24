// 共享到团队、改回只有我（docs/ui/channels-unify.md §1、§5.2）
import { useState } from 'react'
import { Cloud, Monitor } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { Select, useToast } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import type { AgentMember, Channel } from '@/data/types'
import type { AgentPolicy } from '../../../../shared/types/channels'
import { channelActions, useChannels } from './store'
import { AUD_NEW, AudiencePicker } from './AudiencePicker'
import { agentMeta, MemberAvatar } from './ChannelMessage'
import { canCreateChannel } from './teamModel'

const errorText = (error: unknown) => translateMessage((error as Error)?.message ?? String(error))

/** 共享时能选的规则（和主进程 SHARE_POLICIES 一致）；「指定的人直接派」要名单，共享之后在成员栏里设 */
const POLICIES: readonly AgentPolicy[] = ['approve', 'owner', 'team']

function Facts({ icon: Icon, title, items }: { icon: typeof Cloud; title: string; items: string[] }) {
  return (
    <div className="min-w-0 rounded-lg bg-subtle px-3 py-2">
      <h4 className="flex items-center gap-1.5 text-meta font-medium text-fg-secondary">
        <Icon size={13} strokeWidth={1.5} className="shrink-0" />
        {title}
      </h4>
      <ul className="mt-1 list-disc pl-4 text-meta text-fg-muted">
        {items.map(text => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 邀请队友进一个只有我的频道：选团队（或顺手新建一个）、带哪些自己的 AI 成员进去、各自谁能派活；
 * 写明会上传什么、什么留在本机。以前的消息不上传，原频道归档留作记录
 */
export function ShareChannelDialog({
  channel,
  agents,
  onClose,
}: {
  channel: Channel
  /** 这个频道里的 AI 成员 */
  agents: readonly AgentMember[]
  onClose: () => void
}) {
  useI18n()
  const toast = useToast()
  const teams = useChannels(s => s.teams)
  const connection = useChannels(s => s.teamsConnection)
  const [aud, setAud] = useState(() => teams.find(t => canCreateChannel(t.role))?.id ?? AUD_NEW)
  const [newTeam, setNewTeam] = useState('')
  // 带进去的成员 → 规则；没在里面的不带
  const [picked, setPicked] = useState<Record<string, AgentPolicy>>(() =>
    Object.fromEntries(agents.map(a => [a.id, 'approve' as AgentPolicy])),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = connection === 'online' && (aud === AUD_NEW ? !!newTeam.trim() : teams.some(t => t.id === aud))
  const submit = () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    // 新建团队成功后记下来：共享没成再点一次不会又建一个团队
    const team =
      aud === AUD_NEW
        ? channelActions.createTeam(newTeam).then(id => {
            setAud(id)
            return id
          })
        : Promise.resolve(aud)
    team
      .then(id => channelActions.shareChannel(channel.id, id, picked))
      .then(
        failed => {
          if (failed.length) toast(tr('unify.share.failed', { names: failed.join(tr('channels.composer.nameSep')) }))
          else toast(tr('unify.share.done'))
          onClose()
        },
        e => {
          setError(errorText(e))
          setBusy(false)
        },
      )
  }
  return (
    <ConfirmDialog
      wide
      title={tr('unify.share.title', { name: channel.name })}
      confirmLabel={tr(aud === AUD_NEW ? 'unify.share.confirmNew' : 'unify.share.confirm')}
      cancelLabel={tr('channels.dialog.cancel')}
      busy={busy}
      error={error}
      confirmDisabled={!ready}
      dirty={!!newTeam.trim()}
      onConfirm={submit}
      onCancel={onClose}
      description={
        <div data-share-dialog="" className="flex flex-col gap-3">
          <AudiencePicker value={aud} onChange={setAud} teamName={newTeam} onTeamName={setNewTeam} withMe={false} />
          <fieldset className="flex min-w-0 flex-col gap-1">
            <legend className="mb-1.5 p-0 text-meta font-medium text-fg-muted">{tr('unify.share.members')}</legend>
            {agents.length === 0 && <p className="text-meta text-fg-faint">{tr('unify.share.none')}</p>}
            {agents.map(a => {
              const on = a.id in picked
              return (
                <div key={a.id} data-share-agent={a.id} className="flex min-w-0 items-center gap-2.5 py-1">
                  <input
                    type="checkbox"
                    aria-label={a.name}
                    checked={on}
                    onChange={e =>
                      setPicked(cur => {
                        const { [a.id]: _, ...rest } = cur
                        return e.target.checked ? { ...rest, [a.id]: 'approve' } : rest
                      })
                    }
                  />
                  <MemberAvatar member={a} size={24} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-list text-fg">{a.name}</span>
                    <span className="block truncate text-meta text-fg-faint">
                      {[agentMeta(a), a.project].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {on && (
                    <Select
                      label={tr('unify.share.policy', { name: a.name })}
                      value={picked[a.id]}
                      options={POLICIES.map(p => ({ value: p, label: tr(`team.policy.${p}`) }))}
                      onChange={p => setPicked(cur => ({ ...cur, [a.id]: p }))}
                      className="h-7 w-[168px] shrink-0"
                    />
                  )}
                </div>
              )
            })}
            {agents.length > 0 && <p className="text-meta text-fg-faint">{tr('unify.share.membersHint')}</p>}
          </fieldset>
          <div className="grid grid-cols-2 gap-2 @max-[520px]:grid-cols-1">
            <Facts
              icon={Cloud}
              title={tr('unify.share.uploads')}
              items={[tr('unify.share.uploads.1'), tr('unify.share.uploads.2'), tr('unify.share.uploads.3')]}
            />
            <Facts
              icon={Monitor}
              title={tr('unify.share.stays')}
              items={[tr('unify.share.stays.1'), tr('unify.share.stays.2'), tr('unify.share.stays.3')]}
            />
          </div>
          <p className="text-meta text-warn">{tr('unify.share.limits')}</p>
        </div>
      }
    />
  )
}

/** 把团队的频道改回只有我：只有团队所有者能点到这里 */
export function UnshareChannelDialog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  useI18n()
  const toast = useToast()
  const team = useChannels(s => s.teams.find(t => t.id === channel.teamId)?.name ?? '?')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <ConfirmDialog
      danger
      title={tr('unify.unshare.title', { name: channel.name })}
      confirmLabel={tr('unify.unshare.confirm')}
      cancelLabel={tr('channels.dialog.cancel')}
      busy={busy}
      error={error}
      onConfirm={() => {
        setBusy(true)
        setError(null)
        channelActions.unshareChannel(channel.id).then(
          () => {
            toast(tr('unify.unshare.done'))
            onClose()
          },
          e => {
            setError(errorText(e))
            setBusy(false)
          },
        )
      }}
      onCancel={onClose}
      description={
        <div data-unshare-dialog="" className="flex flex-col gap-2">
          <p>{tr('unify.unshare.body', { team })}</p>
          <p className="text-fg-muted">{tr('unify.unshare.keep')}</p>
        </div>
      }
    />
  )
}
