import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Segmented } from '@/ui'
import { SettingRow } from './SettingRow'
import { setSubagentView, useSubagentView, type SubagentView } from './subagentView'

/** 设置 › 对话：子智能体显示成小框，还是展开在「执行」里（docs/ui/subagent-box.md） */
export function SubagentViewSettings() {
  useI18n()
  const value = useSubagentView()
  const options: { value: SubagentView; label: string }[] = [
    { value: 'box', label: tr('subagent.box') },
    { value: 'inline', label: tr('subagent.inline') },
  ]
  return (
    <SettingRow
      title={tr('subagent.setting')}
      description={tr('subagent.settingHint')}
      control={<Segmented label={tr('subagent.setting')} options={options} value={value} onChange={setSubagentView} />}
    />
  )
}
