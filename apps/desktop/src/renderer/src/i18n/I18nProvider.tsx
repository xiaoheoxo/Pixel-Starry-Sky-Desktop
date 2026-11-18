import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Locale } from '../../../shared/i18n/messages'
import { tr, setCurrentLocale, translateText } from './core'
import { chooseLocale, localeOfSystem } from '../../../shared/i18n/systemLocale'

const STORAGE_KEY = 'pixelsky.locale'
interface I18nValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: typeof tr
  text: (value: string) => string
}
const I18nContext = createContext<I18nValue | null>(null)

const systemLanguages = (): readonly string[] =>
  typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]

/**
 * 现在用哪种语言（D330）：选过就用选的；没选过按系统语言。
 * first：启动时那一次——这台电脑上用过像素星空（存着别的设置）的老用户记成中文，升级后别突然变成英文
 */
function readLocale(first = false): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    let usedBefore = false
    if (first && stored === null)
      for (let i = 0; i < localStorage.length && !usedBefore; i++) {
        const key = localStorage.key(i)
        usedBefore = !!key && key.startsWith('pixelsky.') && key !== STORAGE_KEY
      }
    const { locale, persist } = chooseLocale(stored, usedBefore, systemLanguages())
    if (persist) localStorage.setItem(STORAGE_KEY, locale)
    return locale
  } catch {
    return localeOfSystem(systemLanguages())
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const initial = readLocale(true)
    setCurrentLocale(initial)
    return initial
  })
  const setLocale = (next: Locale): void => {
    setCurrentLocale(next)
    setLocaleState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 本次切换仍生效 */
    }
  }
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === STORAGE_KEY || event.key === null) {
        const next = readLocale()
        setCurrentLocale(next)
        setLocaleState(next)
      }
    }
    window.addEventListener('storage', onStorage)
    document.documentElement.dataset.locale = locale
    document.documentElement.lang = locale
    document.title = locale === 'en-US' ? 'Pixel Starry Sky' : '像素星空'
    void window.pixelsky?.setLocale(locale).catch(console.error)
    return () => window.removeEventListener('storage', onStorage)
  }, [locale])
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      t: tr,
      text: translateText,
    }),
    [locale],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n 必须在 I18nProvider 内使用')
  return value
}
