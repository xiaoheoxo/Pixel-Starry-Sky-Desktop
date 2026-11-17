// 设备尺寸、网页主题的菜单项（docs/ui/browser-v2.md §3.3）：工具栏设备按钮、⋯ 菜单、设备条共用
import { Laptop, Monitor, Moon, RotateCcw, Ruler, Smartphone, Sun, SunMoon, Tablet } from 'lucide-react'
import type { MenuAction } from '@/ui/ActionMenu'
import { tr } from '@/i18n/core'
import {
  BROWSER_DEVICES,
  BROWSER_DEVICE_IDS,
  deviceSize,
  type BrowserDeviceId,
  type BrowserPageTheme,
  type BrowserPreview,
} from '../../../../shared/types/project-browser'

export const DEVICE_ICON = {
  responsive: Monitor,
  phone: Smartphone,
  phoneLarge: Smartphone,
  tablet: Tablet,
  laptop: Laptop,
  custom: Ruler,
} as const

export const THEME_ICON = { system: SunMoon, light: Sun, dark: Moon } as const

export const currentPreview = (p: BrowserPreview | undefined): BrowserPreview => p ?? { device: 'responsive' }

/** 设备名：手机、平板…… */
export const deviceName = (id: BrowserDeviceId): string => tr(`projectTools.device.${id}`)

/** 「390×844」；自适应时空 */
export function sizeText(preview: BrowserPreview | undefined): string {
  const size = deviceSize(preview)
  return size ? `${size.width}×${size.height}` : ''
}

/** 换设备、横竖（改了就整份交给主进程，主进程再校验） */
export function deviceActions(
  preview: BrowserPreview | undefined,
  onChange: (next: BrowserPreview) => void,
  disabled = false,
): MenuAction[] {
  const now = currentPreview(preview)
  const items: MenuAction[] = BROWSER_DEVICE_IDS.map(id => ({
    label: deviceName(id),
    icon: DEVICE_ICON[id],
    checked: now.device === id,
    disabled,
    hint:
      id === 'custom'
        ? now.device === 'custom'
          ? sizeText(now)
          : undefined
        : id === 'responsive'
          ? undefined
          : `${BROWSER_DEVICES[id].width}×${BROWSER_DEVICES[id].height}`,
    run: () => onChange({ ...now, device: id }),
  }))
  items.push({
    label: tr('projectTools.deviceRotate'),
    icon: RotateCcw,
    separator: true,
    disabled: disabled || now.device === 'responsive',
    run: () => onChange({ ...now, landscape: !now.landscape }),
  })
  return items
}

export function themeActions(
  preview: BrowserPreview | undefined,
  onChange: (next: BrowserPreview) => void,
  disabled = false,
): MenuAction[] {
  const now = currentPreview(preview)
  return (['system', 'light', 'dark'] as BrowserPageTheme[]).map(theme => ({
    label: tr(`projectTools.pageTheme.${theme}`),
    icon: THEME_ICON[theme],
    checked: (now.theme ?? 'system') === theme,
    disabled,
    run: () => onChange({ ...now, theme }),
  }))
}
