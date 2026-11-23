// 设置 › 对话（docs/ui/settings-reorg.md §4）：原来外观页「对话」一组的 13 项，分成五个分组卡片
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
import { SectionTitle, SettingGroup } from './SettingRow'
import { StopBackgroundAgentsSettings } from './StopBackgroundAgentsSettings'
import { SubagentViewSettings } from './SubagentViewSettings'
import { TurnRailSettings } from './TurnRailSettings'

export function ChatSection() {
  useI18n()
  return (
    <section>
      <SectionTitle>{tr('settingsNav.chat')}</SectionTitle>

      <SettingGroup title={tr('settingsChat.composer')}>
        <ComposerStyleSettings />
        <QuotaDisplaySettings />
        <FullAccessStripSettings />
      </SettingGroup>

      <SettingGroup title={tr('settingsChat.messages')}>
        <ReplyStatsSettings />
        <MessageActionsSettings />
        <TurnRailSettings />
        <SubagentViewSettings />
      </SettingGroup>

      <SettingGroup title={tr('settingsChat.long')}>
        <LongConversationSettings />
        <OlderFoldSettings />
      </SettingGroup>

      <SettingGroup title={tr('settingsChat.running')}>
        <StopBackgroundAgentsSettings />
      </SettingGroup>

      <SettingGroup title={tr('settingsChat.tips')}>
        <CacheMissSettings />
        <PortTipSettings />
        <FeatureTipsSettings />
      </SettingGroup>
    </section>
  )
}
