import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SIDEBAR_ICONS,
  FOOTER_ACTIONS,
  HEADER_ACTIONS,
  LAYOUT_ACTIONS,
  PAGE_ACTIONS,
  SIDEBAR_ACTIONS,
  TOOL_ACTIONS,
  getLayoutIcon,
  getSidebarIcon,
  type LayoutAction,
} from './sidebarIcons'
import {
  DEFAULT_SIDEBAR_LAYOUT,
  HEADER_ROW_LIMIT,
  LAYOUT_PLACEMENTS,
  MINIMAL_HEADER,
  headerActions,
  canPlace,
  isRowFull,
  moveSidebarActionInLayout,
  parseSidebarPrefs,
  SIDEBAR_PREFS_KEY,
  SIDEBAR_ROW_LIMIT,
  type SidebarLayout,
} from './sidebar'
import { searchSettings } from '../settings/searchIndex'
import { setCurrentLocale } from '../../i18n/core'

const H = DEFAULT_SIDEBAR_LAYOUT.header
const B = DEFAULT_SIDEBAR_LAYOUT.bottom
const X = DEFAULT_SIDEBAR_LAYOUT.hidden
/** 后加的入口（工具、设置页），旧偏好里没有，读出来都进「不显示」 */
const NEW = [...TOOL_ACTIONS, ...PAGE_ACTIONS]
const UPGRADES = ['header-git-to-more', 'recent-off']

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  setCurrentLocale('zh-CN')
})

function mockStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value)
    }),
  }
  vi.stubGlobal('localStorage', storage)
  return { storage, data }
}

const everything = (layout: SidebarLayout): string[] => [...layout.header, ...layout.bottom, ...layout.hidden].sort()

