import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE_COLORS } from './customThemeBase'

// 测试环境没有 DOM：只模拟模块用到的那几样
type Listener = (event: { key: string | null; storageArea: unknown }) => void
let values: Map<string, string>
let listeners: Listener[]
let rootEl: { dataset: Record<string, string | undefined> }
let style: { id: string; textContent: string; remove(): void } | null

const fakeStorage = {
  getItem: (k: string) => values.get(k) ?? null,
  setItem: (k: string, v: string) => void values.set(k, v),
  removeItem: (k: string) => void values.delete(k),
}
const localStorage = fakeStorage
const root = () => rootEl
const styleText = () => style?.textContent ?? null
const storageEvent = (key: string) => listeners.forEach(l => l({ key, storageArea: fakeStorage }))

/** 模块在导入时读 localStorage：每个用例重新导入，只留新模块的监听 */
async function load() {
  vi.resetModules()
  listeners = []
  return import('./customTheme')
}

beforeEach(() => {
  values = new Map()
  listeners = []
  rootEl = { dataset: {} }
  style = null
  vi.stubGlobal('localStorage', fakeStorage)
  vi.stubGlobal('window', { addEventListener: (_: string, l: Listener) => listeners.push(l) })
  vi.stubGlobal('document', {
    documentElement: rootEl,
    head: { appendChild: () => undefined },
    getElementById: () => style,
    createElement: () =>
      (style = {
        id: '',
        textContent: '',
        remove: () => {
          style = null
        },
      }),
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('自定义主题', () => {
  it('新建：选中、基础配色写到 data-palette、变量注入；回到内置后撤掉', async () => {
    const m = await load()
    const id = m.forkTheme(null, 'nord', 'A')!
    expect(root().dataset.customTheme).toBe(id)
    expect(root().dataset.palette).toBe('nord')
    expect(localStorage.getItem('pixelsky.palette')).toBe('nord')
    expect(localStorage.getItem(m.ACTIVE_THEME_KEY)).toBe(id)
    expect(styleText()).toContain(`--bg-app:${BASE_COLORS.nord.dark['bg-app']}`)

    m.setActiveTheme(null)
    expect(root().dataset.customTheme).toBeUndefined()
    expect(styleText()).toBeNull()
    expect(localStorage.getItem(m.ACTIVE_THEME_KEY)).toBeNull()
  })

  it('改色马上生效并存盘，重开还在', async () => {
    const m = await load()
    const id = m.forkTheme(null, 'nord', 'A')!
    m.setThemeColor(id, 'dark', 'bg-app', '#102030')
    expect(styleText()).toContain('--wall-tint:#102030')
    const again = await load()
    expect(root().dataset.customTheme).toBe(id)
    expect(styleText()).toContain('--wall-tint:#102030')
    again.resetTheme(id)
    expect(styleText()).not.toContain('--wall-tint:#102030')
  })

  it('复制自建主题带上改过的颜色；数量到上限不再新增', async () => {
    const m = await load()
    const a = m.forkTheme(null, 'github', 'A')!
    m.setThemeColor(a, 'light', 'text', '#111111')
    const from = JSON.parse(localStorage.getItem(m.THEMES_KEY)!)[0]
    const b = m.forkTheme(from, 'default', 'B')!
    const saved = JSON.parse(localStorage.getItem(m.THEMES_KEY)!)
    expect(saved.find((t: { id: string }) => t.id === b)).toMatchObject({ base: 'github', light: { text: '#111111' } })
    for (let i = 0; i < 25; i++) m.forkTheme(null, 'default', `n${i}`)
    expect(JSON.parse(localStorage.getItem(m.THEMES_KEY)!)).toHaveLength(20)
    expect(m.forkTheme(null, 'default', 'over')).toBeNull()
  })

  it('删掉正在用的：退回基础配色，不留选中', async () => {
    const m = await load()
    const id = m.forkTheme(null, 'nord', 'A')!
    m.removeTheme(id)
    expect(root().dataset.customTheme).toBeUndefined()
    expect(root().dataset.palette).toBe('nord')
    expect(localStorage.getItem(m.ACTIVE_THEME_KEY)).toBeNull()
  })

  it('改名：空名字不改，超长截断', async () => {
    const m = await load()
    const id = m.forkTheme(null, 'nord', 'A')!
    const name = () => JSON.parse(localStorage.getItem(m.THEMES_KEY)!)[0].name
    m.renameTheme(id, '   ')
    expect(name()).toBe('A')
    m.renameTheme(id, 'x'.repeat(40))
    expect(name()).toHaveLength(24)
  })

  it('别的窗口、同步改了：跟着变；主题没到时退回基础配色', async () => {
    const m = await load()
    const id = m.forkTheme(null, 'nord', 'A')!
    const list = JSON.parse(localStorage.getItem(m.THEMES_KEY)!)
    list[0].dark['bg-app'] = '#222222'
    localStorage.setItem(m.THEMES_KEY, JSON.stringify(list))
    storageEvent(m.THEMES_KEY)
    expect(styleText()).toContain('--wall-tint:#222222')

    localStorage.setItem(m.ACTIVE_THEME_KEY, 'still-syncing')
    storageEvent(m.ACTIVE_THEME_KEY)
    expect(root().dataset.customTheme).toBeUndefined()

    localStorage.setItem(m.ACTIVE_THEME_KEY, id)
    storageEvent(m.ACTIVE_THEME_KEY)
    expect(root().dataset.customTheme).toBe(id)
  })

  it('存着的配色和主题的基础配色不一致：属性以主题为准，不改存着的值；选回内置时恢复', async () => {
    const m = await load()
    m.forkTheme(null, 'nord', 'A')
    values.set('pixelsky.palette', 'github')
    // palette.ts 先把属性写成 github，自定义主题再摆正
    rootEl.dataset.palette = 'github'
    storageEvent('pixelsky.palette')
    expect(root().dataset.palette).toBe('nord')
    expect(values.get('pixelsky.palette')).toBe('github')
    m.setActiveTheme(null)
    expect(root().dataset.palette).toBe('github')
  })

  it('改颜色只在颜色真的变了时动 <html>，且不碰 data-theme', async () => {
    const m = await load()
    const id = m.forkTheme(null, 'nord', 'A')!
    root().dataset.theme = 'dark'
    const rev = root().dataset.customThemeRev
    m.setThemeColor(id, 'dark', 'bg-app', '#102030')
    const changed = root().dataset.customThemeRev
    expect(changed).not.toBe(rev)
    m.setThemeColor(id, 'dark', 'bg-app', '#102030')
    expect(root().dataset.customThemeRev).toBe(changed)
    expect(root().dataset.theme).toBe('dark')
  })

  it('贴图：类型、大小不对直接拒绝', async () => {
    const m = await load()
    const id = m.forkTheme(null, 'nord', 'A')!
    expect(await m.setThemeArt(id, new File(['x'], 'a.bmp', { type: 'image/bmp' }))).toBe('type')
    const big = new File(['x'], 'a.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: m.MAX_ART_BYTES + 1 })
    expect(await m.setThemeArt(id, big)).toBe('size')
  })
})
