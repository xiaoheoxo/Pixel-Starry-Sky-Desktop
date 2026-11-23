import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Segmented } from '@/ui'
import { useReducedMotion } from '@/features/appearance/ThemeProvider'
import { setModeTransition, useModeTransition } from '@/features/coding/modeTransition'
import type { ModeTransition } from '@/features/coding/modeTransitionModel'
import { SettingRow } from './SettingRow'

/** 设置 › 外观：「对话 | 代码」切换时的动画（docs/ui/mode-transition.md） */
export function ModeTransitionSettings() {
  useI18n()
  const reduced = useReducedMotion()
  const value = useModeTransition()
  const options: { value: ModeTransition; label: string }[] = [
    { value: 'slide', label: tr('coding.shell.transition.slide') },
    { value: 'fade', label: tr('coding.shell.transition.fade') },
    { value: 'off', label: tr('coding.shell.transition.off') },
  ]
  return (
    <SettingRow
      title={tr('coding.shell.transition.setting')}
      description={tr('coding.shell.transition.hint')}
      hint={reduced ? tr('coding.shell.transition.motionOff') : undefined}
      control={
        <Segmented
          label={tr('coding.shell.transition.setting')}
          options={options}
          value={value}
          onChange={setModeTransition}
          disabled={reduced}
        />
      }
    />
  )
}
