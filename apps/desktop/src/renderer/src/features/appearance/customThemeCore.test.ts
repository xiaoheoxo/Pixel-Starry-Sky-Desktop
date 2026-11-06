import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_COLORS, THEME_COLOR_KEYS } from './customThemeBase'
import {
  MAX_THEMES,
  contrast,
  deriveVars,
  exportTheme,
  mergeThemeLists,
  mix,
  modeMismatch,
  parseImport,
  parseThemes,
  themeCss,
  type CustomTheme,
} from './customThemeCore'
import { PALETTES } from './palettes'

const css = readFileSync(join(__dirname, '../../styles/tokens.css'), 'utf8').replace(/\r\n/g, '\n')
const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
  sel: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(),
  vars: Object.fromEntries([...m[2].matchAll(/--([\w-]+):\s*([^;]+);/g)].map(x => [x[1], x[2].trim().toLowerCase()])),
}))

const theme = (patch: Partial<CustomTheme> = {}): CustomTheme => ({
  id: 't1',
  name: '我的',
  base: 'nord',
  light: BASE_COLORS.nord.light,
  dark: BASE_COLORS.nord.dark,
  ...patch,
})

describe('基础配色表', () => {
  it('和 tokens.css 一致（改了配色要重新生成这张表）', () => {
    const defaults = {
      light: blocks.find(b => b.sel.includes("[data-palette-preview='default']") && !b.sel.includes('dark'))!.vars,
      dark: blocks.find(b => b.sel.includes("[data-theme='dark'] [data-palette-preview='default']"))!.vars,
    }
    for (const id of PALETTES) {
      const own = {
        light:
          id === 'default'
            ? {}
            : blocks.find(b => b.sel.includes(`[data-palette='${id}']`) && !b.sel.includes('dark'))?.vars,
        dark:
          id === 'default' ? {} : blocks.find(b => b.sel.includes(`[data-theme='dark'][data-palette='${id}']`))?.vars,
      }
      for (const mode of ['light', 'dark'] as const)
        for (const key of THEME_COLOR_KEYS)
          expect(BASE_COLORS[id][mode][key], `${id} ${mode} ${key}`).toBe(own[mode]?.[key] ?? defaults[mode][key])
    }
  })
})

describe('parseThemes', () => {
  it('坏内容不崩，坏条目丢掉，重复 id 只留第一个', () => {
    expect(parseThemes(null)).toEqual([])
    expect(parseThemes('不是 json')).toEqual([])
    expect(parseThemes('{}')).toEqual([])
    const list = parseThemes(
      JSON.stringify([null, { id: 'x' }, { id: '', name: 'a' }, theme(), theme({ name: '重复' })]),
    )
    expect(list.map(t => t.name)).toEqual(['我的'])
  })

  it('不认识的基础配色退回默认；坏颜色取基础配色，好颜色留着', () => {
    const [t] = parseThemes(
      JSON.stringify([{ id: 'a', name: 'n', base: 'nope', light: { text: 'red', 'bg-app': '#ABCDEF' } }]),
    )
    expect(t.base).toBe('default')
    expect(t.light.text).toBe(BASE_COLORS.default.light.text)
    expect(t.light['bg-app']).toBe('#abcdef')
    expect(t.dark).toEqual(BASE_COLORS.default.dark)
  })

  it('超过上限的不要；遮罩夹到范围内；贴图没有 stamp 算没有', () => {
    const many = Array.from({ length: MAX_THEMES + 3 }, (_, i) => theme({ id: `t${i}` }))
    expect(parseThemes(JSON.stringify(many))).toHaveLength(MAX_THEMES)
    const [a, b] = parseThemes(
      JSON.stringify([
        { ...theme({ id: 'a' }), art: { on: true, stamp: 1, mask: { light: 500, dark: 'x' } } },
        { ...theme({ id: 'b' }), art: { on: true } },
      ]),
    )
    expect(a.art).toEqual({ on: true, stamp: 1, mask: { light: 90, dark: 50 } })
    expect(b.art).toBeUndefined()
  })
})

describe('派生变量', () => {
  it('都是 #RRGGBB（窗口底色要读 --wall-tint）', () => {
    for (const mode of ['light', 'dark'] as const)
      for (const value of Object.values(deriveVars(BASE_COLORS.nord[mode], mode)))
        expect(value).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('按钮文字按底色选黑或白，保证读得清', () => {
    const on = (bg: string) =>
      deriveVars({ ...BASE_COLORS.default.dark, 'theme-accent': bg, 'btn-primary-bg': bg }, 'dark')
    expect(on('#ffffff')['--theme-accent-on']).toBe('#000000')
    expect(on('#101010')['--btn-primary-text']).toBe('#ffffff')
  })

  it('mix 和 contrast', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#102030', '#ffffff', 1)).toBe('#102030')
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21)
    expect(contrast('#123456', '#123456')).toBeCloseTo(1)
  })
})

