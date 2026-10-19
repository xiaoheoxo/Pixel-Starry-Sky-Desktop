// 主题：跟随系统 / 浅色 / 深色，写到 <html data-theme>（tokens.css 按它切换）
import { useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export const THEMES = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const

const KEY = 'pixelsky.mobile.theme'
const dark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

export function applyTheme(pref: ThemePreference = (localStorage.getItem(KEY) as ThemePreference) ?? 'system'): void {
  // 演示模式截图用：?theme=light|dark 盖过设置（只在 vite dev 里）
  const forced = import.meta.env.DEV ? new URLSearchParams(location.search).get('theme') : null
  if (forced === 'light' || forced === 'dark') pref = forced
  const resolved = pref === 'system' ? (dark() ? 'dark' : 'light') : pref
  document.documentElement.dataset.theme = resolved
  // 浏览器顶栏的颜色跟着面板底色（取设计变量的值，不写死颜色）
  const panel = getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim()
  if (panel) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', panel)
}

export function useThemePreference(): [ThemePreference, (p: ThemePreference) => void] {
  const [pref, setPref] = useState<ThemePreference>(() => (localStorage.getItem(KEY) as ThemePreference) ?? 'system')
  useEffect(() => {
    applyTheme(pref)
    if (pref !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pref])
  return [
    pref,
    p => {
      localStorage.setItem(KEY, p)
      setPref(p)
    },
  ]
}
