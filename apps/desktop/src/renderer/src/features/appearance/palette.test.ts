import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { uiThemeProblems } from '@pixelsky/protocol'
import { DEFAULT_PALETTE, PALETTES } from './palettes'
import { searchSettings } from '../settings/searchIndex'

const tokens = readFileSync(fileURLToPath(new URL('../../styles/tokens.css', import.meta.url)), 'utf8')

/** 取出某个选择器那一块里的全部变量 */
function block(selector: string): Record<string, string> {
  const start = tokens.indexOf(selector)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))
}

/** 预装主题的文件；键加上 -- 和 tokens.css 同一个写法 */
function preset(id: string): { raw: unknown; light: Record<string, string>; dark: Record<string, string> } {
  const url = new URL(`../../../../../../../extensions/builtin/pixelsky.${id}/themes/${id}.json`, import.meta.url)
  const raw = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as Record<'light' | 'dark', Record<string, string>>
  const named = (vars: Record<string, string>) =>
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [`--${k}`, v]))
  return { raw, light: named(raw.light), dark: named(raw.dark) }
}
const PRESETS = PALETTES.filter(p => p !== DEFAULT_PALETTE)
const light = (p: string) => (p === DEFAULT_PALETTE ? block("[data-palette-preview='default'] {") : preset(p).light)
const dark = (p: string) =>
  p === DEFAULT_PALETTE ? block(":root[data-theme='dark'] [data-palette-preview='default'] {") : preset(p).dark

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

// 每套配色都要给的变量：少一个就会漏出默认暖灰
const REQUIRED = [
  '--ink',
  '--bg-rail',
  '--bg-sidebar',
  '--bg-app',
  '--bg-panel',
  '--bg-surface',
  '--bg-popover',
  '--bg-workbench',
  '--border',
  '--border-subtle',
  '--border-strong',
  '--text',
  '--text-secondary',
  '--text-muted',
  '--text-faint',
  '--text-body',
  '--theme-accent',
  '--theme-accent-on',
  '--theme-accent-soft',
  '--theme-accent-text',
  '--theme-accent-border',
  '--btn-primary-bg',
  '--btn-primary-text',
  '--btn-disabled-bg',
  '--btn-disabled-text',
  '--engine-chip-bg',
  '--engine-chip-text',
  '--wall-tint',
  '--wall-sidebar',
  '--wall-surface',
  '--terminal-bg',
  '--terminal-fg',
  '--terminal-cursor',
  '--terminal-selection',
].sort()

describe('配色', () => {
  it('预装主题的文件合格，浅色和深色都写全了，且两份不一样', () => {
    for (const p of PRESETS) {
      const file = preset(p)
      expect(uiThemeProblems(file.raw), p).toEqual([])
      for (const name of REQUIRED) {
        expect(file.light, `${p} 浅色`).toHaveProperty(name)
        expect(file.dark, `${p} 深色`).toHaveProperty(name)
      }
      expect(file.light, p).not.toEqual(file.dark)
    }
    // 默认暖灰的基础块也要有这些变量
    for (const vars of [light(DEFAULT_PALETTE), dark(DEFAULT_PALETTE)])
      for (const name of REQUIRED) expect(vars).toHaveProperty(name)
  })

  it('文字、主色、按钮的对比度都过 WCAG AA（4.5:1）', () => {
    for (const p of PALETTES)
      for (const [variant, v] of [
        ['浅色', light(p)],
        ['深色', dark(p)],
      ] as const) {
        const pairs: Array<[string, string]> = [
          ['--text', '--bg-app'],
          ['--text', '--bg-surface'],
          ['--text', '--bg-popover'],
          ['--text-body', '--bg-surface'],
          ['--text-secondary', '--bg-app'],
          ['--theme-accent-text', '--bg-app'],
          ['--theme-accent-text', '--bg-surface'],
          ['--theme-accent-text', '--theme-accent-soft'],
          ['--theme-accent-on', '--theme-accent'],
          ['--btn-primary-text', '--btn-primary-bg'],
          ['--terminal-fg', '--terminal-bg'],
        ]
        for (const [fg, bg] of pairs)
          expect(contrast(v[fg], v[bg]), `${p} ${variant} ${fg} / ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
  })

  it('设置搜索能按配色名找到配色主题', () => {
    for (const q of ['配色主题', 'nord', 'solarized', 'Tokyo Night'])
      expect(searchSettings(q, () => '外观').map(e => e.title)).toContain('配色主题')
  })
})
