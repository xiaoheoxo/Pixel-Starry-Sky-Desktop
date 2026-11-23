import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Segmented } from '@/ui'
import { SettingRow } from './SettingRow'
import { setMessageActionsPosition, useMessageActionsPosition, type MessageActionsPosition } from './messageActions'

/** 设置 › 对话：你发的消息上的操作按钮放在气泡左侧还是下方（GitHub #28） */
export function MessageActionsSettings() {
  useI18n()
  const position = useMessageActionsPosition()
  const options: { value: MessageActionsPosition; label: string }[] = [
    { value: 'left', label: tr('messageActions.left') },
    { value: 'below', label: tr('messageActions.below') },
  ]
  return (
    <SettingRow
      title={tr('messageActions.setting')}
      description={tr('messageActions.settingHint')}
      control={
        <Segmented
          label={tr('messageActions.setting')}
          options={options}
          value={position}
          onChange={setMessageActionsPosition}
        />
      }
    />
  )
}
