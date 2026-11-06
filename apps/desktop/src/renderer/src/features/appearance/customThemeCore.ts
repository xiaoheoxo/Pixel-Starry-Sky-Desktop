// 自定义主题（docs/ui/custom-theme.md）的纯逻辑：校验、算派生变量、拼 CSS、导入导出。存取在 customTheme.ts
import { BASE_COLORS, THEME_COLOR_KEYS, type ThemeColorKey, type ThemeColors } from './customThemeBase'
import { DEFAULT_PALETTE, PALETTES, type Palette } from './palettes'

export type ThemeMode = 'light' | 'dark'

export interface ThemeArt {
  on: boolean
  /** 选这张图的时间：换图后别的窗口靠它重读。图片本身在 IndexedDB，只在这台电脑 */
  stamp: number
  mask: Record<ThemeMode, number>
}

export interface CustomTheme {
  id: string
  name: string
  base: Palette
  light: ThemeColors
  dark: ThemeColors
  art?: ThemeArt
}

export const MAX_THEMES = 20
export const THEME_NAME_MAX = 24
export const DEFAULT_ART_MASK: Record<ThemeMode, number> = { light: 75, dark: 50 }
const MASK_MAX = 90

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const parseBase = (v: unknown): Palette => (PALETTES.includes(v as Palette) ? (v as Palette) : DEFAULT_PALETTE)
const clampMask = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(MASK_MAX, Math.max(0, v)) : fallback

/** 没写的、不合法的颜色取基础配色 */
function parseColors(raw: unknown, base: ThemeColors): ThemeColors {
  const source = isRecord(raw) ? raw : {}
  const out = { ...base }
  for (const key of THEME_COLOR_KEYS) if (isHex(source[key])) out[key] = (source[key] as string).toLowerCase()
  return out
}

function parseArt(raw: unknown): ThemeArt | undefined {
  if (!isRecord(raw) || typeof raw.stamp !== 'number') return undefined
  const mask = isRecord(raw.mask) ? raw.mask : {}
  return {
    on: raw.on === true,
    stamp: raw.stamp,
    mask: {
      light: clampMask(mask.light, DEFAULT_ART_MASK.light),
      dark: clampMask(mask.dark, DEFAULT_ART_MASK.dark),
    },
  }
}

/** 存着的主题列表（可能来自同步、旧版本）：坏的条目丢掉，重复 id 只留第一个，超过上限的不要 */
export function parseThemes(raw: string | null): CustomTheme[] {
  let list: unknown
  try {
    list = JSON.parse(raw ?? '[]')
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: CustomTheme[] = []
  for (const item of list) {
    if (out.length >= MAX_THEMES) break
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue
    if (typeof item.name !== 'string' || !item.name.trim()) continue
    seen.add(item.id)
    const base = parseBase(item.base)
    const art = parseArt(item.art)
    out.push({
      id: item.id,
      name: item.name.trim().slice(0, THEME_NAME_MAX),
      base,
      light: parseColors(item.light, BASE_COLORS[base].light),
      dark: parseColors(item.dark, BASE_COLORS[base].dark),
      ...(art ? { art } : {}),
    })
  }
  return out
}

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}