describe('侧边栏外观偏好', () => {
  it('常量：能挪的入口、三排顺序和默认布局（docs/ui/layout-v2.md §7.1）', () => {
    expect([...HEADER_ACTIONS]).toEqual(['git', 'openIn'])
    expect([...FOOTER_ACTIONS]).toEqual(['settings', 'plugins', 'usage'])
    expect([...LAYOUT_ACTIONS]).toEqual(['settings', 'plugins', 'usage', 'git', 'openIn', ...NEW])
    expect([...SIDEBAR_ACTIONS]).toEqual([
      'newTask',
      'search',
      'board',
      'channels',
      'addProject',
      'settings',
      'plugins',
      'usage',
    ])
    expect([...LAYOUT_PLACEMENTS]).toEqual(['header', 'bottom', 'hidden'])
    expect(DEFAULT_SIDEBAR_LAYOUT).toEqual({
      header: ['openIn'],
      bottom: ['usage', 'plugins', 'settings'],
      hidden: ['git', ...NEW],
    })
    expect(everything(DEFAULT_SIDEBAR_LAYOUT)).toEqual([...LAYOUT_ACTIONS].sort())
  })

  it('旧默认工具组自动换序，自定义布局保留，新版可再次自定义成旧顺序', () => {
    const oldLayout = { top: ['addProject', 'newTask'], bottom: ['settings', 'plugins', 'usage'] }
    const oldPrefs = {
      version: 2,
      layout: oldLayout,
      showRecent: false,
      recentExpanded: false,
      icons: { usage: 'gauge' },
    }
    const migrated = parseSidebarPrefs(oldPrefs)
    expect(migrated).toMatchObject({
      version: 4,
      upgrades: UPGRADES,
      layout: { header: H, bottom: B, hidden: X },
      showRecent: false,
      recentExpanded: false,
      icons: { usage: 'gauge' },
    })
    // 自己排过的：底部先读、旧顶部的设置 / 用量接在后面
    const custom = { top: ['usage', 'addProject', 'newTask'], bottom: ['settings', 'plugins'] }
    expect(parseSidebarPrefs({ ...oldPrefs, layout: custom }).layout).toEqual({
      header: H,
      bottom: ['settings', 'plugins', 'usage'],
      hidden: X,
    })
    // v3 里 v2 的旧默认位置不换（只有 v2 换）
    expect(parseSidebarPrefs({ ...oldPrefs, version: 3 }).layout).toEqual({
      header: H,
      bottom: ['settings', 'plugins', 'usage'],
      hidden: X,
    })
  })

  it('v2 旧默认位置（读原始数据比对）整份换成新默认', () => {
    const v2 = parseSidebarPrefs({
      version: 2,
      layout: { top: ['addProject', 'newTask'], bottom: ['settings', 'plugins', 'usage'] },
    })
    expect(v2.layout).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })

  it('最近任务默认不显示，无法识别的版本和损坏内容安全回退', () => {
    const fallback = {
      version: 4,
      upgrades: UPGRADES,
      showRecent: false,
      recentExpanded: true,
      icons: DEFAULT_SIDEBAR_ICONS,
      layout: DEFAULT_SIDEBAR_LAYOUT,
    }
    for (const value of [null, undefined, 1, [], 'invalid', {}, { version: 5, showRecent: false }]) {
      expect(parseSidebarPrefs(value)).toEqual(fallback)
    }
    expect(parseSidebarPrefs({ version: 1, showRecent: 'false', recentExpanded: 0, icons: [] })).toEqual(fallback)
  })

  it('缺失、未知或属于其他动作的图标按项回退，不抹掉有效选择', () => {
    const prefs = parseSidebarPrefs({
      version: 1,
      showRecent: false,
      recentExpanded: false,
      icons: {
        newTask: 'pen-line',
        addProject: 'missing',
        settings: 'puzzle',
        usage: '__proto__',
      },
    })
    expect(prefs).toEqual({
      version: 4,
      upgrades: UPGRADES,
      showRecent: false,
      recentExpanded: false,
      layout: DEFAULT_SIDEBAR_LAYOUT,
      icons: {
        ...DEFAULT_SIDEBAR_ICONS,
        newTask: 'pen-line',
      },
    })
    expect(getSidebarIcon('usage', { ...prefs.icons, usage: 'missing' as never })).toBe(
      getSidebarIcon('usage', DEFAULT_SIDEBAR_ICONS),
    )
  })

  it('搜索、任务看板、频道的图标（layout-v2.md §17）：旧数据里没有时取默认，能存能读，不收别的入口的候选', () => {
    expect(DEFAULT_SIDEBAR_ICONS).toMatchObject({
      search: 'search',
      board: 'square-kanban',
      channels: 'message-square',
    })
    const prefs = parseSidebarPrefs({
      version: 4,
      icons: { search: 'scan-search', board: 'list-todo', channels: 'plus' },
    })
    expect(prefs.icons).toMatchObject({ search: 'scan-search', board: 'list-todo', channels: 'message-square' })
  })

  it('v1 自动采用默认位置并保留已有图标和历史选择，下次修改保存 v4', async () => {
    const { data } = mockStorage({
      [SIDEBAR_PREFS_KEY]: JSON.stringify({
        version: 1,
        showRecent: false,
        recentExpanded: false,
        icons: { ...DEFAULT_SIDEBAR_ICONS, settings: 'bolt', newTask: 'plus' },
        layout: { top: ['usage'], bottom: [] },
      }),
    })
    vi.resetModules()
    const sidebar = await import('./sidebar')
    expect(sidebar.getSidebarPrefs()).toEqual({
      version: 4,
      upgrades: UPGRADES,
      showRecent: false,
      recentExpanded: false,
      icons: { ...DEFAULT_SIDEBAR_ICONS, settings: 'bolt', newTask: 'plus' },
      layout: DEFAULT_SIDEBAR_LAYOUT,
    })
    sidebar.moveSidebarAction('settings', 'header', 0)
    expect(JSON.parse(data.get(SIDEBAR_PREFS_KEY)!)).toEqual(sidebar.getSidebarPrefs())
    expect(sidebar.getSidebarPrefs().layout.header).toEqual(['settings', 'openIn'])
  })

  it('损坏布局保留合法顺序、跨排去重，并按默认排补齐缺失入口', () => {
    const prefs = parseSidebarPrefs({
      version: 3,
      layout: {
        bottom: ['usage', 'usage', 'unknown', null, '__proto__', 'newTask', 'settings', 0],
      },
    })
    expect(prefs.layout).toEqual({ header: H, bottom: ['usage', 'settings', 'plugins'], hidden: X })
    expect(parseSidebarPrefs({ version: 3, layout: { top: 'settings', bottom: ['newTask'] } }).layout).toEqual(
      DEFAULT_SIDEBAR_LAYOUT,
    )
    for (const layout of [null, [], {}, 'broken', { top: [], bottom: [], more: [], hidden: [] }]) {
      expect(parseSidebarPrefs({ version: 3, layout }).layout).toEqual(DEFAULT_SIDEBAR_LAYOUT)
    }
  })

  it('同排移动以移除原位置后的索引插入，跨排移动保留其他图标顺序', () => {
    const layout = structuredClone(DEFAULT_SIDEBAR_LAYOUT)
    expect(moveSidebarActionInLayout(layout, 'settings', 'bottom', 2)).toEqual(layout)
    expect(moveSidebarActionInLayout(layout, 'usage', 'bottom', 0)).toEqual(layout)
    expect(moveSidebarActionInLayout(layout, 'settings', 'bottom', 0).bottom).toEqual(['settings', 'usage', 'plugins'])
    expect(moveSidebarActionInLayout(layout, 'plugins', 'header', 0)).toEqual({
      header: ['plugins', 'openIn'],
      bottom: ['usage', 'settings'],
      hidden: X,
    })
    expect(moveSidebarActionInLayout(layout, 'plugins', 'hidden', 99)).toEqual({
      header: H,
      bottom: ['usage', 'settings'],
      hidden: [...X, 'plugins'],
    })
    expect(layout).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })

  it('越界、NaN 索引不丢失任何入口', () => {
    const layout = structuredClone(DEFAULT_SIDEBAR_LAYOUT)
    for (const row of LAYOUT_PLACEMENTS) {
      for (const action of LAYOUT_ACTIONS) {
        for (const index of [-1, 0, 1, 99, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
          const moved = moveSidebarActionInLayout(layout, action, row, index)
          expect(everything(moved)).toEqual([...LAYOUT_ACTIONS].sort())
          if (canPlace(layout, row, action)) expect(moved[row]).toContain(action)
        }
      }
    }
  })

  it('折叠、隐藏、图标和布局选择重启后保留，恢复显示不改变折叠选择', async () => {
    const { data } = mockStorage({ 'pixelsky.fonts': '{"scale":1.3}' })
    vi.resetModules()
    let sidebar = await import('./sidebar')
    sidebar.setSidebarPrefs({ showRecent: false, recentExpanded: false })
    sidebar.setSidebarIcon('newTask', 'plus')
    sidebar.setSidebarLayout({
      header: ['git', 'openIn'],
      bottom: ['settings', 'usage'],
      hidden: ['plugins'],
    })
    vi.resetModules()
    sidebar = await import('./sidebar')
    expect(sidebar.getSidebarPrefs()).toMatchObject({
      showRecent: false,
      recentExpanded: false,
      icons: { newTask: 'plus' },
      layout: { header: ['git', 'openIn'], bottom: ['settings', 'usage'], hidden: ['plugins', ...NEW] },
    })
    sidebar.setSidebarPrefs({ showRecent: true })
    expect(sidebar.getSidebarPrefs().recentExpanded).toBe(false)
    expect(data.get('pixelsky.fonts')).toBe('{"scale":1.3}')
    expect(JSON.parse(data.get(SIDEBAR_PREFS_KEY)!)).toEqual(sidebar.getSidebarPrefs())
  })

  it('恢复默认图标保留布局和历史状态，恢复默认位置保留图标和历史状态', async () => {
    mockStorage()
    vi.resetModules()
    const sidebar = await import('./sidebar')
    sidebar.setSidebarPrefs({ showRecent: false, recentExpanded: false })
    sidebar.setSidebarIcon('plugins', 'plug')
    sidebar.setSidebarIcon('usage', 'gauge')
    sidebar.moveSidebarAction('usage', 'header', 0)
    const movedLayout = { header: ['usage', 'openIn'], bottom: ['plugins', 'settings'], hidden: X }
    sidebar.resetSidebarIcons()
    expect(sidebar.getSidebarPrefs()).toEqual({
      version: 4,
      upgrades: UPGRADES,
      showRecent: false,
      recentExpanded: false,
      icons: DEFAULT_SIDEBAR_ICONS,
      layout: movedLayout,
    })
    sidebar.setSidebarIcon('plugins', 'plug')
    sidebar.resetSidebarLayout()
    expect(sidebar.getSidebarPrefs()).toEqual({
      version: 4,
      upgrades: UPGRADES,
      showRecent: false,
      recentExpanded: false,
      icons: { ...DEFAULT_SIDEBAR_ICONS, plugins: 'plug' },
      layout: DEFAULT_SIDEBAR_LAYOUT,
    })
    vi.resetModules()
    expect((await import('./sidebar')).getSidebarPrefs()).toEqual(sidebar.getSidebarPrefs())
  })

  it('最近任务只关一次：没做过 recent-off 的关掉，做过之后自己打开的保留', () => {
    const old = parseSidebarPrefs({ version: 4, upgrades: ['header-git-to-more'], showRecent: true })
    expect(old).toMatchObject({ showRecent: false, upgrades: UPGRADES })
    expect(parseSidebarPrefs({ ...old, showRecent: true })).toMatchObject({ showRecent: true, upgrades: UPGRADES })
    expect(parseSidebarPrefs({ version: 1, showRecent: true })).toMatchObject({ showRecent: false, upgrades: UPGRADES })
  })

  it('分区：名字去空白、最长 40 字，项目只算在第一个分区，空分区和坏数据丢掉', () => {
    const groups = parseSidebarPrefs({
      version: 4,
      groups: [
        { id: 'g1', name: '  像素星空  ', projects: ['a', 'b', 'a', 3] },
        { id: 'g2', name: '重复的项目', projects: ['b'] },
        { id: 'g1', name: '重复 ID', projects: ['c'] },
        { id: 'g3', name: '   ', projects: ['d'] },
        { id: 'g4', name: '长'.repeat(50), projects: ['e'] },
        null,
        'bad',
      ],
    }).groups
    expect(groups).toEqual([
      { id: 'g1', name: '像素星空', projects: ['a', 'b'] },
      { id: 'g4', name: '长'.repeat(40), projects: ['e'] },
    ])
    expect(parseSidebarPrefs({ version: 4, groups: 'x' }).groups).toBeUndefined()
  })

  it('拖出来的项目先后：只留字符串、去重、最多 500 个，坏数据丢掉', () => {
    expect(parseSidebarPrefs({ version: 4, order: ['b', 'a', 'b', 3, '', 'c'] }).order).toEqual(['b', 'a', 'c'])
    expect(parseSidebarPrefs({ version: 4, order: 'x' }).order).toBeUndefined()
    const ids = Array.from({ length: 505 }, (_, i) => `p${i}`)
    expect(parseSidebarPrefs({ version: 4, order: ids }).order).toHaveLength(500)
  })

  it('收起的项目：只留字符串、去重、最多 200 个', () => {
    const ids = Array.from({ length: 205 }, (_, i) => `p${i}`)
    expect(parseSidebarPrefs({ version: 4, collapsed: ['a', 'a', 3, '', 'b'] }).collapsed).toEqual(['a', 'b'])
    expect(parseSidebarPrefs({ version: 4, collapsed: ids }).collapsed).toEqual(ids.slice(5))
    expect(parseSidebarPrefs({ version: 4, collapsed: 'a' }).collapsed).toBeUndefined()
  })

  it('存储读取失败或 JSON 损坏时能启动，写入失败时仍可切换和恢复', async () => {
    const { storage } = mockStorage({ [SIDEBAR_PREFS_KEY]: '{broken' })
    vi.resetModules()
    const sidebar = await import('./sidebar')
    expect(sidebar.getSidebarPrefs().icons).toEqual(DEFAULT_SIDEBAR_ICONS)
    storage.getItem.mockImplementation(() => {
      throw new Error('Storage unavailable')
    })
    expect(sidebar.readSidebarPrefs().showRecent).toBe(false)
    storage.setItem.mockImplementation(() => {
      throw new Error('Quota exceeded')
    })
    expect(() => sidebar.setSidebarPrefs({ showRecent: false })).not.toThrow()
    sidebar.setSidebarIcon('settings', 'bolt')
    sidebar.moveSidebarAction('usage', 'header', 0)
    expect(sidebar.getSidebarPrefs()).toMatchObject({ showRecent: false, icons: { settings: 'bolt' } })
    expect(sidebar.getSidebarPrefs().layout.header).toEqual(['usage', 'openIn'])
    sidebar.resetSidebarIcons()
    sidebar.resetSidebarLayout()
    expect(sidebar.getSidebarPrefs()).toMatchObject({ showRecent: false, icons: DEFAULT_SIDEBAR_ICONS })
    expect(sidebar.getSidebarPrefs().layout).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })

  it('调用者修改输入或移动结果不改变已保存布局，损坏运行时布局也会修复', async () => {
    mockStorage()
    vi.resetModules()
    const sidebar = await import('./sidebar')
    const layout: SidebarLayout = { header: [...H], bottom: [...B], hidden: [...X] }
    sidebar.setSidebarLayout(layout)
    layout.bottom.length = 0
    expect(sidebar.getSidebarPrefs().layout.bottom).toEqual(B)
    const preview = sidebar.moveSidebarActionInLayout(sidebar.getSidebarPrefs().layout, 'usage', 'header', 0)
    preview.header.length = 0
    expect(sidebar.getSidebarPrefs().layout.bottom).toEqual(B)
    sidebar.setSidebarLayout({ header: ['usage', 'usage'], bottom: ['unknown'] } as unknown as SidebarLayout)
    expect(sidebar.getSidebarPrefs().layout).toEqual({
      header: ['usage', 'openIn'],
      bottom: ['plugins', 'settings'],
      hidden: X,
    })
  })

  it('损坏的运行时图标输入也会按动作回退', async () => {
    mockStorage()
    vi.resetModules()
    const sidebar = await import('./sidebar')
    sidebar.setSidebarIcon('newTask', 'puzzle')
    expect(sidebar.getSidebarPrefs().icons.newTask).toBe(DEFAULT_SIDEBAR_ICONS.newTask)
    sidebar.setSidebarIcon('addProject', 'folder-open')
    expect(sidebar.getSidebarPrefs().icons.addProject).toBe('folder-open')
  })

  it('极简模式的顶栏：没改过顶栏用极简的默认摆法，改过的按用户摆的来（minimal-mode.md §12 C）', () => {
    expect(headerActions(DEFAULT_SIDEBAR_LAYOUT, false)).toBe(DEFAULT_SIDEBAR_LAYOUT.header)
    expect(headerActions(DEFAULT_SIDEBAR_LAYOUT, true)).toBe(MINIMAL_HEADER)
    const custom = moveSidebarActionInLayout(DEFAULT_SIDEBAR_LAYOUT, 'tool:files', 'header', 0)
    expect(headerActions(custom, true)).toBe(custom.header)
    expect(MINIMAL_HEADER.length).toBeLessThanOrEqual(HEADER_ROW_LIMIT)
    for (const action of MINIMAL_HEADER) expect(LAYOUT_ACTIONS).toContain(action)
  })

  it('项目置顶：放最前、从分区里拿出来；又进了分区就取消置顶；坏数据丢掉（project-pin.md）', async () => {
    vi.resetModules()
    const sidebar = await import('./sidebar')
    sidebar.setProjectGroups([{ id: 'g', name: '组', projects: ['a', 'b'] }])
    sidebar.setProjectPinned('a', true)
    sidebar.setProjectPinned('c', true)
    expect(sidebar.getSidebarPrefs().pinned).toEqual(['c', 'a'])
    expect(sidebar.getSidebarPrefs().groups).toEqual([{ id: 'g', name: '组', projects: ['b'] }])
    sidebar.setProjectPinned('b', true)
    expect(sidebar.getSidebarPrefs().groups).toBeUndefined()
    sidebar.setProjectGroups([{ id: 'h', name: '新组', projects: ['a'] }])
    expect(sidebar.getSidebarPrefs().pinned).toEqual(['b', 'c'])
    sidebar.setProjectPinned('b', false)
    expect(sidebar.getSidebarPrefs().pinned).toEqual(['c'])
    expect(parseSidebarPrefs({ version: 4, pinned: ['x', 'x', 3, '', 'y'] }).pinned).toEqual(['x', 'y'])
  })

  it('顶栏工具与底部动作可在三排之间互相移动，图标随入口走', () => {
    let layout = moveSidebarActionInLayout(DEFAULT_SIDEBAR_LAYOUT, 'git', 'bottom', 0)
    expect(layout.hidden).toEqual(NEW)
    expect(layout.bottom).toEqual(['git', 'usage', 'plugins', 'settings'])
    layout = moveSidebarActionInLayout(layout, 'usage', 'header', 0)
    expect(layout.header[0]).toBe('usage')
    expect(layout.bottom).toEqual(['git', 'plugins', 'settings'])
    expect(getLayoutIcon('usage', DEFAULT_SIDEBAR_ICONS)).toBe(getSidebarIcon('usage', DEFAULT_SIDEBAR_ICONS))
    expect(getLayoutIcon('git', DEFAULT_SIDEBAR_ICONS)).toBeTruthy()
    expect(getLayoutIcon('openIn', DEFAULT_SIDEBAR_ICONS)).toBeTruthy()
  })

  it('「设置」不能放进「不显示」（它是改回来的入口）；别的入口可以', () => {
    expect(canPlace(DEFAULT_SIDEBAR_LAYOUT, 'hidden', 'settings')).toBe(false)
    expect(canPlace(DEFAULT_SIDEBAR_LAYOUT, 'hidden', 'plugins')).toBe(true)
    expect(moveSidebarActionInLayout(DEFAULT_SIDEBAR_LAYOUT, 'settings', 'hidden', 0)).toEqual(DEFAULT_SIDEBAR_LAYOUT)
    const moved = moveSidebarActionInLayout(DEFAULT_SIDEBAR_LAYOUT, 'plugins', 'hidden', 0)
    expect(moved.hidden).toEqual(['plugins', ...X])
    // 存的数据里「设置」在 hidden（手改或坏数据）：读出来在底部
    const prefs = parseSidebarPrefs({
      version: 4,
      upgrades: UPGRADES,
      layout: { header: ['openIn'], bottom: ['usage'], hidden: ['settings', 'git'] },
    })
    expect(prefs.layout).toEqual({ header: H, bottom: ['usage', 'settings', 'plugins'], hidden: X })
  })

  it('底部一排最多 5 个，排满时拒绝移入但允许排内换序；「不显示」不限', () => {
    expect(SIDEBAR_ROW_LIMIT).toBe(5)
    let layout = DEFAULT_SIDEBAR_LAYOUT
    for (const action of ['git', 'openIn'] as const) layout = moveSidebarActionInLayout(layout, action, 'bottom', 99)
    expect(layout.bottom).toHaveLength(SIDEBAR_ROW_LIMIT)
    expect(layout.header).toEqual([])
    expect(isRowFull(layout, 'bottom')).toBe(true)
    expect(isRowFull(layout, 'bottom', 'git')).toBe(false)
    expect(isRowFull(layout, 'header')).toBe(false)
    expect(isRowFull(layout, 'hidden')).toBe(false)
    expect(canPlace(layout, 'bottom', 'git')).toBe(true)
    // 排内换序可以
    expect(moveSidebarActionInLayout(layout, 'git', 'bottom', 0).bottom[0]).toBe('git')
    // 一排已有 5 个、再来一个别的入口：放不下（用越界的入口模拟第 6 个）
    expect(canPlace(layout, 'bottom', 'extra' as LayoutAction)).toBe(false)
    expect(canPlace(layout, 'header', 'extra' as LayoutAction)).toBe(true)
  })

  it('顶栏最多 8 个，满了拒绝移入；存的数据超了，多的进底部，底部也满进「不显示」，一个不丢', () => {
    expect(HEADER_ROW_LIMIT).toBe(8)
    let layout = DEFAULT_SIDEBAR_LAYOUT
    for (const action of TOOL_ACTIONS.slice(0, 7)) layout = moveSidebarActionInLayout(layout, action, 'header', 99)
    expect(layout.header).toHaveLength(8)
    expect(isRowFull(layout, 'header')).toBe(true)
    expect(canPlace(layout, 'header', 'tool:copies')).toBe(false)
    expect(moveSidebarActionInLayout(layout, 'tool:copies', 'header', 0)).toEqual(layout)
    expect(moveSidebarActionInLayout(layout, 'tool:browser', 'header', 99).header.at(-1)).toBe('tool:browser')
    const over = parseSidebarPrefs({ version: 4, upgrades: UPGRADES, layout: { header: [...LAYOUT_ACTIONS] } }).layout
    expect(over.header).toHaveLength(8)
    expect(over.bottom.length).toBeLessThanOrEqual(5)
    expect(over.hidden).not.toContain('settings')
    expect(everything(over)).toEqual([...LAYOUT_ACTIONS].sort())
  })

  it('新入口有图标；旧数据里同名的 terminal、machines 不会变成新入口', () => {
    for (const action of NEW) expect(getLayoutIcon(action, DEFAULT_SIDEBAR_ICONS)).toBeTruthy()
    const { header, hidden } = parseSidebarPrefs({
      version: 4,
      upgrades: UPGRADES,
      layout: { header: ['terminal', 'machines', 'openIn'], bottom: B, hidden: ['git'] },
    }).layout
    expect(header).toEqual(['openIn'])
    expect(hidden).toEqual(X)
  })

  it('旧偏好里没有「打开方式」（GitHub #12）：读取时补到顶栏', () => {
    const prefs = parseSidebarPrefs({
      version: 4,
      upgrades: UPGRADES,
      layout: { header: ['git', 'workbench'], bottom: ['usage', 'plugins', 'settings'] },
    })
    expect(prefs.layout.header).toEqual(['git', 'openIn'])
  })

  it('工作台、频道、新建任务、添加项目在任何一排都丢掉', () => {
    const prefs = parseSidebarPrefs({
      version: 4,
      upgrades: UPGRADES,
      layout: {
        header: ['workbench', 'openIn', 'channels'],
        bottom: ['newTask', 'usage', 'channels', 'plugins', 'settings'],
        hidden: ['addProject', 'git', 'workbench'],
        top: ['addProject', 'newTask', 'channels'],
        more: ['workbench'],
      },
    })
    expect(prefs.layout).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })

  it('终端、编辑器、命令面板、云主机已移除，旧偏好里的位置读取时丢弃', () => {
    const prefs = parseSidebarPrefs({
      version: 4,
      upgrades: UPGRADES,
      layout: {
        header: ['terminal', 'editor', 'commandPalette', 'machines', 'git'],
        top: ['commandPalette', 'settings'],
        bottom: ['editor', 'usage'],
      },
    })
    expect(prefs.layout).toEqual({ header: ['git', 'openIn'], bottom: ['usage', 'settings', 'plugins'], hidden: NEW })
    expect(everything(prefs.layout)).toEqual([...LAYOUT_ACTIONS].sort())
  })

  it('旧偏好里的自动化原位换成 Git（D061），不重复、不丢位置', () => {
    const prefs = parseSidebarPrefs({
      version: 4,
      upgrades: UPGRADES,
      layout: { header: ['terminal', 'workbench'], bottom: ['automation', 'usage'] },
    })
    expect(prefs.layout.bottom.slice(0, 2)).toEqual(['git', 'usage'])
    expect(everything(prefs.layout).filter(a => a === 'git')).toHaveLength(1)
    expect(everything(prefs.layout)).not.toContain('automation')
    expect(parseSidebarPrefs({ version: 4, layout: { header: ['automation', 'git'] } }).layout.header[0]).toBe('git')
  })

  it('旧 top 里的设置 / 插件 / 用量进底部，缺的入口按默认补', () => {
    const prefs = parseSidebarPrefs({
      version: 4,
      upgrades: UPGRADES,
      layout: {
        header: ['workbench', 'channels', 'openIn'],
        more: [],
        top: ['addProject', 'newTask', 'settings'],
        bottom: ['usage', 'plugins'],
      },
    })
    expect(prefs.layout).toEqual({ header: H, bottom: ['usage', 'plugins', 'settings'], hidden: X })
  })

  it('旧 more 里的入口进「不显示」，其中的设置进底部', () => {
    const prefs = parseSidebarPrefs({
      version: 4,
      upgrades: UPGRADES,
      layout: {
        header: ['workbench', 'channels', 'openIn'],
        more: ['plugins', 'settings'],
        top: [],
        bottom: ['usage'],
      },
    })
    expect(prefs.layout).toEqual({ header: H, bottom: ['usage', 'settings'], hidden: ['plugins', ...X] })
  })

  it('旧默认 v4 → 顶栏只剩打开方式、底部照旧、Git 不显示', () => {
    const prefs = parseSidebarPrefs({
      version: 4,
      upgrades: UPGRADES,
      layout: {
        header: ['workbench', 'channels', 'openIn'],
        more: ['git'],
        top: ['addProject', 'newTask'],
        bottom: ['usage', 'plugins', 'settings'],
      },
    })
    expect(prefs.layout).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })

  it('自己把 Git 放在顶栏的保留', () => {
    const prefs = parseSidebarPrefs({
      version: 4,
      upgrades: UPGRADES,
      layout: { header: ['git', 'workbench', 'channels', 'openIn'], more: [], top: [], bottom: B },
    })
    expect(prefs.layout).toEqual({ header: ['git', 'openIn'], bottom: B, hidden: NEW })
  })

  it('旧偏好是 v1/v2/v3/坏数据时都不崩，读出来的入口一个不少', () => {
    const inputs: unknown[] = [
      { version: 1, layout: { top: ['usage'] } },
      { version: 2, layout: { top: [1, 2], bottom: 'x' } },
      { version: 3, layout: { top: ['settings'], bottom: ['plugins'] } },
      { version: 4, layout: { header: 5, more: {}, top: null, bottom: [{}] } },
      { version: 4, layout: { header: [], top: [...LAYOUT_ACTIONS], bottom: [] } },
      { version: 4, layout: { hidden: [...LAYOUT_ACTIONS] } },
    ]
    for (const input of inputs) {
      const prefs = parseSidebarPrefs(input)
      expect(everything(prefs.layout)).toEqual([...LAYOUT_ACTIONS].sort())
      expect(prefs.layout.bottom.length).toBeLessThanOrEqual(SIDEBAR_ROW_LIMIT)
      expect(prefs.layout.hidden).not.toContain('settings')
    }
  })

  it('parse(parse(x)) 等于 parse(x)', () => {
    const inputs: unknown[] = [
      null,
      { version: 1 },
      { version: 2, layout: { top: ['addProject', 'newTask'], bottom: ['settings', 'plugins', 'usage'] } },
      { version: 3, layout: { top: ['usage', 'settings'], bottom: ['plugins'] } },
      {
        version: 4,
        layout: {
          header: ['workbench', 'channels', 'git', 'openIn'],
          more: [],
          top: ['addProject', 'newTask'],
          bottom: B,
        },
      },
      {
        version: 4,
        upgrades: UPGRADES,
        layout: { header: ['workbench', 'openIn'], more: ['git', 'plugins', 'settings'] },
      },
      { version: 4, layout: { hidden: ['settings', 'plugins'], bottom: [], header: [] } },
    ]
    for (const input of inputs) {
      const once = parseSidebarPrefs(input)
      expect(parseSidebarPrefs(once)).toEqual(once)
    }
  })

  it('新版写出的数据按旧版规则读（补回工作台 / 频道 / Git）再按新版读，结果不变', () => {
    // 旧版只认 header / more / top / bottom：忽略 hidden，缺的按它的默认补
    const oldRound = (layout: SidebarLayout) => {
      const header = [...layout.header, ...['workbench', 'channels'].filter(a => !layout.header.includes(a as never))]
      const gitSeen = [...layout.header, ...layout.bottom].includes('git')
      return { header, more: gitSeen ? [] : ['git'], top: ['addProject', 'newTask'], bottom: layout.bottom }
    }
    const layouts: SidebarLayout[] = [
      DEFAULT_SIDEBAR_LAYOUT,
      { header: ['git', 'openIn'], bottom: ['usage', 'settings', 'plugins'], hidden: [] },
      { header: ['openIn'], bottom: ['settings'], hidden: ['git'] },
    ].map(l => parseSidebarPrefs({ version: 4, upgrades: UPGRADES, layout: l }).layout)
    for (const layout of layouts) {
      const back = parseSidebarPrefs({ version: 4, upgrades: UPGRADES, layout: oldRound(layout) }).layout
      // 旧版会把 hidden 里的插件 / 用量补回底部，所以只比较 Git 之外的排没有被它改过的情况
      if (layout.hidden.every(a => a === 'git')) expect(back).toEqual(layout)
    }
  })

  it('没做过 header-git-to-more 的旧默认顶栏读出来 Git 在「不显示」（读原始数据，不是解析结果）', () => {
    const old = { top: ['addProject', 'newTask'], bottom: ['usage', 'plugins', 'settings'] }
    const migrated = parseSidebarPrefs({
      version: 4,
      layout: { header: ['workbench', 'channels', 'git', 'openIn'], ...old },
    })
    expect(migrated.layout).toEqual(DEFAULT_SIDEBAR_LAYOUT)
    expect(migrated.upgrades).toEqual(UPGRADES)
    // 自己排过的顶栏不动：Git 还在顶栏
    const custom = parseSidebarPrefs({
      version: 4,
      layout: { header: ['git', 'workbench', 'channels', 'openIn'], ...old },
    })
    expect(custom.layout.header).toEqual(['git', 'openIn'])
    expect(custom.layout.hidden).toEqual(NEW)
    // 升级过之后再把 Git 挪回顶栏，不会又被收起
    const back = parseSidebarPrefs({
      version: 4,
      upgrades: UPGRADES,
      layout: { header: ['workbench', 'channels', 'git', 'openIn'], more: [], ...old },
    })
    expect(back.layout.header).toEqual(['git', 'openIn'])
    // 旧默认顶栏但「更多工具」里已经有东西：当成自己排过的
    const withMore = parseSidebarPrefs({
      version: 4,
      layout: { header: ['workbench', 'channels', 'git', 'openIn'], more: ['plugins'], ...old },
    })
    expect(withMore.layout.header).toEqual(['git', 'openIn'])
  })

  it('恢复默认位置同时恢复顶栏排', async () => {
    mockStorage()
    vi.resetModules()
    const sidebar = await import('./sidebar')
    sidebar.moveSidebarAction('git', 'bottom', 0)
    sidebar.moveSidebarAction('settings', 'header', 0)
    expect(sidebar.getSidebarPrefs().layout.header[0]).toBe('settings')
    sidebar.resetSidebarLayout()
    expect(sidebar.getSidebarPrefs().layout).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })

  it('中英文历史、侧栏和图标搜索都定位到外观设置', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      setCurrentLocale(locale)
      for (const query of ['侧边栏', '历史', '最近任务', 'sidebar', 'history', 'recent']) {
        expect(
          searchSettings(query, s => s).some(
            e => e.section === 'appearance' && ['侧边栏', '显示最近任务'].includes(e.title),
          ),
        ).toBe(true)
      }
      for (const query of ['顶栏', '右上角', '不显示', '隐藏', 'toolbar', 'top bar', 'hidden']) {
        expect(searchSettings(query, s => s).some(e => e.section === 'appearance' && e.title === '图标位置')).toBe(true)
      }
      for (const query of ['图标', '自定义', '替换', 'icons', 'customize', 'reset']) {
        expect(searchSettings(query, s => s).some(e => e.section === 'appearance' && e.title === '图标位置')).toBe(true)
      }
    }
  })

  it('矮窗口默认收起最近任务，点过或保存为收起就按保存的', async () => {
    const { recentOpen, parseSidebarPrefs } = await import('./sidebar')
    const fresh = parseSidebarPrefs(null)
    expect(recentOpen(fresh, false)).toBe(true)
    expect(recentOpen(fresh, true)).toBe(false)
    expect(recentOpen({ recentExpanded: false }, false)).toBe(false)
    expect(recentOpen({ recentExpanded: true, recentChosen: true }, true)).toBe(true)
    expect(recentOpen({ recentExpanded: false, recentChosen: true }, false)).toBe(false)
  })

  it('recentChosen 只认 boolean，默认不写', async () => {
    const { parseSidebarPrefs } = await import('./sidebar')
    expect(parseSidebarPrefs(null).recentChosen).toBeUndefined()
    expect(parseSidebarPrefs({ version: 4, recentChosen: true }).recentChosen).toBe(true)
    expect(parseSidebarPrefs({ version: 4, recentChosen: 'yes' }).recentChosen).toBeUndefined()
  })
})
