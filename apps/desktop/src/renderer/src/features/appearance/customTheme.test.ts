import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePack } from '@/features/extpacks/testing'
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

describe('扩展主题', () => {
  const GLASS = {
    transparency: { dark: 60, light: 40 },
    blur: 20,
    saturate: 160,
    brightness: { dark: 70, light: 110 },
    grain: 2,
    rim: 35,
  }
  const ID = 'ext:a.b/night'
  const file = { pixelskyTheme: 1, base: 'default', dark: { text: '#e8ecf8' }, glass: GLASS }
  const flush = () => new Promise(r => setTimeout(r, 0))

  /** 假的扩展状态：changed() 让模块重新读一遍 */
  function fakePacks(initial: unknown) {
    let state = { revision: 1, loading: false, packs: packsOf() }
    let onChange = () => {}
    vi.stubGlobal('window', {
      addEventListener: (_: string, l: Listener) => listeners.push(l),
      pixelsky: {
        extpacks: {
          state: () => Promise.resolve(state),
          readJson: () => Promise.resolve(initial),
          onChange: (l: () => void) => {
            onChange = l
          },
        },
      },
    })
    return {
      remove() {
        state = { revision: 2, loading: false, packs: [] }
        onChange()
      },
    }
  }
  function packsOf() {
    return [
      fakePack({
        id: 'a.b',
        contributes: { uiThemes: [{ id: 'night', label: { zh: '夜空', en: 'Night' }, path: 'night.json' }] },
      }),
    ]
  }

  it('选中：写进 customTheme，基础配色和颜色生效，存一份启动缓存', async () => {
    fakePacks(file)
    const m = await load()
    await flush()
    m.setActiveTheme(ID)
    expect(localStorage.getItem(m.ACTIVE_THEME_KEY)).toBe(ID)
    expect(root().dataset.customTheme).toBe(ID)
    expect(styleText()).toContain('#e8ecf8')
    expect(m.getActiveExtTheme()?.glass).toEqual(GLASS)
    expect(JSON.parse(localStorage.getItem(m.EXT_THEME_CACHE_KEY)!).id).toBe(ID)
  })

  it('只写了玻璃：不注入样式，颜色就是基础配色', async () => {
    fakePacks({ pixelskyTheme: 1, glass: GLASS })
    const m = await load()
    await flush()
    m.setActiveTheme(ID)
    expect(root().dataset.customTheme).toBe(ID)
    expect(styleText()).toBeNull()
    expect(m.getActiveExtTheme()?.glass).toEqual(GLASS)
  })

  it('文件不合格：不出现在列表里，也选不中', async () => {
    fakePacks({ pixelskyTheme: 1, glass: { ...GLASS, blur: 999 } })
    const m = await load()
    await flush()
    m.setActiveTheme(ID)
    expect(m.getActiveExtTheme()).toBeNull()
    expect(localStorage.getItem(m.ACTIVE_THEME_KEY)).toBeNull()
  })

  it('下次启动：扩展读到之前缓存先生效；扩展没了撤掉，选中项和缓存也清干净', async () => {
    const packs = fakePacks(file)
    let m = await load()
    await flush()
    m.setActiveTheme(ID)

    // 读扩展的结果还没回来：缓存已经生效
    m = await load()
    expect(m.getActiveExtTheme()?.id).toBe(ID)
    expect(root().dataset.customTheme).toBe(ID)
    await flush()
    expect(m.getActiveExtTheme()?.id).toBe(ID)

    packs.remove()
    await flush()
    await flush()
    expect(m.getActiveExtTheme()).toBeNull()
    expect(root().dataset.customTheme).toBeUndefined()
    expect(styleText()).toBeNull()
    expect(localStorage.getItem(m.EXT_THEME_CACHE_KEY)).toBeNull()
    // 选中项留着：扩展重新启用后能回来
    expect(localStorage.getItem(m.ACTIVE_THEME_KEY)).toBe(ID)
  })

  it('缓存被手改成坏数据：当它不存在', async () => {
    values.set('pixelsky.customTheme', ID)
    values.set(
      'pixelsky.extThemeCache',
      JSON.stringify({ id: ID, label: 'x', file: { pixelskyTheme: 1, dark: { text: 'red}' } } }),
    )
    const m = await load()
    expect(m.getActiveExtTheme()).toBeNull()
  })
})

describe('自定义主题', () => {
  it('新建：选中、变量注入；回到暖灰后撤掉', async () => {
    const m = await load()
    const id = m.forkTheme(null, 'nord', 'A')!
    expect(root().dataset.customTheme).toBe(id)
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

  it('老版本选的配色：换成对应的预装主题，只迁移一次', async () => {
    values.set('pixelsky.palette', 'nord')
    const m = await load()
    expect(values.get(m.ACTIVE_THEME_KEY)).toBe('ext:pixelsky.nord/nord')
    expect(values.get('pixelsky.palette')).toBe('default')
    // 之后选回暖灰，重开不会又变回 Nord
    m.setActiveTheme(null)
    const again = await load()
    expect(values.get(again.ACTIVE_THEME_KEY)).toBeUndefined()
  })

  it('老版本已经在用我的主题：不换主题，只清掉老值', async () => {
    const first = await load()
    const id = first.forkTheme(null, 'nord', 'A')!
    values.set('pixelsky.palette', 'nord')
    const m = await load()
    expect(values.get(m.ACTIVE_THEME_KEY)).toBe(id)
    expect(values.get('pixelsky.palette')).toBe('default')
  })

  it('不认识的老值不迁移', async () => {
    values.set('pixelsky.palette', 'dracula')
    const m = await load()
    expect(values.get(m.ACTIVE_THEME_KEY)).toBeUndefined()
  })

  it('旧版本的电脑同步来老配色：没选主题就跟着换，选了主题不动', async () => {
    const m = await load()
    values.set('pixelsky.palette', 'github')
    storageEvent('pixelsky.palette')
    expect(values.get(m.ACTIVE_THEME_KEY)).toBe('ext:pixelsky.github/github')
    expect(values.get('pixelsky.palette')).toBe('default')
    values.set('pixelsky.palette', 'nord')
    storageEvent('pixelsky.palette')
    expect(values.get(m.ACTIVE_THEME_KEY)).toBe('ext:pixelsky.github/github')
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
