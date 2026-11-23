// 设置 › AI 辅助（docs/ui/settings-reorg.md §4）：AI 写提交信息、优化提示词（共用一条通道）和语音输入
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { VoiceSettings } from '@/features/voice/VoiceSettings'
import { AiCommitSettings } from './models/AiCommitSettings'
import { SectionTitle, SettingGroup } from './SettingRow'

export function AssistSection() {
  useI18n()
  return (
    <section>
      <SectionTitle>{tr('settingsNav.assist')}</SectionTitle>
      <AiCommitSettings />
      <SettingGroup title={tr('voice.settings.title')} className="mt-5">
        <VoiceSettings />
      </SettingGroup>
    </section>
  )
}
