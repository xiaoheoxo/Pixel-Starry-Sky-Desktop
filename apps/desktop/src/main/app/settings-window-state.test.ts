import { describe, expect, it } from 'vitest'
import {
  SETTINGS_DEFAULT,
  SETTINGS_MIN,
  parseMainWindowAction,
  parseSettingsHints,
  parseSettingsTarget,
  parseSettingsWindowPrefs,
  parseSettingsWorkspace,
  placeBeside,
  resolveSettingsBounds,
  settingsWindowTitle,
} from './settings-window-state'
import type { Rect } from './window-bounds'

const primary: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const left: Rect = { x: -1920, y: 0, width: 1920, height: 1040 }
const main: Rect = { x: 100, y: 80, width: 1000, height: 800 }

describe('parseSettingsWindowPrefs', () => {
  it('没存过：没有位置、置顶默认开、默认用浮层', () => {
    expect(parseSettingsWindowPrefs(undefined)).toEqual({ bounds: null, pinned: true, preferWindow: false })
    expect(parseSettingsWindowPrefs('坏文件')).toEqual({ bounds: null, pinned: true, preferWindow: false })
  })
  it('读出位置（去掉最大化标记）、置顶、记住的打开方式；字段不对的忽略', () => {
    expect(
      parseSettingsWindowPrefs({
        bounds: { x: 10.4, y: 20, width: 900, height: 600, maximized: true },
        pinned: false,
        preferWindow: true,
      }),
    ).toEqual({ bounds: { x: 10, y: 20, width: 900, height: 600 }, pinned: false, preferWindow: true })
    expect(
      parseSettingsWindowPrefs({ bounds: { x: 1, y: 2, width: 0, height: 5 }, pinned: 'yes', preferWindow: 1 }),
    ).toEqual({
      bounds: null,
      pinned: true,
      preferWindow: false,
    })
  })
})

