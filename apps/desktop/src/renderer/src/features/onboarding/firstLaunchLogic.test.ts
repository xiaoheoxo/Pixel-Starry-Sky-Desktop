// 第一次打开的欢迎页：什么时候出现、显示哪一步（docs/ui/first-launch-login-mockup.html）
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineInfo } from '@pixelsky/protocol'
import {
  LOGIN_WAIT_MS,
  decideFirstLaunch,
  finishFirstLaunch,
  firstLaunchDone,
  firstLaunchView,
  foundEngines,
  loginRemaining,
  skyPixels,
} from './firstLaunchLogic'

const base = { demo: false, done: false, engineReady: true, projects: 0, sessions: 0, account: 'signed-out' as const }

describe('decideFirstLaunch', () => {
  it('全新安装：没看过、没项目没会话、没登录才显示', () => {
    expect(decideFirstLaunch(base)).toBe('show')
  })
  it('演示模式、看过的不显示', () => {
    expect(decideFirstLaunch({ ...base, demo: true })).toBe('skip')
    expect(decideFirstLaunch({ ...base, done: true })).toBe('skip')
  })
  it('引擎数据和账号状态都拿到之前先等，不闪一下', () => {
    expect(decideFirstLaunch({ ...base, engineReady: false })).toBe('wait')
    expect(decideFirstLaunch({ ...base, account: 'loading' })).toBe('wait')
  })
  it('用过的（旧版本升级上来）不再打扰：有项目、有会话、已登录或正在登录', () => {
    expect(decideFirstLaunch({ ...base, projects: 1 })).toBe('skip')
    expect(decideFirstLaunch({ ...base, sessions: 3 })).toBe('skip')
    expect(decideFirstLaunch({ ...base, account: 'signed-in' })).toBe('skip')
    expect(decideFirstLaunch({ ...base, account: 'signing-in' })).toBe('skip')
  })
})

describe('firstLaunchView', () => {
  it('按账号状态走；没成功的提示只在这一页点过登录之后出现', () => {
    expect(firstLaunchView('signed-out', null, false)).toBe('welcome')
    expect(firstLaunchView('signing-in', null, true)).toBe('waiting')
    expect(firstLaunchView('signed-in', null, true)).toBe('success')
    expect(firstLaunchView('signed-out', 'timeout', true)).toBe('error')
    // 上一次（比如别处）失败留下的原因，在这页还没点登录时不显示
    expect(firstLaunchView('signed-out', 'network', false)).toBe('welcome')
    // 主动「返回」取消登录：没有原因，回到第一步
    expect(firstLaunchView('signed-out', null, true)).toBe('welcome')
  })
})

describe('foundEngines', () => {
  const engine = (id: string, status: string) => ({ id, status }) as unknown as EngineInfo
  it('检测结果还没回来：checked 为 false', () => {
    expect(foundEngines([])).toEqual({ checked: false, found: [] })
    expect(foundEngines([engine('pixel', 'ready')])).toEqual({ checked: false, found: [] })
  })
  it('装了就算找到（没登录、版本旧也算）；没装、不支持的不算', () => {
    expect(
      foundEngines([engine('claude', 'unauthenticated'), engine('codex', 'missing'), engine('pixel', 'ready')]),
    ).toEqual({ checked: true, found: ['Claude Code'] })
    expect(foundEngines([engine('claude', 'missing'), engine('codex', 'unsupported')])).toEqual({
      checked: true,
      found: [],
    })
  })
})

describe('loginRemaining', () => {
  it('从 5:00 倒数，到点后停在 0:00', () => {
    expect(loginRemaining(0, 0)).toEqual({ ms: LOGIN_WAIT_MS, text: '5:00' })
    expect(loginRemaining(0, 8_500)).toMatchObject({ text: '4:52' })
    expect(loginRemaining(0, LOGIN_WAIT_MS + 1000)).toEqual({ ms: 0, text: '0:00' })
  })
})

describe('看过的记录', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('记下后不再显示；存储读不到时按看过算', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    expect(firstLaunchDone()).toBe(false)
    finishFirstLaunch()
    expect(firstLaunchDone()).toBe(true)
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    expect(firstLaunchDone()).toBe(true)
  })
})

it('星点位置固定（每次打开一样）', () => {
  expect(skyPixels()).toEqual(skyPixels())
  expect(skyPixels()).toHaveLength(30)
})
