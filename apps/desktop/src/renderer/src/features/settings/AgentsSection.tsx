import { useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { Button } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { channelActions, useChannels } from '@/features/channels/store'
import { agentMeta, MemberAvatar } from '@/features/channels/ChannelMessage'
import type { AgentMember } from '../../../../shared/types/channels'
import { SectionTitle } from './SettingRow'

/** 频道页的「管理 AI 成员」弹窗：频道列表左下角和没有频道时的空状态页都用 */
export function AgentsDialog({ onClose }: { onClose: () => void }) {
  useI18n()
  return (
    <ConfirmDialog
      wide
      hideConfirm
      title={tr('settingsAgents.manage')}
      confirmLabel=""
      cancelLabel={tr('settingsAgents.done')}
      busy={false}
      onConfirm={onClose}
      onCancel={onClose}
      description={<AgentsSection bare />}
    />
  )
}

/** 本机所有 AI 成员，可以全局删除（docs/ui/channels-local-rest.md §3.3 c）。
 *  频道页左下角的「管理 AI 成员」弹窗里用（bare：标题由弹窗给）；设置里的 agents 分区只留作旧入口（docs/ui/settings-reorg.md） */
export function AgentsSection({ bare }: { bare?: boolean }) {
  useI18n()
  const members = useChannels(s => s.members)
  const channels = useChannels(s => s.channels)
  const agents = members.filter((m): m is AgentMember => m.kind === 'agent' && !!m.config && !m.teamAgentId)
  const [deleting, setDeleting] = useState<AgentMember | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inChannels = (id: string) => channels.filter(c => c.scope === 'local' && c.memberIds.includes(id)).length
  const close = () => {
    setDeleting(null)
    setError(null)
  }
  return (
    <section data-agents-settings="">
      {!bare && <SectionTitle>{tr('agentsSettings.title')}</SectionTitle>}
      <p className="mb-4 text-meta text-fg-muted">{tr('agentsSettings.hint')}</p>
      {agents.length === 0 ? (
        <p className="text-meta text-fg-faint">{tr('agentsSettings.empty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line-subtle">
          {agents.map(m => (
            <li key={m.id} className="flex items-center gap-3 py-2.5">
              <MemberAvatar member={m} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-list text-fg">{m.name}</span>
                <span className="block truncate text-meta text-fg-muted">
                  {[
                    agentMeta(m),
                    m.project,
                    m.boundSession !== undefined ? tr('agentsSettings.bound') : null,
                    tr('agentsSettings.channels', { n: inChannels(m.id) }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <Button variant="ghost" onClick={() => setDeleting(m)}>
                {tr('agentsSettings.delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={tr('agentsSettings.deleteTitle', { name: deleting.name })}
          description={tr(
            deleting.boundSession !== undefined ? 'agentsSettings.deleteBodyBound' : 'agentsSettings.deleteBody',
          )}
          confirmLabel={tr('agentsSettings.delete')}
          cancelLabel={tr('channels.dialog.cancel')}
          busy={busy}
          error={error}
          onConfirm={() => {
            setBusy(true)
            setError(null)
            channelActions
              .deleteMember(deleting.id)
              .then(close, (e: unknown) => setError(translateMessage((e as Error)?.message ?? String(e))))
              .finally(() => setBusy(false))
          }}
          onCancel={close}
        />
      )}
    </section>
  )
}
