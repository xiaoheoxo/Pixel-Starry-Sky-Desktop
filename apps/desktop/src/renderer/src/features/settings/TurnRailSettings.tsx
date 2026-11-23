import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Segmented } from '@/ui'
import { SettingRow } from './SettingRow'
import { setTurnRailSide, useTurnRailOn } from './turnRail'

/** 设置 › 对话：滚动条上显示轮次（docs/ui/turn-rail.md §3、§8）；关掉时只剩滚动条 */
export function TurnRailSettings() {
  useI18n()
  const on = useTurnRailOn()
  const options: { value: 'on' | 'off'; label: string }[] = [
    { value: 'on', label: tr('turnRail.on') },
    { value: 'off', label: tr('turnRail.off') },
  ]
  return (
    <SettingRow
      title={tr('turnRail.setting')}
      description={tr('turnRail.settingHint')}
      control={
        <Segmented
          label={tr('turnRail.setting')}
          options={options}
          value={on ? 'on' : 'off'}
          onChange={v => setTurnRailSide(v === 'on' ? 'right' : 'off')}
        />
      }
    />
  )
}
