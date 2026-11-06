// 界面主题贡献的主题文件（docs/ui/ui-themes-extension.md §2）：扩展只带数据，生效的代码在软件里。
// 校验器和界面读文件时共用这一份规则。纯 TS，不抛异常。

/** 软件自带的配色只有暖灰（default），其余都是预装扩展 */
export const UI_THEME_BASES = ['default'] as const

/** 主题能改的 13 个颜色，「我的主题」也用它 */
export const UI_THEME_COLOR_KEYS = [
  'bg-sidebar',
  'bg-app',
  'bg-workbench',
  'bg-surface',
  'border',
  'text',
  'text-secondary',
  'text-muted',
  'theme-accent',
  'btn-primary-bg',
  'success',
  'warn',
  'danger',
] as const

/** 还能单独写的变量：不写就由上面 13 个颜色算出来。值可以是 #RRGGBB 或 rgba() */
export const UI_THEME_EXTRA_KEYS = [
  'ink',
  'bg-rail',
  'bg-panel',
  'bg-popover',
  'wall-tint',
  'wall-surface',
  'wall-sidebar',
  'border-subtle',
  'border-strong',
  'text-faint',
  'text-body',
  'theme-accent-on',
  'theme-accent-soft',
  'theme-accent-text',
  'theme-accent-border',
  'btn-primary-text',
  'btn-disabled-bg',
  'btn-disabled-text',
  'engine-chip-bg',
  'engine-chip-text',
  'warn-text',
  'terminal-bg',
  'terminal-fg',
  'terminal-cursor',
  'terminal-selection',
  'chart-input',
  'chart-cache',
  'chart-output',
] as const

/** 玻璃每个数值的范围；设置页的滑块也用它 */
export const UI_THEME_GLASS_RANGES = {
  transparency: [0, 90],
  blur: [0, 60],
  saturate: [50, 220],
  brightness: [30, 150],
  grain: [0, 15],
  rim: [0, 100],
} as const

export interface UiThemeGlass {
  /** 透出多少，深浅色分别给（%） */
  transparency: { dark: number; light: number }
  /** 模糊（px）：系统材质调不了，只对透壁纸生效 */
  blur: number
  /** 背景饱和度（%） */
  saturate: number
  /** 背景亮度（%），深浅色分别给 */
  brightness: { dark: number; light: number }
  /** 噪点（%） */
  grain: number
  /** 亮边（%） */
  rim: number
}

export type UiThemeVarKey = (typeof UI_THEME_COLOR_KEYS)[number] | (typeof UI_THEME_EXTRA_KEYS)[number]

export interface UiThemeFile {
  pixelskyTheme: 1
  base?: (typeof UI_THEME_BASES)[number]
  light?: Partial<Record<UiThemeVarKey, string>>
  dark?: Partial<Record<UiThemeVarKey, string>>
  glass?: UiThemeGlass
}

export interface UiThemeProblem {
  zh: string
  en: string
  /** 文件内的位置，如 glass.blur */
  path?: string
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const inRange = (v: unknown, [min, max]: readonly [number, number]): boolean =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

const FILE_KEYS = ['pixelskyTheme', 'base', 'light', 'dark', 'glass']
const GLASS_KEYS = ['transparency', 'blur', 'saturate', 'brightness', 'grain', 'rim']
const SINGLE = ['blur', 'saturate', 'grain', 'rim'] as const
const PER_MODE = ['transparency', 'brightness'] as const
const HEX_RE = /^#[0-9a-f]{6}$/i
const RGBA_RE = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)$/i

/** 额外变量的值：写进样式表前的唯一关口，只放行这两种写法 */
export const isUiThemeExtraValue = (v: unknown): v is string =>
  typeof v === 'string' && (HEX_RE.test(v) || RGBA_RE.test(v))

function unknownKeys(raw: Rec, known: readonly string[], path?: string): UiThemeProblem[] {
  const unknown = Object.keys(raw).filter(k => !known.includes(k))
  return unknown.length
    ? [{ zh: `不认识的字段：${unknown.join('、')}`, en: `Unknown fields: ${unknown.join(', ')}`, path }]
    : []
}

function colorProblems(raw: unknown, mode: 'light' | 'dark'): UiThemeProblem[] {
  if (!isRec(raw)) return [{ zh: `${mode} 必须是对象`, en: `${mode} must be an object`, path: mode }]
  const out = unknownKeys(raw, [...UI_THEME_COLOR_KEYS, ...UI_THEME_EXTRA_KEYS], mode)
  for (const key of UI_THEME_EXTRA_KEYS) {
    if (raw[key] !== undefined && !isUiThemeExtraValue(raw[key]))
      out.push({
        zh: `${key} 必须是 #RRGGBB 或 rgba()`,
        en: `${key} must be #RRGGBB or rgba()`,
        path: `${mode}.${key}`,
      })
  }
  for (const key of UI_THEME_COLOR_KEYS) {
    const v = raw[key]
    if (v !== undefined && !(typeof v === 'string' && HEX_RE.test(v)))
      out.push({ zh: `${key} 必须是 #RRGGBB`, en: `${key} must be #RRGGBB`, path: `${mode}.${key}` })
  }
  return out
}

function glassProblems(raw: unknown): UiThemeProblem[] {
  if (!isRec(raw)) return [{ zh: 'glass 必须是对象', en: 'glass must be an object', path: 'glass' }]
  const out = unknownKeys(raw, GLASS_KEYS, 'glass')
  for (const key of SINGLE) {
    const range = UI_THEME_GLASS_RANGES[key]
    if (!inRange(raw[key], range))
      out.push({
        zh: `${key} 必须是 ${range[0]}–${range[1]} 的数字`,
        en: `${key} must be a number from ${range[0]} to ${range[1]}`,
        path: `glass.${key}`,
      })
  }
  for (const key of PER_MODE) {
    const range = UI_THEME_GLASS_RANGES[key]
    const v = raw[key]
    if (!isRec(v) || !inRange(v.dark, range) || !inRange(v.light, range))
      out.push({
        zh: `${key} 要写 dark 和 light，都是 ${range[0]}–${range[1]} 的数字`,
        en: `${key} needs dark and light, each a number from ${range[0]} to ${range[1]}`,
        path: `glass.${key}`,
      })
  }
  return out
}

/** 主题文件的问题；空数组就是合格。写错一项整条贡献不生效，免得作者以为改了却悄悄没用 */
export function uiThemeProblems(raw: unknown): UiThemeProblem[] {
  if (!isRec(raw) || raw.pixelskyTheme !== 1)
    return [{ zh: '文件里要写 "pixelskyTheme": 1', en: 'The file must contain "pixelskyTheme": 1' }]
  const out = unknownKeys(raw, FILE_KEYS)
  if (raw.base !== undefined && !(UI_THEME_BASES as readonly unknown[]).includes(raw.base))
    out.push({
      zh: `base 只能是：${UI_THEME_BASES.join('、')}`,
      en: `base must be one of: ${UI_THEME_BASES.join(', ')}`,
      path: 'base',
    })
  if (raw.light === undefined && raw.dark === undefined && raw.glass === undefined)
    out.push({ zh: 'light、dark、glass 至少写一个', en: 'At least one of light, dark or glass is required' })
  if (raw.light !== undefined) out.push(...colorProblems(raw.light, 'light'))
  if (raw.dark !== undefined) out.push(...colorProblems(raw.dark, 'dark'))
  if (raw.glass !== undefined) out.push(...glassProblems(raw.glass))
  return out
}
