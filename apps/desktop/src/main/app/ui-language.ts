import { app, BrowserWindow } from 'electron'
import * as ipc from '../ipc/guard'
import type { Locale } from '../../shared/i18n/messages'
import { translateMessage } from '../../shared/i18n/translate'
import { localeOfSystem } from '../../shared/i18n/systemLocale'
import { isSettingsWindow } from './settingsWindowRegistry'
import { settingsWindowTitle } from './settings-window-state'

const languages = new WeakMap<BrowserWindow, Locale>()
/** 窗口还没报过语言时按系统语言（D330）；app 就绪前 getLocale 拿不到，用 Node 的默认区域 */
let lastLanguage: Locale | null = null
export function systemUiLocale(): Locale {
  return localeOfSystem([app.isReady() ? app.getLocale() : Intl.DateTimeFormat().resolvedOptions().locale])
}
export function windowLocale(win?: BrowserWindow | null): Locale {
  return (win ? languages.get(win) : undefined) ?? lastLanguage ?? systemUiLocale()
}
export function nativeText(win: BrowserWindow | null | undefined, value: string): string {
  return translateMessage(value, windowLocale(win))
}
export function initUiLanguage(onChange: (language: Locale) => void): void {
  ipc.handle(
    'ui:locale',
    (event, language: unknown) => {
      if (language !== 'zh-CN' && language !== 'en-US') throw new Error('不支持的语言')
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return
      lastLanguage = language
      languages.set(win, language)
      win.setTitle(
        isSettingsWindow(win) ? settingsWindowTitle(language) : language === 'en-US' ? 'Pixel Starry Sky' : '像素星空',
      )
      onChange(language)
    },
    { deny: '不允许的调用方' },
  )
}