describe('themeCss', () => {
  it('优先级压过内置配色；大块底色让给壁纸规则', () => {
    const out = themeCss(theme())
    expect(out).toContain(":root[data-theme='dark'][data-custom-theme][data-custom-theme]{")
    const wallpaperRule = out.match(/\[data-theme='dark'\][^{]*:not\(\[data-wallpaper\]\)\{([^}]*)\}/)![1]
    const always = out.match(/\[data-theme='dark'\]\[data-custom-theme\]\[data-custom-theme\]\{([^}]*)\}/)![1]
    expect(wallpaperRule).toContain('--bg-app:')
    expect(always).not.toContain('--bg-app:')
    // 壁纸规则靠这几个变量算半透明底色，有壁纸时也要是自建主题的
    expect(always).toContain('--wall-surface:')
    expect(always).toContain('--wall-sidebar:')
  })
})

describe('同步合并', () => {
  const list = (...ids: string[]) => JSON.stringify(ids.map(id => theme({ id, name: id })))
  const ids = (v: unknown) => parseThemes(v as string).map(t => t.id)

  it('两边新建的都留下，同一个主题以本机为准', () => {
    const mine = JSON.stringify([theme({ id: 'a', name: '本机改的' }), theme({ id: 'b', name: 'b' })])
    const merged = mergeThemeLists(mine, list('a', 'c'))
    expect(ids(merged)).toEqual(['a', 'b', 'c'])
    expect(parseThemes(merged as string)[0].name).toBe('本机改的')
  })

  it('有一边没有、云端内容坏了；不超过上限', () => {
    expect(mergeThemeLists(null, list('a'))).toBe(list('a'))
    expect(mergeThemeLists(list('a'), null)).toBe(list('a'))
    expect(ids(mergeThemeLists(list('a'), '坏的'))).toEqual(['a'])
    const many = (p: string) => list(...Array.from({ length: 15 }, (_, i) => p + i))
    expect(ids(mergeThemeLists(many('x'), many('y')))).toHaveLength(MAX_THEMES)
  })
})

describe('派生文字色和模式', () => {
  it('文字色在底上不够清楚时变深，内置配色复制出来不低于 4.5', () => {
    for (const id of PALETTES) {
      const c = BASE_COLORS[id].light
      const vars = deriveVars(c, 'light')
      expect(contrast(vars['--warn-text'], c['bg-surface']), id).toBeGreaterThanOrEqual(4.5)
      expect(contrast(vars['--theme-accent-text'], vars['--theme-accent-soft']), id).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('本来够清楚的不动', () => {
    const vars = deriveVars({ ...BASE_COLORS.default.dark, warn: '#ffcc00' }, 'dark')
    expect(vars['--warn-text']).toBe('#ffcc00')
  })

  it('底色和模式相反时提醒；color-scheme 跟实际底色走', () => {
    const darkLook = { ...BASE_COLORS.default.light, 'bg-workbench': '#101010' }
    const lightLook = { ...BASE_COLORS.default.dark, 'bg-workbench': '#fafafa' }
    expect(modeMismatch(BASE_COLORS.default.light, 'light')).toBe(false)
    expect(modeMismatch(BASE_COLORS.default.dark, 'dark')).toBe(false)
    expect(modeMismatch(darkLook, 'light')).toBe(true)
    expect(modeMismatch(lightLook, 'dark')).toBe(true)
    expect(themeCss(theme({ light: darkLook }))).toContain(
      ":root[data-theme='light'][data-custom-theme][data-custom-theme]{color-scheme:dark;",
    )
    expect(themeCss(theme({ dark: lightLook }))).toContain(
      ":root[data-theme='dark'][data-custom-theme][data-custom-theme]{color-scheme:light;",
    )
  })
})

describe('导入导出', () => {
  it('导出再导入颜色不变，不带贴图和 id', () => {
    const t = theme({ art: { on: true, stamp: 1, mask: { light: 1, dark: 2 } } })
    const text = exportTheme(t)
    expect(text).not.toContain('stamp')
    expect(text).not.toContain('t1')
    const r = parseImport(text)
    expect(r).toEqual({ theme: { name: '我的', base: 'nord', light: t.light, dark: t.dark } })
  })

  it('坏内容给出原因', () => {
    expect(parseImport('不是 json')).toEqual({ error: 'json' })
    expect(parseImport('[]')).toEqual({ error: 'format' })
    expect(parseImport('{"name":"a"}')).toEqual({ error: 'format' })
    expect(parseImport('{"pixelskyTheme":1,"name":" "}')).toEqual({ error: 'name' })
    expect(parseImport('{"pixelskyTheme":1,"name":"a","dark":{"text":"red"}}')).toEqual({
      error: 'color',
      detail: 'dark.text',
    })
  })

  it('没写的颜色取基础配色；CSS 注入内容拒收', () => {
    const r = parseImport('{"pixelskyTheme":1,"name":"a","base":"nord","dark":{"text":"#111111"}}')
    expect(r).toMatchObject({
      theme: { base: 'nord', dark: { text: '#111111', 'bg-app': BASE_COLORS.nord.dark['bg-app'] } },
    })
    expect(parseImport('{"pixelskyTheme":1,"name":"a","dark":{"text":"#111111;}body{display:none"}}')).toMatchObject({
      error: 'color',
    })
  })
})
