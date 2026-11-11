// 设置 › 对话（docs/ui/settings-reorg.md §4）：原来外观页「对话」一组的 13 项，分成五个小标题
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { CacheMissSettings } from './CacheMissSettings'
import { ComposerStyleSettings } from './ComposerStyleSettings'
import { FeatureTipsSettings } from './FeatureTipsSettings'
import { FullAccessStripSettings } from './FullAccessStripSettings'
import { LongConversationSettings } from './LongConversationSettings'
import { MessageActionsSettings } from './MessageActionsSettings'
import { OlderFoldSettings } from './OlderFoldSettings'
import { PortTipSettings } from './PortTipSettings'
import { QuotaDisplaySettings } from './QuotaDisplaySettings'
import { ReplyStatsSettings } from './ReplyStatsSettings'
import { GroupTitle, SectionTitle } from './SettingRow'
import { StopBackgroundAgentsSettings } from './StopBackgroundAgentsSettings'
import { SubagentViewSettings } from './SubagentViewSettings'
import { TurnRailSettings } from './TurnRailSettings'

export function ChatSection() {
  useI18n()
  return (
    <section>
      <SectionTitle>{tr('settingsNav.chat')}</SectionTitle>
      <GroupTitle>{tr('settingsChat.composer')}</GroupTitle>
      <ComposerStyleSettings />
      <QuotaDisplaySettings />
      <FullAccessStripSettings />

      <GroupTitle>{tr('settingsChat.messages')}</GroupTitle>
      <ReplyStatsSettings />
      <MessageActionsSettings />
      <TurnRailSettings />
      <SubagentViewSettings />

      <GroupTitle>{tr('settingsChat.long')}</GroupTitle>
      <LongConversationSettings />
      <OlderFoldSettings />

      <GroupTitle>{tr('settingsChat.running')}</GroupTitle>
      <StopBackgroundAgentsSettings />

      <GroupTitle>{tr('settingsChat.tips')}</GroupTitle>
      <CacheMissSettings />
      <PortTipSettings />
      <FeatureTipsSettings />
    </section>
  )
}