describe('placeBeside：第一次放在主窗口右边', () => {
  it('右边放得下：紧贴主窗口右缘、顶端对齐', () => {
    const wide: Rect = { x: 0, y: 0, width: 2560, height: 1400 }
    expect(placeBeside(main, wide, SETTINGS_DEFAULT)).toEqual({ x: 1100, y: 80, ...SETTINGS_DEFAULT })
  })
  it('右边放不下：靠屏幕右缘，和主窗口重叠一部分', () => {
    expect(placeBeside(main, primary, SETTINGS_DEFAULT)).toEqual({ x: 1920 - 960, y: 80, ...SETTINGS_DEFAULT })
  })
  it('纵向放不下：往上挪到完全在屏幕内', () => {
    const low: Rect = { x: 100, y: 700, width: 1000, height: 300 }
    expect(placeBeside(low, primary, SETTINGS_DEFAULT).y).toBe(1040 - 700)
  })
  it('屏幕比默认尺寸小：尺寸收进屏幕', () => {
    const small: Rect = { x: 0, y: 0, width: 800, height: 600 }
    expect(placeBeside(main, small, SETTINGS_DEFAULT)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })
  it('没有主窗口：居中', () => {
    expect(placeBeside(null, primary, SETTINGS_DEFAULT)).toEqual({ x: 480, y: 170, ...SETTINGS_DEFAULT })
  })
})

describe('resolveSettingsBounds', () => {
  const run = (saved: Rect | null, displays: Rect[] = [primary], m: Rect | null = main) =>
    resolveSettingsBounds({ saved, displays, primary, main: m })

  it('没存过：放到主窗口右边（默认尺寸）', () => {
    expect(run(null)).toEqual({ x: 960, y: 80, ...SETTINGS_DEFAULT })
  })
  it('存过且在屏幕内：原样沿用', () => {
    const saved = { x: 300, y: 200, width: 900, height: 640 }
    expect(run(saved)).toEqual(saved)
  })
  it('在主屏左边的显示器上（负坐标）：沿用', () => {
    const saved = { x: -1500, y: 100, width: 900, height: 640 }
    expect(run(saved, [left, primary])).toEqual(saved)
  })
  it('上次的显示器拔掉了：回到主窗口旁边，尺寸沿用存的', () => {
    const saved = { x: -1500, y: 100, width: 900, height: 640 }
    expect(run(saved, [primary])).toEqual({ x: 1020, y: 80, width: 900, height: 640 })
  })
  it('只露出一小条（小于 160×80）：当作不在屏幕上', () => {
    const saved = { x: 1900, y: 100, width: 900, height: 640 }
    expect(run(saved)).toEqual({ x: 1020, y: 80, width: 900, height: 640 })
  })
  it('一部分在屏幕外：整体挪回屏幕内', () => {
    const saved = { x: 1500, y: 900, width: 900, height: 640 }
    expect(run(saved)).toEqual({ x: 1020, y: 400, width: 900, height: 640 })
  })
  it('比最小尺寸小的存档：放大到 720×520', () => {
    const r = run({ x: 100, y: 100, width: 300, height: 200 })
    expect(r.width).toBe(SETTINGS_MIN.width)
    expect(r.height).toBe(SETTINGS_MIN.height)
  })
  it('比屏幕还大：收进屏幕', () => {
    expect(run({ x: 0, y: 0, width: 5000, height: 3000 })).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })
  it('主窗口在副屏上：放在副屏上它的右边（放不下靠副屏右缘）', () => {
    const right: Rect = { x: 1920, y: 0, width: 1920, height: 1040 }
    const onRight: Rect = { x: 2000, y: 50, width: 1500, height: 900 }
    const r = run(null, [primary, right], onRight)
    expect(r).toEqual({ x: 3840 - 960, y: 50, ...SETTINGS_DEFAULT })
  })
  it('没有主窗口也没存过：居中在主屏', () => {
    expect(run(null, [primary], null)).toEqual({ x: 480, y: 170, ...SETTINGS_DEFAULT })
  })
})

describe('界面传来的参数', () => {
  it('parseSettingsTarget：分区名只收小写字母，行标题限长，其余丢掉', () => {
    expect(parseSettingsTarget('models', '额度按钮设置')).toEqual({ section: 'models', row: '额度按钮设置' })
    expect(parseSettingsTarget('../x', '')).toEqual({})
    expect(parseSettingsTarget(1, 'a'.repeat(201))).toEqual({})
    expect(parseSettingsTarget(undefined, undefined)).toEqual({})
  })
  it('parseSettingsHints：只收认得的字段并检查类型', () => {
    expect(
      parseSettingsHints({
        modelsScroll: true,
        extTab: 'discover',
        extSearch: true,
        engineDetail: 'claude',
        logFocus: { sessionId: 's1', since: 5 },
        feedback: { threadId: 't1' },
        evil: 1,
      }),
    ).toEqual({
      modelsScroll: true,
      extTab: 'discover',
      extSearch: true,
      engineDetail: 'claude',
      logFocus: { sessionId: 's1', since: 5 },
      feedback: { threadId: 't1' },
    })
    expect(
      parseSettingsHints({ modelsScroll: 1, extTab: 'x', engineDetail: '../a', logFocus: { sessionId: 1 } }),
    ).toBeUndefined()
    expect(parseSettingsHints({ feedback: ['a'] })).toBeUndefined()
    expect(parseSettingsHints({ feedback: { text: 'x'.repeat(100_001) } })).toBeUndefined()
    expect(parseSettingsHints(null)).toBeUndefined()
  })
  it('parseSettingsTarget 带上 hints', () => {
    expect(parseSettingsTarget('logs', undefined, { logFocus: { sessionId: 's', since: 1 } })).toEqual({
      section: 'logs',
      hints: { logFocus: { sessionId: 's', since: 1 } },
    })
  })
  it('parseMainWindowAction：只收固定的几种并检查参数', () => {
    expect(parseMainWindowAction({ kind: 'manageMachines' })).toEqual({ kind: 'manageMachines' })
    expect(parseMainWindowAction({ kind: 'selectLocalMachine', x: 1 })).toEqual({ kind: 'selectLocalMachine' })
    expect(parseMainWindowAction({ kind: 'openSession', sessionId: 's1' })).toEqual({
      kind: 'openSession',
      sessionId: 's1',
    })
    expect(parseMainWindowAction({ kind: 'openSession', sessionId: '' })).toBeNull()
    expect(parseMainWindowAction({ kind: 'openResume', projectId: 'p', engine: 'codex' })).toEqual({
      kind: 'openResume',
      projectId: 'p',
      engine: 'codex',
    })
    expect(parseMainWindowAction({ kind: 'openResume', projectId: 'p', engine: 'pixel' })).toBeNull()
    expect(parseMainWindowAction({ kind: 'terminalScript', name: 'n', command: 'claude auth login' })).toEqual({
      kind: 'terminalScript',
      name: 'n',
      command: 'claude auth login',
    })
    expect(parseMainWindowAction({ kind: 'terminalScript', name: 'n', command: 'x'.repeat(2001) })).toBeNull()
    expect(parseMainWindowAction({ kind: 'rm -rf' })).toBeNull()
    expect(parseMainWindowAction('manageMachines')).toBeNull()
  })
  it('parseSettingsWorkspace：形状对才收，ref 缺失时是 null', () => {
    const ws = { ref: { projectId: 'p1', folder: 2 }, name: '项目', path: 'D:/x', key: 'k' }
    expect(parseSettingsWorkspace(ws)).toEqual(ws)
    expect(parseSettingsWorkspace({ ...ws, ref: { sessionId: 's1', folder: 99 } })).toEqual({
      ...ws,
      ref: { sessionId: 's1' },
    })
    expect(parseSettingsWorkspace({ ...ws, ref: null })).toEqual({ ...ws, ref: null })
    expect(parseSettingsWorkspace({ ...ws, name: 1 })).toBeNull()
    expect(parseSettingsWorkspace(undefined)).toBeNull()
  })
  it('窗口标题跟着界面语言', () => {
    expect(settingsWindowTitle('zh-CN')).toBe('设置 · 像素星空')
    expect(settingsWindowTitle('en-US')).toBe('Settings · Pixel Starry Sky')
  })
})
