import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useToast } from '@/ui'
import type { Channel, ChannelMember } from '@/data/types'
import { DEFAULT_LEAD_AUTO } from '../../../../shared/types/channels'
import { channelActions, useChannels } from './store'

/**
 * 输入框上方一行：@ 和不 @ 分别会怎样。牵头分派开着（leadRoute，没关掉就算开着）时，不 @ 的简单活由牵头直接派给合适的人
 *（docs/ui/channels-auto-route.md）。
 * 先出计划（planFirst，没关掉就算开着）：@ 谁就由谁先出计划，点开工才动手；关掉时 @ 成员直接派。
 * 不 @：有牵头先出分工提案，点开始才派活；没有牵头只是留言。
 * 设了牵头、还没设过自动放行的频道（升级前建的）：下面再一行，问一次要不要打开（docs/ui/channels-lead-auto-approve.md §2.2）
 */
export function LeadHint({ channel, members }: { channel: Channel; members: readonly ChannelMember[] }) {
  useI18n()
  const toast = useToast()
  const locked = useChannels(s => s.leadAutoPolicy) === 'locked'
  if (!members.some(m => m.kind === 'agent')) return null
  const lead = channel.lead ? members.find(m => m.id === channel.lead) : undefined
  const planFirst = channel.planFirst !== false
  const route = channel.leadRoute !== false
  const text = planFirst
    ? lead
      ? tr(route ? 'channels.hint.planLeadRoute' : 'channels.hint.planLead', { name: lead.name })
      : tr('channels.hint.planNoLead')
    : lead
      ? tr(route ? 'channels.hint.leadRoute' : 'channels.hint.lead', { name: lead.name })
      : tr('channels.hint.noLead')
  const offer = !!lead && !channel.leadAutoSet && !locked && !channel.archivedAt
  const decide = (on: boolean) =>
    void channelActions
      .updateChannel(channel.id, { leadAuto: { ...(channel.leadAuto ?? DEFAULT_LEAD_AUTO), on } })
      .catch(e => toast(translateMessage((e as Error).message)))
  return (
    <>
      <p
        title={text}
        className="conversation-inset conversation-reading shrink-0 truncate pb-1 text-meta text-fg-faint"
      >
        {text}
      </p>
      {offer && (
        <p
          data-lead-auto-offer
          className="conversation-inset conversation-reading flex shrink-0 items-center gap-2 pb-1 text-meta text-fg-muted"
        >
          <span className="min-w-0 truncate">{tr('channels.leadAuto.offer')}</span>
          <button
            type="button"
            onClick={() => decide(true)}
            className="press shrink-0 rounded px-1 text-accent-fg hover:bg-hover"
          >
            {tr('channels.leadAuto.offerOpen')}
          </button>
          <button
            type="button"
            onClick={() => decide(false)}
            className="press shrink-0 rounded px-1 text-fg-muted hover:bg-hover"
          >
            {tr('channels.leadAuto.offerNo')}
          </button>
        </p>
      )}
    </>
  )
}
