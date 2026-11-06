import { UI_THEME_GLASS_RANGES, type UiThemeGlass } from '@pixelsky/protocol'

// 毛玻璃的纯逻辑（docs/ui/glass-effect.md）：读设置、什么时候变回实色、实际透出多少。不碰 window / document。

export type GlassSource = 'wall' | 'desk'
export type GlassReadable = 'off' | '3' | '4.5'
export type ThemeMode = 'dark' | 'light'

export interface GlassPrefs {
  /** 透应用壁纸（CSS，都能调）还是透桌面（系统材质） */
  source: GlassSource
  material: string
  /** 当前预设 id；theme 是主题自己写的数值，改过数值后是 custom */
  preset: string
  transparency: Record<ThemeMode, number>
  blur: number
  saturate: number
  brightness: Record<ThemeMode, number>
  grain: number
  rim: number
  /** 空字符串是跟随主题 */
  tint: string
  /** 分区透出：在整体上加减 */
  zones: { side: number; main: number; right: number; card: number }
  codeTransparency: number
  menuOpacity: number
  radius: number
  readable: GlassReadable
  boostMuted: boolean
  textShadow: boolean
  solidOnBlur: boolean
  solidOnBattery: boolean
  followReduced: boolean
}

/** 调整项里的预设。官方毛玻璃主题 themes/glass.json 的数值就是「通透」（glassCore.test.ts 比对） */
export const GLASS_PRESETS = {
  clear: {
    transparency: { dark: 65, light: 50 },
    blur: 14,
    saturate: 170,
    brightness: { dark: 62, light: 120 },
    grain: 0,
    rim: 45,
  },
  balanced: {
    transparency: { dark: 45, light: 35 },
    blur: 24,
    saturate: 160,
    brightness: { dark: 75, light: 110 },
    grain: 2,
    rim: 30,
  },
  frost: {
    transparency: { dark: 28, light: 22 },
    blur: 40,
    saturate: 140,
    brightness: { dark: 90, light: 105 },
    grain: 5,
    rim: 20,
  },
} as const satisfies Record<string, UiThemeGlass>
export type GlassPresetId = keyof typeof GLASS_PRESETS
export const GLASS_PRESET_IDS = Object.keys(GLASS_PRESETS) as GlassPresetId[]

export const DEFAULT_GLASS: GlassPrefs = {
  source: 'desk',
  material: '',
  preset: 'clear',
  ...GLASS_PRESETS.clear,
  tint: '',
  zones: { side: 0, main: -15, right: -5, card: -25 },
  codeTransparency: 0,
  menuOpacity: 92,
  radius: 12,
  readable: '4.5',
  boostMuted: true,
  textShadow: true,
  solidOnBlur: false,
  solidOnBattery: true,
  followReduced: true,
}

export const GLASS_ZONE_RANGE = [-50, 30] as const
export const GLASS_CODE_RANGE = [0, 60] as const
export const GLASS_MENU_RANGE = [60, 100] as const
export const GLASS_RADIUS_RANGE = [4, 24] as const

