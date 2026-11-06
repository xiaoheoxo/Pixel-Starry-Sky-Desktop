import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { uiThemeProblems, type UiThemeFile, type UiThemeGlass } from '@pixelsky/protocol'
import {
  applyGlassPreset,
  backdropExtremes,
  contrastRatio,
  DEFAULT_GLASS,
  effectiveSource,
  GLASS_PRESETS,
  glassDefaultsOf,
  parseGlassPrefs,
  presetOfTheme,
  resolveGlass,
  type GlassEnv,
  type GlassPrefs,
} from './glassCore'

const env = (over: Partial<GlassEnv> = {}): GlassEnv => ({
  theme: 'dark',
  materials: ['acrylic'],
  focused: true,
  onBattery: false,
  reducedTransparency: false,
  hasWallpaper: true,
  backdrop: null,
  colors: { side: '#1a1a19', main: '#1f1f1e', muted: '#9c9a92', secondary: '#c2c0b6', body: '#dcdad3' },
  ...over,
})
const prefs = (over: Partial<GlassPrefs> = {}): GlassPrefs => ({ ...DEFAULT_GLASS, ...over })

describe('parseGlassPrefs', () => {
  it('坏值退回默认，超范围夹回范围里', () => {
    const p = parseGlassPrefs({
      source: 'moon',
      blur: 999,
      transparency: { dark: -5, light: 'x' },
      tint: 'red',
      readable: 7,
      zones: { main: -100 },
    })
    expect(p.source).toBe('desk')
    expect(p.blur).toBe(60)
    expect(p.transparency).toEqual({ dark: 0, light: DEFAULT_GLASS.transparency.light })
    expect(p.tint).toBe('')
    expect(p.readable).toBe('4.5')
    expect(p.zones.main).toBe(-50)
    expect(p.zones.side).toBe(DEFAULT_GLASS.zones.side)
  })

  it('不是对象也不抛', () => {
    for (const raw of [null, 1, 'x', []]) expect(parseGlassPrefs(raw)).toEqual(DEFAULT_GLASS)
  })
})

describe('resolveGlass：什么时候变回实色', () => {
  it.each([
    ['系统减少透明度', prefs(), env({ reducedTransparency: true }), 'reduced'],
    ['用电池', prefs(), env({ onBattery: true }), 'battery'],
    ['失去焦点且选了变实色', prefs({ solidOnBlur: true }), env({ focused: false }), 'unfocused'],
    ['透壁纸但没有壁纸', prefs({ source: 'wall' }), env({ hasWallpaper: false }), 'noWallpaper'],
  ] as const)('%s', (_n, p, e, why) => {
    const r = resolveGlass(p, e)
    expect(r.solid).toBe(why)
    expect(r.material).toBeNull()
    expect(r.alpha).toMatchObject({ side: 100, main: 100, right: 100, card: 100, code: 100, menu: 100 })
    expect(r.blur).toBe(0)
  })

  it('这几项关掉就不变实色', () => {
    const p = prefs({ followReduced: false, solidOnBattery: false })
    expect(resolveGlass(p, env({ reducedTransparency: true, onBattery: true, focused: false })).solid).toBeNull()
  })

  it('不支持系统材质时透桌面退回透壁纸', () => {
    expect(effectiveSource(prefs(), [])).toBe('wall')
    const r = resolveGlass(prefs(), env({ materials: [], hasWallpaper: false }))
    expect(r.source).toBe('wall')
    expect(r.solid).toBe('noWallpaper')
  })
})

describe('resolveGlass：透桌面和透壁纸', () => {
  it('透桌面用系统材质，模糊、亮度不再叠一层；存的材质不支持就用第一个', () => {
    const r = resolveGlass(prefs({ material: 'nope' }), env())
    expect(r.material).toBe('acrylic')
    expect(r).toMatchObject({ blur: 0, saturate: 100, brightness: 100, contrast: null })
  })

  it('透壁纸按设置算，分区在整体上加减', () => {
    const r = resolveGlass(prefs({ source: 'wall', readable: 'off' }), env())
    expect(r.material).toBeNull()
    expect(r.blur).toBe(14)
    expect(r.brightness).toBe(62)
    expect(r.alpha).toMatchObject({ side: 35, main: 50, right: 40, card: 60 })
    expect(r.raised).toEqual([])
  })

  it('深浅色的透出、亮度分开', () => {
    const r = resolveGlass(prefs({ source: 'wall', readable: 'off' }), env({ theme: 'light' }))
    expect(r.alpha.side).toBe(50)
    expect(r.brightness).toBe(120)
  })

  it('透出加分区超过 100% 时夹住', () => {
    const r = resolveGlass(
      prefs({ source: 'wall', readable: 'off', zones: { side: 30, main: -50, right: 0, card: 0 } }),
      env({ theme: 'dark' }),
    )
    expect(r.alpha.side).toBe(5)
    expect(r.alpha.main).toBe(85)
    const clear = resolveGlass(
      prefs({
        source: 'wall',
        readable: 'off',
        transparency: { dark: 90, light: 90 },
        zones: { side: 30, main: 0, right: 0, card: 0 },
      }),
      env(),
    )
    expect(clear.alpha.side).toBe(0)
  })
})