/** a 占 weight（0–1），其余是 b；结果还是 #RRGGBB（窗口底色要读 --wall-tint，不能是 color-mix） */
export function mix(a: string, b: string, weight: number): string {
  const x = channels(a),
    y = channels(b)
  const out = x.map((v, i) => Math.round(v * weight + y[i] * (1 - weight)))
  return `#${out.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 对比度 */
export function contrast(a: string, b: string): number {
  const x = luminance(a),
    y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** 文字色在这个底上不够清楚时，一点点往正文色靠；本来够清楚就不动 */
function readableText(color: string, bg: string, text: string): string {
  let out = color
  for (let weight = 0.9; weight > 0 && contrast(out, bg) < 4.5; weight -= 0.1) out = mix(color, text, weight)
  return out
}

const looksLight = (bg: string): boolean => contrast(bg, '#000000') > contrast(bg, '#ffffff')

/** 底色和所在模式相反：代码高亮、Logo 这些跟模式走的颜色可能看不清 */
export const modeMismatch = (c: ThemeColors, mode: ThemeMode): boolean =>
  looksLight(c['bg-workbench']) !== (mode === 'light')

const readableOn = (bg: string): string => (contrast(bg, '#ffffff') >= contrast(bg, '#000000') ? '#ffffff' : '#000000')

/** 13 个颜色 → 界面用的全部变量，名字和 tokens.css 的配色块一一对应 */
export function deriveVars(c: ThemeColors, mode: ThemeMode): Record<string, string> {
  const strong = mix(c.border, c.text, 0.75)
  const primaryText = readableOn(c['btn-primary-bg'])
  const accentSoft = mix(c['theme-accent'], c['bg-app'], 0.14)
  return {
    '--ink': c.text,
    '--bg-rail': mix(c['bg-sidebar'], '#000000', 0.92),
    '--bg-sidebar': c['bg-sidebar'],
    '--bg-app': c['bg-app'],
    '--bg-panel': c['bg-app'],
    '--bg-surface': c['bg-surface'],
    // 弹出菜单：浅色和卡片一样；深色亮一级，压得住下面的卡片（和 tokens.css 一致）
    '--bg-popover': mode === 'dark' ? mix(c['bg-surface'], c.text, 0.94) : c['bg-surface'],
    '--bg-workbench': c['bg-workbench'],
    '--wall-tint': c['bg-app'],
    '--wall-surface': c['bg-surface'],
    '--wall-sidebar': c['bg-sidebar'],
    '--border': c.border,
    '--border-subtle': mix(c.border, c['bg-app'], 0.7),
    '--border-strong': strong,
    '--text': c.text,
    '--text-body': c.text,
    '--text-secondary': c['text-secondary'],
    '--text-muted': c['text-muted'],
    '--text-faint': mix(c['text-muted'], c['bg-app'], 0.65),
    '--theme-accent': c['theme-accent'],
    '--theme-accent-on': readableOn(c['theme-accent']),
    '--theme-accent-soft': accentSoft,
    '--theme-accent-text': readableText(c['theme-accent'], accentSoft, c.text),
    '--theme-accent-border': mix(c['theme-accent'], c['bg-app'], 0.6),
    '--btn-primary-bg': c['btn-primary-bg'],
    '--btn-primary-text': primaryText,
    '--btn-disabled-bg': strong,
    '--btn-disabled-text': c['bg-app'],
    '--engine-chip-bg': c['btn-primary-bg'],
    '--engine-chip-text': primaryText,
    '--success': c.success,
    '--warn': c.warn,
    '--warn-text': readableText(c.warn, c['bg-surface'], c.text),
    '--danger': c.danger,
  }
}

/** 有壁纸时这些底色由 tokens.css 的壁纸规则变透明，自建主题不能盖掉 */
const WALLPAPER_OWNED = new Set([
  '--bg-app',
  '--bg-panel',
  '--bg-rail',
  '--bg-sidebar',
  '--bg-surface',
  '--bg-workbench',
])

function modeCss(theme: CustomTheme, mode: ThemeMode): string {
  const vars = Object.entries(deriveVars(theme[mode], mode))
  const body = (list: typeof vars): string => list.map(([k, v]) => `${k}:${v};`).join('')
  // 重复属性抬高优先级：要压过内置配色块（同是 :root + 两个属性），不依赖样式表先后
  const root = `:root[data-theme='${mode}'][data-custom-theme][data-custom-theme]`
  return (
    `${root}{color-scheme:${looksLight(theme[mode]['bg-workbench']) ? 'light' : 'dark'};${body(vars.filter(([k]) => !WALLPAPER_OWNED.has(k)))}}` +
    `${root}:not([data-wallpaper]){${body(vars.filter(([k]) => WALLPAPER_OWNED.has(k)))}}`
  )
}

export const themeCss = (theme: CustomTheme): string => modeCss(theme, 'light') + modeCss(theme, 'dark')

/**
 * 同步时两台电脑都改了主题列表：按 id 合并，同一个主题以本机为准。
 * 整份覆盖会把另一台新建的主题永久丢掉；代价是冲突期间删掉的主题可能回来，这种失败更安全
 */
export function mergeThemeLists(mine: unknown, theirs: unknown): unknown {
  if (typeof theirs !== 'string') return mine
  if (typeof mine !== 'string') return theirs
  const local = parseThemes(mine)
  const ids = new Set(local.map(t => t.id))
  return JSON.stringify([...local, ...parseThemes(theirs).filter(t => !ids.has(t.id))].slice(0, MAX_THEMES))
}

/** 导出：只有颜色，贴图是本机文件不带 */
export function exportTheme(theme: CustomTheme): string {
  return JSON.stringify(
    { pixelskyTheme: 1, name: theme.name, base: theme.base, light: theme.light, dark: theme.dark },
    null,
    2,
  )
}

export type ImportError = 'json' | 'format' | 'name' | 'color'

/** 导入：和同步来的不同，这是用户手里的文件，颜色写错了要告诉他，不悄悄换掉 */
export function parseImport(
  text: string,
): { theme: Omit<CustomTheme, 'id'> } | { error: ImportError; detail?: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: 'json' }
  }
  if (!isRecord(raw) || raw.pixelskyTheme !== 1) return { error: 'format' }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) return { error: 'name' }
  for (const mode of ['light', 'dark'] as const) {
    const colors = raw[mode]
    if (colors === undefined) continue
    if (!isRecord(colors)) return { error: 'format' }
    for (const key of THEME_COLOR_KEYS)
      if (colors[key] !== undefined && !isHex(colors[key])) return { error: 'color', detail: `${mode}.${key}` }
  }
  const base = parseBase(raw.base)
  return {
    theme: {
      name: name.slice(0, THEME_NAME_MAX),
      base,
      light: parseColors(raw.light, BASE_COLORS[base].light),
      dark: parseColors(raw.dark, BASE_COLORS[base].dark),
    },
  }
}

export type { ThemeColorKey, ThemeColors }
