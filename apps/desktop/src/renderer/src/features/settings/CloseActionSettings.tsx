import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { Segmented, useToast } from '@/ui'
import { SettingRow } from './SettingRow'

type CloseAction = 'hide' | 'quit'

/** 关闭主窗口时：隐藏到托盘（任务继续）或退出（docs/ui/tray.md §2.3）。设置存在主进程，演示 / 浏览器里不显示 */
export function CloseActionSettings() {
  useI18n()
  const tray = window.pixelsky?.tray
  const toast = useToast()
  const [value, setValue] = useState<CloseAction | null>(null)
  // 连点两次时只认最后一次的结果（先点的晚到失败不把后点的回滚掉）
  const request = useRef(0)
  useEffect(() => {
    if (!tray) return
    let alive = true
    void tray
      .prefs()
      .then(p => alive && setValue(p.closeToTray ? 'hide' : 'quit'))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [tray])
  if (!tray || value === null) return null
  return (
    <SettingRow title={tr('tray.closeAction')} description={tr('tray.closeActionDescription')}>
      <Segmented
        label={tr('tray.closeAction')}
        options={[
          { value: 'hide', label: tr('tray.closeHide') },
          { value: 'quit', label: tr('tray.closeQuit') },
        ]}
        value={value}
        onChange={next => {
          const prev = value
          const n = ++request.current
          setValue(next)
          void tray
            .setPrefs({ closeToTray: next === 'hide' })
            .then(p => n === request.current && setValue(p.closeToTray ? 'hide' : 'quit'))
            .catch((e: Error) => {
              if (n !== request.current) return
              // 没存上：退回原来的选项，免得界面和实际行为对不上
              setValue(prev)
              toast(tr('tray.closeActionFailed', { error: translateMessage(e?.message ?? String(e)) }))
            })
        }}
      />
    </SettingRow>
  )
}
