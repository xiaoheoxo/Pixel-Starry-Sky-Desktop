import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { SettingRow, Toggle } from './SettingRow'
import { setOlderFoldOff, useOlderFoldOff } from '@/features/session/live/olderFoldSwitch'

/** 设置 › 外观 › 对话：只显示最近 2 轮（docs/ui/auto-fold.md §4） */
export function OlderFoldSettings() {
  useI18n()
  const off = useOlderFoldOff()
  return (
    <SettingRow
      title={tr('session.fold.setting.title')}
      description={tr('session.fold.setting.desc')}
      control={<Toggle label={tr('session.fold.setting.title')} checked={!off} onChange={on => setOlderFoldOff(!on)} />}
    />
  )
}
