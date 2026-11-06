import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useToast } from '@/ui'
import { GroupTitle, SettingRow, Toggle } from './SettingRow'

/** 对话运行时不让电脑睡眠。值存在手机的设置文件里（老用户的选择不用迁移），和手机开关无关 */
export function KeepAwakeSettings() {
  useI18n()
  const bridge = window.pixelsky?.mobile
  const toast = useToast()
  const [keepAwake, setKeepAwake] = useState<boolean | null>(null)
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge
      .state()
      .then(s => alive && setKeepAwake(s.prefs.keepAwake))
      .catch(() => undefined)
    // 设置弹窗和独立设置窗口可能同时开着
    const off = bridge.onChange(s => setKeepAwake(s.prefs.keepAwake))
    return () => {
      alive = false
      off()
    }
  }, [bridge])
  // 没读到值也先显示这一行：搜索跳转只等很短的时间，晚出现就定位不到
  if (!bridge) return null
  return (
    <>
      <GroupTitle>{tr('notifications.keepAwake.group')}</GroupTitle>
      <SettingRow
        title={tr('notifications.keepAwake.title')}
        description={tr('notifications.keepAwake.desc')}
        control={
          <Toggle
            label={tr('notifications.keepAwake.title')}
            checked={keepAwake ?? false}
            onChange={next => {
              setKeepAwake(next)
              void bridge.setPrefs({ keepAwake: next }).then(
                s => setKeepAwake(s.prefs.keepAwake),
                (e: Error) => {
                  // 没存上：退回去，免得界面和实际行为对不上
                  setKeepAwake(!next)
                  toast(translateMessage(e?.message ?? String(e)))
                },
              )
            }}
          />
        }
      />
    </>
  )
}
