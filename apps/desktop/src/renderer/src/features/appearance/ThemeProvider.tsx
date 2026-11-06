import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { hasWallpaper } from '@/features/appearance/wallpaper'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { isDemo } from '@/data'
import { PANE_FOCUS_MOTION_KEY, readPaneFocusMotion, type PaneFocusMotion } from './paneFocusMotion'
import { MINIMAL_MODE_KEY, readMinimalMode, type MinimalMode } from './minimalMode'
import { usePalette, windowBackground } from './palette'
import { useCustomThemes } from './customTheme'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
/** 动画：始终开启 / 跟随系统 / 关闭（docs/ui/settings.md §3.1） */
export type MotionPreference = 'on' | 'system' | 'off'

interface ThemeContextValue {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
  motion: MotionPreference
  setMotion: (motion: MotionPreference) => void
  paneFocusMotion: PaneFocusMotion
  setPaneFocusMotion: (motion: PaneFocusMotion) => void
  /** 极简模式（docs/ui/minimal-mode.md） */
  minimal: MinimalMode
  setMinimal: (minimal: MinimalMode) => void
  /** 系统是否要求减少动态效果（Windows「动画效果」关闭时为 true） */
  systemReducedMotion: boolean
}

const STORAGE_KEY = 'pixelsky.theme'
const MOTION_KEY = 'pixelsky.motion'
const ThemeContext = createContext<ThemeContextValue | null>(null)

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    // localStorage 不可用时使用默认值
  }
  return 'system'
}

function readMotion(): MotionPreference {
  try {
    const value = localStorage.getItem(MOTION_KEY)
    if (value === 'on' || value === 'system' || value === 'off') return value
  } catch {
    // localStorage 不可用时使用默认值
  }
  return 'on'
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 忽略
  }
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 外观偏好：主题（浅色 / 深色 / 跟随系统）和动画（始终开启 / 跟随系统 / 关闭）。
 *  规则见 docs/ui/design-tokens.md §5、docs/ui/settings.md */
export function ThemeProvider({ children }: { children: ReactNode }) {
  useI18n()
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference)
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme)
  const [motion, setMotionState] = useState<MotionPreference>(readMotion)
  const [paneFocusMotion, setPaneFocusMotionState] = useState<PaneFocusMotion>(readPaneFocusMotion)
  const [minimal, setMinimalState] = useState<MinimalMode>(readMinimalMode)
  const [systemReducedMotion, setSystemReducedMotion] = useState(() => window.matchMedia(REDUCED_MOTION).matches)

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION)
    const onChange = () => setSystemReducedMotion(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  // 其他窗口或设置云同步改了主题 / 动画（docs/ui/settings-sync.md）：重新读
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.storageArea !== localStorage) return
      if (e.key === STORAGE_KEY || e.key === null) setPreferenceState(readPreference())
      if (e.key === MOTION_KEY || e.key === null) setMotionState(readMotion())
      if (e.key === PANE_FOCUS_MOTION_KEY || e.key === null) setPaneFocusMotionState(readPaneFocusMotion())
      if (e.key === MINIMAL_MODE_KEY || e.key === null) setMinimalState(readMinimalMode())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // globals.css 按 data-motion 决定是否关闭动画
  useEffect(() => {
    document.documentElement.dataset.motion = motion
  }, [motion])
  useEffect(() => {
    document.documentElement.dataset.paneFocus = paneFocusMotion
  }, [paneFocusMotion])
  // styles/minimal.css 全部挂在 data-minimal='on' 下
  useEffect(() => {
    document.documentElement.dataset.minimal = minimal
  }, [minimal])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystem(media.matches ? 'dark' : 'light')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const resolved: ResolvedTheme = preference === 'system' ? system : preference
  const palette = usePalette()
  const custom = useCustomThemes()

  const activeBg = custom.themes.find(t => t.id === custom.activeId)?.[resolved]['bg-app']

  // 写 data-theme 会让每个终端重设样式、重算尺寸：只在模式、配色、选中的主题变时写，拖颜色时不写
  useEffect(() => {
    document.documentElement.dataset.theme = resolved
  }, [resolved, palette, custom.activeId])

  // 窗口底色按配色主题的实际底色（换配色也要重新同步）
  useEffect(() => {
    window.pixelsky?.setTheme(resolved, hasWallpaper(), windowBackground())
  }, [resolved, palette, custom.activeId, activeBg])

  // 截图模式（src/main/index.ts）通过这个钩子切换主题
  useEffect(() => {
    window.__pixelskySetTheme = theme => setPreferenceState(theme)
    return () => {
      delete window.__pixelskySetTheme
    }
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved,
      setPreference: next => {
        setPreferenceState(next)
        save(STORAGE_KEY, next)
      },
      motion,
      setMotion: next => {
        setMotionState(next)
        save(MOTION_KEY, next)
      },
      systemReducedMotion,
      paneFocusMotion,
      setPaneFocusMotion: next => {
        setPaneFocusMotionState(next)
        if (!isDemo) save(PANE_FOCUS_MOTION_KEY, next)
      },
      minimal,
      setMinimal: next => {
        setMinimalState(next)
        if (!isDemo) save(MINIMAL_MODE_KEY, next)
      },
    }),
    [preference, resolved, motion, systemReducedMotion, paneFocusMotion, minimal],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error(tr('theme.ThemeProvider.usethemeMustBeUsed'))
  return value
}

/** 动画关了（设置里关掉，或跟随系统且系统要求减少动态效果） */
export function useReducedMotion(): boolean {
  const { motion, systemReducedMotion } = useTheme()
  return motion === 'off' || (motion === 'system' && systemReducedMotion)
}

/** 极简模式开着（docs/ui/minimal-mode.md）：样式在 styles/minimal.css，结构上的差别用这个判断 */
export function useMinimal(): boolean {
  return useTheme().minimal === 'on'
}