describe('resolveGlass：自动保证可读', () => {
  const white = ['#ffffff', '#ffffff'] as const

  it('背景太亮时加厚底色，直到达标', () => {
    const r = resolveGlass(prefs({ source: 'wall' }), env({ backdrop: white }))
    expect(r.raised).toContain('side')
    expect(r.alpha.side).toBeGreaterThan(35)
    expect(r.contrast!.weak).toBeGreaterThanOrEqual(4.5)
    // 只多加到刚好达标：少 1% 就不够
    const less = resolveGlass(
      prefs({ source: 'wall', readable: 'off', zones: { ...DEFAULT_GLASS.zones, side: 100 - r.alpha.side - 65 + 1 } }),
      env({ backdrop: white }),
    )
    expect(less.contrast!.weak).toBeLessThan(4.5)
  })

  it('背景够暗就不动', () => {
    const r = resolveGlass(prefs({ source: 'wall' }), env({ backdrop: ['#000000', '#101010'] }))
    expect(r.raised).toEqual([])
  })

  it('读不到背景、颜色不是十六进制、关掉：都不加厚', () => {
    expect(resolveGlass(prefs({ source: 'wall' }), env()).raised).toEqual([])
    expect(
      resolveGlass(prefs({ source: 'wall' }), env({ backdrop: white, colors: { ...env().colors, body: 'rgb(1,2,3)' } }))
        .contrast,
    ).toBeNull()
    expect(resolveGlass(prefs({ source: 'wall', readable: 'off' }), env({ backdrop: white })).raised).toEqual([])
  })
})

describe('辅助函数', () => {
  it('对比度和 WCAG 一致', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21)
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBe(1)
  })

  it('壁纸暗部、亮部按亮度取', () => {
    const data: number[] = []
    for (let i = 0; i < 100; i++) data.push(i * 2, i * 2, i * 2, 255)
    expect(backdropExtremes(data)).toEqual(['#141414', '#b4b4b4'])
    expect(backdropExtremes([])).toBeNull()
  })

  it('预设只改预设管的项', () => {
    const preset: UiThemeGlass = {
      transparency: { dark: 1, light: 2 },
      blur: 3,
      saturate: 100,
      brightness: { dark: 50, light: 60 },
      grain: 4,
      rim: 5,
    }
    const p = applyGlassPreset(prefs({ radius: 20, source: 'wall' }), 'x', preset)
    expect(p).toMatchObject({ preset: 'x', blur: 3, grain: 4, radius: 20, source: 'wall' })
  })
})

describe('官方毛玻璃主题', () => {
  const file = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../../../../extensions/official/glass/themes/glass.json'), 'utf8'),
  ) as UiThemeFile

  it('文件合格，没调过时就是默认设置', () => {
    expect(uiThemeProblems(file)).toEqual([])
    expect(glassDefaultsOf(file.glass!)).toEqual(DEFAULT_GLASS)
  })
})

describe('主题自己的玻璃数值', () => {
  const own: UiThemeGlass = { ...GLASS_PRESETS.frost, blur: 33 }

  it('和预设一样就算那个预设，不一样就是主题默认', () => {
    expect(presetOfTheme(GLASS_PRESETS.balanced)).toBe('balanced')
    expect(presetOfTheme(own)).toBe('theme')
    expect(glassDefaultsOf(own)).toMatchObject({ preset: 'theme', blur: 33, source: 'desk' })
  })

  it('存的值坏了退回主题的数值，不是通用默认值', () => {
    const p = parseGlassPrefs({ blur: 'x', rim: 7 }, glassDefaultsOf(own))
    expect(p.blur).toBe(33)
    expect(p.rim).toBe(7)
  })
})
