import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import type { Channel, ChannelMember } from '@/data/types'

/**
 * 输入框上方一行：@ 和不 @ 分别会怎样。牵头分派开着（leadRoute，没关掉就算开着）时，不 @ 的简单活由牵头直接派给合适的人
 *（docs/ui/channels-auto-route.md）。
 * 先出计划（planFirst，没关掉就算开着）：@ 谁就由谁先出计划，点开工才动手；关掉时 @ 成员直接派。
 * 不 @：有牵头先出分工提案，点开始才派活；没有牵头只是留言
 */
export function LeadHint({ channel, members }: { channel: Channel; members: readonly ChannelMember[] }) {
  useI18n()
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
  return (
    <p title={text} className="conversation-inset conversation-reading shrink-0 truncate pb-1 text-meta text-fg-faint">
      {text}
    </p>
  )
}
