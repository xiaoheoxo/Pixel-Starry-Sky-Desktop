import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Segmented } from '@/ui'
import { SettingRow } from './SettingRow'
import { setLongConversation, useLongConversation, type LongConversationChoice } from './longConversation'

/** 设置 › 对话：长对话先显示最近几轮（docs/ui/turn-rail.md §9）；全部 = 不折叠 */
export function LongConversationSettings() {
  useI18n()
  const value = useLongConversation()
  const options: { value: LongConversationChoice; label: string }[] = [
    { value: '20', label: tr('longConversation.n20') },
    { value: '50', label: tr('longConversation.n50') },
    { value: 'all', label: tr('longConversation.all') },
  ]
  return (
    <SettingRow
      title={tr('longConversation.setting')}
      description={tr('longConversation.settingHint')}
      control={
        <Segmented
          label={tr('longConversation.setting')}
          options={options}
          value={value}
          onChange={setLongConversation}
        />
      }
    />
  )
}
