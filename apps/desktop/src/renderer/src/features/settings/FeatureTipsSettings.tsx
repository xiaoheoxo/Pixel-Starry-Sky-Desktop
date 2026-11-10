import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Button, useToast } from '@/ui'
import { SettingRow, Toggle } from './SettingRow'
import { resetTips, setTipsOff, useTips } from '@/features/tips/featureTips'

/** 设置 › 外观 › 对话：功能提示总开关和「全部重新显示」（docs/ui/feature-tips.md） */
export function FeatureTipsSettings() {
  useI18n()
  const toast = useToast()
  const { off, seen } = useTips()
  return (
    <SettingRow
      title={tr('tips.setting.title')}
      description={tr('tips.setting.desc')}
      control={
        <div className="flex items-center gap-3">
          <Button
            className="h-7 px-2.5 text-meta"
            disabled={!off && seen.length === 0}
            onClick={() => {
              resetTips()
              toast(tr('tips.setting.resetDone'))
            }}
          >
            {tr('tips.setting.reset')}
          </Button>
          <Toggle label={tr('tips.setting.title')} checked={!off} onChange={on => setTipsOff(!on)} />
        </div>
      }
    />
  )
}
