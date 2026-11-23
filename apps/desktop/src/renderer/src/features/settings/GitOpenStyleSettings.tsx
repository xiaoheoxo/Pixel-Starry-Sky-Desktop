import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Segmented } from '@/ui'
import { setGitOpenStyle, useGitOpenStyle } from '@/features/coding/editor/gitOpenStyle'
import type { GitOpenStyle } from '@/features/coding/editor/gitDiffModel'
import { SettingRow } from './SettingRow'

/** 设置 › 编辑器：代码模式里点 Git 改动打开成文件标签（样式 A）还是「Git 对比」标签（样式 B），docs/ui/coding-mode.md §3.3.2 */
export function GitOpenStyleSettings() {
  useI18n()
  const value = useGitOpenStyle()
  const options: { value: GitOpenStyle; label: string }[] = [
    { value: 'file', label: tr('coding.gitOpen.file') },
    { value: 'diff', label: tr('coding.gitOpen.diff') },
  ]
  return (
    <SettingRow
      title={tr('coding.gitOpen.setting')}
      description={tr('coding.gitOpen.hint')}
      control={
        <Segmented label={tr('coding.gitOpen.setting')} options={options} value={value} onChange={setGitOpenStyle} />
      }
    />
  )
}
