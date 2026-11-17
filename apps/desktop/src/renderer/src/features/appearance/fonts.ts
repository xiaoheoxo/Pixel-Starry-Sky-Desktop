// 自定义字体：界面字体、代码字体、字号（只缩放文字）、对话正文衬线体。规格见 docs/ui/settings.md §7。
// 设置写成 <html> 上的 CSS 变量和属性，改完立刻生效；保存在 localStorage。
import { useSyncExternalStore } from 'react'

export interface FontPrefs {
  /** 用户输入的界面字体（逗号分隔的回退链），空字符串表示系统默认 */
  sans: string
  /** 用户输入的代码字体，空字符串表示系统默认 */
  mono: string
  /** 文字缩放比例，只影响字号，不影响布局尺寸 */
  scale: number
  /** 助手回复正文用衬线体（代码仍是等宽） */
  serifProse: boolean
}

export const FONT_SCALES = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5] as const
export const DEFAULT_FONTS: FontPrefs = { sans: '', mono: '', scale: 1, serifProse: false }

const KEY = 'pixelsky.fonts'

function load(): FontPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<FontPrefs>
    return {
      sans: typeof saved.sans === 'string' ? saved.sans : '',
      mono: typeof saved.mono === 'string' ? saved.mono : '',
      scale: FONT_SCALES.includes(saved.scale as (typeof FONT_SCALES)[number]) ? (saved.scale as number) : 1,
      serifProse: saved.serifProse === true,
    }
  } catch {
    return { ...DEFAULT_FONTS }
  }
}

let prefs = load()
const listeners = new Set<() => void>()

/** 把用户输入整理成合法的 font-family 片段：逗号分隔，每个名字加引号（通用字体族名除外） */
export function normalizeFamily(input: string): string {
  const generic = new Set([
    'serif',
    'sans-serif',
    'monospace',
    'system-ui',
    'ui-monospace',
    'ui-sans-serif',
    'ui-serif',
    'cursive',
    'fantasy',
  ])
  return input
    .split(/[,，]/)
    .map(name =>
      name
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/["\\;{}]/g, ''),
    )
    .filter(Boolean)
    .map(name => (generic.has(name.toLowerCase()) ? name : `"${name}"`))
    .join(', ')
}

function apply(p: FontPrefs): void {
  const root = document.documentElement
  const sans = normalizeFamily(p.sans)
  const mono = normalizeFamily(p.mono)
  // 用户字体排在最前面，后面保留默认回退链兜底（中文、英文都有字形）
  if (sans) root.style.setProperty('--font-sans-user', `${sans}, `)
  else root.style.removeProperty('--font-sans-user')
  if (mono) root.style.setProperty('--font-mono-user', `${mono}, `)
  else root.style.removeProperty('--font-mono-user')
  root.style.setProperty('--font-scale', String(p.scale))
  if (p.serifProse) root.dataset.serifProse = ''
  else delete root.dataset.serifProse
}

apply(prefs)

export function getFontPrefs(): FontPrefs {
  return prefs
}

export function setFontPrefs(patch: Partial<FontPrefs>): void {
  prefs = { ...prefs, ...patch }
  apply(prefs)
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // 忽略
  }
  listeners.forEach(l => l())
}

export function resetFontPrefs(): void {
  setFontPrefs({ ...DEFAULT_FONTS })
}

// 其他窗口或设置云同步改了字体（docs/ui/settings-sync.md）：重新读、重新套上
if (typeof window !== 'undefined')
  window.addEventListener('storage', e => {
    if (e.storageArea !== localStorage || (e.key !== KEY && e.key !== null)) return
    prefs = load()
    apply(prefs)
    listeners.forEach(l => l())
  })

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useFontPrefs(): FontPrefs {
  return useSyncExternalStore(subscribe, getFontPrefs)
}

/* ---------- 本机字体列表 ---------- */

interface LocalFontData {
  family: string
}
declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>
  }
}

let fontListPromise: Promise<string[]> | null = null

/** 本机已安装字体的字体族名（去重、排序）。需要在用户点击后调用；拿不到时返回空数组 */
export function listLocalFonts(): Promise<string[]> {
  if (!fontListPromise) {
    fontListPromise = (async () => {
      if (typeof window.queryLocalFonts !== 'function') return []
      const fonts = await window.queryLocalFonts()
      return [...new Set(fonts.map(f => f.family).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    })().catch(() => {
      fontListPromise = null
      return []
    })
  }
  return fontListPromise
}