type Range = readonly [number, number]
const num = (v: unknown, [min, max]: Range, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

/** localStorage 里的值不可信（手改、旧版本）：每个字段单独校验，坏了只退回那一项的默认值 */
export function parseGlassPrefs(raw: unknown, d: GlassPrefs = DEFAULT_GLASS): GlassPrefs {
  const r = rec(raw),
    R = UI_THEME_GLASS_RANGES
  const t = rec(r.transparency),
    b = rec(r.brightness),
    z = rec(r.zones)
  return {
    source: r.source === 'wall' || r.source === 'desk' ? r.source : d.source,
    material: typeof r.material === 'string' ? r.material : d.material,
    preset: typeof r.preset === 'string' ? r.preset : d.preset,
    transparency: {
      dark: num(t.dark, R.transparency, d.transparency.dark),
      light: num(t.light, R.transparency, d.transparency.light),
    },
    blur: num(r.blur, R.blur, d.blur),
    saturate: num(r.saturate, R.saturate, d.saturate),
    brightness: {
      dark: num(b.dark, R.brightness, d.brightness.dark),
      light: num(b.light, R.brightness, d.brightness.light),
    },
    grain: num(r.grain, R.grain, d.grain),
    rim: num(r.rim, R.rim, d.rim),
    tint: isHex(r.tint) ? r.tint : d.tint,
    zones: {
      side: num(z.side, GLASS_ZONE_RANGE, d.zones.side),
      main: num(z.main, GLASS_ZONE_RANGE, d.zones.main),
      right: num(z.right, GLASS_ZONE_RANGE, d.zones.right),
      card: num(z.card, GLASS_ZONE_RANGE, d.zones.card),
    },
    codeTransparency: num(r.codeTransparency, GLASS_CODE_RANGE, d.codeTransparency),
    menuOpacity: num(r.menuOpacity, GLASS_MENU_RANGE, d.menuOpacity),
    radius: num(r.radius, GLASS_RADIUS_RANGE, d.radius),
    readable: r.readable === 'off' || r.readable === '3' || r.readable === '4.5' ? r.readable : d.readable,
    boostMuted: bool(r.boostMuted, d.boostMuted),
    textShadow: bool(r.textShadow, d.textShadow),
    solidOnBlur: bool(r.solidOnBlur, d.solidOnBlur),
    solidOnBattery: bool(r.solidOnBattery, d.solidOnBattery),
    followReduced: bool(r.followReduced, d.followReduced),
  }
}

export function applyGlassPreset(prefs: GlassPrefs, id: string, values: UiThemeGlass): GlassPrefs {
  const { transparency, blur, saturate, brightness, grain, rim } = values
  return { ...prefs, preset: id, transparency, blur, saturate, brightness, grain, rim }
}

/** 主题的数值和哪个预设一样；都不一样就是主题自己的（设置页多一个「主题默认」） */
export function presetOfTheme(glass: UiThemeGlass): string {
  const same = (a: UiThemeGlass, b: UiThemeGlass): boolean =>
    a.blur === b.blur &&
    a.saturate === b.saturate &&
    a.grain === b.grain &&
    a.rim === b.rim &&
    a.transparency.dark === b.transparency.dark &&
    a.transparency.light === b.transparency.light &&
    a.brightness.dark === b.brightness.dark &&
    a.brightness.light === b.brightness.light
  return GLASS_PRESET_IDS.find(id => same(GLASS_PRESETS[id], glass)) ?? 'theme'
}

/** 这个主题还没调过时的设置 */
export const glassDefaultsOf = (glass: UiThemeGlass): GlassPrefs =>
  applyGlassPreset(DEFAULT_GLASS, presetOfTheme(glass), glass)

/** 算出当前该用的来源：透桌面要系统支持，不支持就退回透壁纸 */
export function effectiveSource(prefs: GlassPrefs, materials: readonly string[]): GlassSource {
  return prefs.source === 'desk' && materials.length > 0 ? 'desk' : 'wall'
}

export function effectiveMaterial(prefs: GlassPrefs, materials: readonly string[]): string | null {
  if (materials.length === 0) return null
  return materials.includes(prefs.material) ? prefs.material : materials[0]!
}

export interface GlassEnv {
  theme: ThemeMode
  materials: readonly string[]
  focused: boolean
  onBattery: boolean
  reducedTransparency: boolean
  hasWallpaper: boolean
  /** 壁纸暗部、亮部的颜色；读不到（视频、还没读完）是 null */
  backdrop: readonly [string, string] | null
  /** 算对比度用的颜色：主题变量的实际值，不是 #RRGGBB 就不算 */
  colors: { side: string; main: string; muted: string; secondary: string; body: string }
}

export type GlassSolidReason = 'reduced' | 'battery' | 'unfocused' | 'noWallpaper'

export interface GlassResolved {
  /** 为什么变回实色；null 就是玻璃开着 */
  solid: GlassSolidReason | null
  source: GlassSource
  /** 要打开的系统材质；不透桌面或变回实色时是 null */
  material: string | null
  /** 各区域底色的不透明度（%） */
  alpha: { side: number; main: number; right: number; card: number; code: number; menu: number }
  /** 被「自动保证可读」加厚了底色的区域 */
  raised: Array<'side' | 'main' | 'right'>
  blur: number
  saturate: number
  brightness: number
  /** 最坏情况的对比度；读不到背景时是 null */
  contrast: { weak: number; body: number } | null
}

const hex = (h: string): [number, number, number] | null => {
  if (!isHex(h)) return null
  return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}
const luminance = (c: readonly number[]): number => {
  const [r, g, b] = c.map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

/** 缩小后的壁纸像素（RGBA）：按亮度排序取 10%、90% 处的颜色当暗部、亮部。缩小本身就近似模糊 */
export function backdropExtremes(rgba: ArrayLike<number>): [string, string] | null {
  const px: Array<[number, number, number]> = []
  for (let i = 0; i + 3 < rgba.length; i += 4) px.push([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!])
  if (px.length === 0) return null
  px.sort((a, b) => luminance(a) - luminance(b))
  const toHex = (c: readonly number[]): string => `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`
  return [toHex(px[Math.floor(px.length * 0.1)]!), toHex(px[Math.floor(px.length * 0.9)]!)]
}

const clampPct = (v: number): number => Math.max(0, Math.min(100, v))

export function resolveGlass(prefs: GlassPrefs, env: GlassEnv): GlassResolved {
  const source = effectiveSource(prefs, env.materials)
  const desk = source === 'desk'
  const solid: GlassSolidReason | null =
    prefs.followReduced && env.reducedTransparency
      ? 'reduced'
      : prefs.solidOnBattery && env.onBattery
        ? 'battery'
        : prefs.solidOnBlur && !env.focused
          ? 'unfocused'
          : !desk && !env.hasWallpaper
            ? 'noWallpaper'
            : null
  const off = solid !== null
  const t = prefs.transparency[env.theme]
  const zone = (offset: number): number => (off ? 100 : clampPct(100 - (t + offset)))
  // 系统材质调不了模糊、饱和度、亮度，这里不再加一层
  const brightness = desk ? 100 : prefs.brightness[env.theme]
  const tintSide = hex(prefs.tint) ?? hex(env.colors.side)
  const tintMain = hex(prefs.tint) ?? hex(env.colors.main)
  const weak = hex(prefs.boostMuted ? env.colors.secondary : env.colors.muted)
  const body = hex(env.colors.body)
  const backdrop = !off && !desk && env.backdrop ? env.backdrop.map(hex) : null
  const canMeasure = !!backdrop && backdrop.every(Boolean) && !!tintSide && !!tintMain && !!weak && !!body

  const worst = (fg: readonly number[], tint: readonly number[], alpha: number): number =>
    Math.min(
      ...backdrop!.map(d => {
        const lit = d!.map(v => Math.min(255, (v * brightness) / 100))
        return contrastRatio(
          fg,
          tint.map((v, i) => (v * alpha) / 100 + (lit[i]! * (100 - alpha)) / 100),
        )
      }),
    )
  // 自动保证可读：底色一点点加厚，直到最坏情况也达标
  const lift = (fg: readonly number[] | null, tint: readonly number[] | null, alpha: number): number => {
    if (!canMeasure || prefs.readable === 'off') return alpha
    let a = alpha
    while (a < 100 && worst(fg!, tint!, a) < Number(prefs.readable)) a++
    return a
  }

  const base = { side: zone(prefs.zones.side), main: zone(prefs.zones.main), right: zone(prefs.zones.right) }
  const side = lift(weak, tintSide, base.side)
  const main = lift(body, tintMain, base.main)
  const right = lift(weak, tintMain, base.right)
  return {
    solid,
    source,
    material: !off && desk ? effectiveMaterial(prefs, env.materials) : null,
    alpha: {
      side,
      main,
      right,
      card: zone(prefs.zones.card),
      code: off ? 100 : 100 - prefs.codeTransparency,
      menu: off ? 100 : prefs.menuOpacity,
    },
    raised: (['side', 'main', 'right'] as const).filter(k => ({ side, main, right })[k] > base[k]),
    blur: off || desk ? 0 : prefs.blur,
    saturate: off || desk ? 100 : prefs.saturate,
    brightness: off ? 100 : brightness,
    contrast: canMeasure ? { weak: worst(weak!, tintSide!, side), body: worst(body!, tintMain!, main) } : null,
  }
}
