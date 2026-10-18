import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { IPC_CONTRACT, type IpcChannelSpec } from '@pixelsky/protocol'

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  fromWebContents: vi.fn(),
}))
vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  ipcMain: {
    handle: (name: string, fn: (event: unknown, ...args: unknown[]) => unknown) => mocks.handlers.set(name, fn),
    on: (name: string, fn: (event: unknown, ...args: unknown[]) => unknown) => mocks.listeners.set(name, fn),
  },
}))

type Guard = typeof import('./guard')
const contract = IPC_CONTRACT as Record<string, IpcChannelSpec>
let guard: Guard

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.listeners.clear()
  mocks.app.isPackaged = true
  delete process.env.ELECTRON_RENDERER_URL
  vi.resetModules()
  guard = await import('./guard')
})

// ---------------------------------------------------------------------------
// 调用现场：一个来源页面 + 它所在的框架和窗口
// ---------------------------------------------------------------------------

interface Scene {
  url?: string | null
  subframe?: boolean
  window?: 'owner' | 'none' | 'destroyed' | 'other'
}
function scene({ url = 'file:///app/index.html', subframe = false, window = 'owner' }: Scene = {}): IpcMainInvokeEvent &
  IpcMainEvent {
  const mainFrame = { url: url ?? '' }
  const sender = { mainFrame }
  const win = { webContents: sender, isDestroyed: () => window === 'destroyed' }
  mocks.fromWebContents.mockReturnValue(
    window === 'none' ? null : window === 'other' ? { ...win, webContents: {} } : win,
  )
  return {
    sender,
    senderFrame: url === null ? null : subframe ? { url } : mainFrame,
  } as unknown as IpcMainInvokeEvent & IpcMainEvent
}

// ---------------------------------------------------------------------------
// 档位 × 现场 → 结果。列：
//   none / sender / frame：契约里的三档；
//   strict：window 档，默认；
//   loose：window 档 + looseOwner（终端）；
//   closing：window 档 + looseOwner + noWindow（窗口控制）。
// ---------------------------------------------------------------------------

type Outcome = 'ok' | 'untrusted' | 'noWindow'
type Column = 'none' | 'sender' | 'frame' | 'strict' | 'loose' | 'closing'
const scenes: {
  name: string
  scene: () => IpcMainInvokeEvent & IpcMainEvent
  dev?: boolean
  expected: Record<Column, Outcome>
}[] = [
  {
    name: '应用自己的页面（本地文件）',
    scene: () => scene(),
    expected: { none: 'ok', sender: 'ok', frame: 'ok', strict: 'ok', loose: 'ok', closing: 'ok' },
  },
  {
    name: '外部网页',
    scene: () => scene({ url: 'https://example.com/index.html' }),
    expected: {
      none: 'ok',
      sender: 'untrusted',
      frame: 'untrusted',
      strict: 'untrusted',
      loose: 'untrusted',
      closing: 'untrusted',
    },
  },
  {
    name: '没有来源框架',
    scene: () => scene({ url: null }),
    expected: {
      none: 'ok',
      sender: 'untrusted',
      frame: 'untrusted',
      strict: 'untrusted',
      loose: 'untrusted',
      closing: 'untrusted',
    },
  },
  {
    name: '子框架（地址可信但不是主框架）',
    scene: () => scene({ subframe: true }),
    expected: {
      none: 'ok',
      sender: 'ok',
      frame: 'untrusted',
      strict: 'untrusted',
      loose: 'untrusted',
      closing: 'untrusted',
    },
  },
  {
    name: '调用方没有窗口',
    scene: () => scene({ window: 'none' }),
    expected: { none: 'ok', sender: 'ok', frame: 'ok', strict: 'untrusted', loose: 'untrusted', closing: 'noWindow' },
  },
  {
    name: '窗口已销毁',
    scene: () => scene({ window: 'destroyed' }),
    expected: { none: 'ok', sender: 'ok', frame: 'ok', strict: 'ok', loose: 'ok', closing: 'noWindow' },
  },
  {
    name: '窗口的 webContents 不是调用方（内嵌网页视图）',
    scene: () => scene({ window: 'other' }),
    expected: { none: 'ok', sender: 'ok', frame: 'ok', strict: 'untrusted', loose: 'ok', closing: 'ok' },
  },
]

/** 每一列用哪个真实通道、怎样的选项注册，以及未受信时抛的文案。 */
const columns: Record<
  Column,
  { channel: string; kind: 'handle' | 'on'; options?: Record<string, unknown>; deny?: string; noWindow?: string }
> = {
  none: { channel: 'theme:set', kind: 'on' },
  sender: { channel: 'platform:groups', kind: 'handle', deny: '不受信任的页面' },
  frame: { channel: 'ui:locale', kind: 'handle', options: { deny: '不允许的调用方' }, deny: '不允许的调用方' },
  strict: { channel: 'machines:workspaces', kind: 'handle', deny: '不受信任的页面' },
  loose: { channel: 'terminal:state', kind: 'handle', options: { looseOwner: true }, deny: '不受信任的页面' },
  closing: {
    channel: 'window:getState',
    kind: 'handle',
    options: { deny: '不允许的调用方', noWindow: '窗口已经关闭', looseOwner: true },
    deny: '不允许的调用方',
    noWindow: '窗口已经关闭',
  },
}

describe('信任校验：档位 × 调用现场', () => {
  for (const [column, def] of Object.entries(columns) as [Column, (typeof columns)[Column]][]) {
    describe(`${column}（${def.channel}）`, () => {
      for (const { name, scene: make, expected } of scenes) {
        it(`${name} → ${expected[column]}`, () => {
          const fn = vi.fn(() => 'ran')
          const event = make()
          if (def.kind === 'handle') {
            ;(guard.handle as (c: string, f: typeof fn, o?: object) => void)(def.channel, fn, def.options)
            const registered = mocks.handlers.get(def.channel)!
            if (expected[column] === 'ok') {
              expect(registered(event, 1, 2)).toBe('ran')
              expect(fn).toHaveBeenCalledWith(event, 1, 2)
            } else {
              const message = expected[column] === 'noWindow' ? def.noWindow : def.deny
              expect(() => registered(event, 1, 2)).toThrow(new Error(message))
              expect(fn).not.toHaveBeenCalled()
            }
          } else {
            ;(guard.on as (c: string, f: typeof fn, o?: object) => void)(def.channel, fn, def.options)
            mocks.listeners.get(def.channel)!(event, 1, 2)
            // on 通道没有「抛错」这一说：未受信的调用一律静默忽略
            expect(fn).toHaveBeenCalledTimes(expected[column] === 'ok' ? 1 : 0)
          }
        })
      }
    })
  }

  it('on 通道（窗口档，终端）：未受信静默忽略，受信才执行', () => {
    for (const channel of ['terminal:ack', 'terminal:focused'] as const) {
      const fn = vi.fn()
      guard.on(channel, fn, { looseOwner: true })
      const listener = mocks.listeners.get(channel)!
      listener(scene({ url: 'https://example.com/' }), 'k')
      listener(scene({ subframe: true }), 'k')
      listener(scene({ window: 'none' }), 'k')
      expect(fn).not.toHaveBeenCalled()
      listener(scene({ window: 'other' }), 'k')
      expect(fn).toHaveBeenCalledTimes(1)
    }
  })

  it('开发服务器页面：只有未打包且同源才受信', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/'
    guard.handle('platform:groups', () => 'ran')
    const handler = mocks.handlers.get('platform:groups')!
    mocks.app.isPackaged = false
    expect(handler(scene({ url: 'http://localhost:5173/index.html' }))).toBe('ran')
    expect(() => handler(scene({ url: 'http://localhost:5174/index.html' }))).toThrow('不受信任的页面')
    expect(() => handler(scene({ url: 'http://evil.example/' }))).toThrow('不受信任的页面')
    mocks.app.isPackaged = true
    expect(() => handler(scene({ url: 'http://localhost:5173/index.html' }))).toThrow('不受信任的页面')
  })

  it('没有设置开发服务器地址时，网页地址不受信', () => {
    guard.handle('platform:groups', () => 'ran')
    mocks.app.isPackaged = false
    expect(() => mocks.handlers.get('platform:groups')!(scene({ url: 'http://localhost:5173/' }))).toThrow(
      '不受信任的页面',
    )
  })
})

describe('逐通道的拒绝方式', () => {
  const foreign = (): IpcMainInvokeEvent => scene({ url: 'https://example.com/' })
  const call = (channel: string, ...args: unknown[]): unknown => mocks.handlers.get(channel)!(foreign(), ...args)

  it('account:get 返回未登录，其余 account 通道静默忽略', async () => {
    const fn = vi.fn()
    guard.handle('account:get', fn, { onUntrusted: () => ({ status: 'signed-out' }) })
    expect(call('account:get')).toEqual({ status: 'signed-out' })
    for (const channel of ['account:login', 'account:cancel', 'account:logout', 'account:refresh'] as const) {
      guard.handle(channel, fn, { onUntrusted: () => undefined })
      expect(call(channel)).toBeUndefined()
    }
    expect(fn).not.toHaveBeenCalled()
  })
  it('notify:supported 返回 false', () => {
    guard.handle('notify:supported', () => true, { onUntrusted: () => false })
    expect(call('notify:supported')).toBe(false)
  })
  it('platform:models 抛「无效的分组」', () => {
    guard.handle('platform:models', () => [], { deny: '无效的分组' })
    expect(() => call('platform:models', '1')).toThrow('无效的分组')
  })
  it('默认抛「不受信任的页面」', () => {
    guard.handle('engine:engines', () => [])
    expect(() => call('engine:engines')).toThrow('不受信任的页面')
  })
})

describe('注册', () => {
  it('同一个通道不能注册两次（handle 与 on 都检测）', () => {
    guard.handle('platform:groups', () => 1)
    expect(() => guard.handle('platform:groups', () => 2)).toThrow('IPC 通道重复注册：platform:groups')
    guard.on('theme:set', () => undefined)
    expect(() => guard.on('theme:set', () => undefined)).toThrow('IPC 通道重复注册：theme:set')
    expect(mocks.handlers.size).toBe(1)
    expect(mocks.listeners.size).toBe(1)
  })
  it('动态注册（artifacts:open / reveal）各自只注册一次', () => {
    for (const action of ['open', 'reveal'] as const) guard.handle(`artifacts:${action}`, () => action)
    expect([...mocks.handlers.keys()].sort()).toEqual(['artifacts:open', 'artifacts:reveal'])
    expect(() => guard.handle('artifacts:open', () => 1)).toThrow('重复注册')
  })
  it('通道必须在契约里，且类型对得上', () => {
    expect(() => guard.handle('nope:nothing' as never, () => 1)).toThrow('不在契约里')
    expect(() => guard.handle('toString' as never, () => 1)).toThrow('不在契约里')
    expect(() => guard.handle('theme:set' as never, () => 1)).toThrow('不能这样注册')
    expect(() => guard.on('platform:groups' as never, () => 1)).toThrow('不能这样注册')
    expect(() => guard.on('account:changed' as never, () => 1)).toThrow('不能这样注册')
    expect(mocks.handlers.size + mocks.listeners.size).toBe(0)
  })
  it('契约里每个 invoke / send 通道都能注册，档位取自契约', () => {
    for (const [channel, spec] of Object.entries(contract)) {
      if (spec.kind === 'invoke') guard.handle(channel as never, () => 'ran')
      else if (spec.kind !== 'push') guard.on(channel as never, () => undefined)
    }
    const invokes = Object.values(contract).filter(spec => spec.kind === 'invoke').length
    expect(mocks.handlers.size).toBe(invokes)
    // 不校验的档位只能是 on 通道或 push；所有 invoke 通道至少要验来源页面
    for (const [channel, spec] of Object.entries(contract))
      if (spec.kind === 'invoke') {
        expect(spec.trust, channel).not.toBe('none')
        expect(() => mocks.handlers.get(channel)!(scene({ url: 'https://example.com/' })), channel).toThrow()
      }
  })
})

describe('卡顿诊断（docs/ui/logging.md §4.9）', () => {
  async function sink() {
    const lines: { level: string; scope: string; message: string; fields?: Record<string, unknown> }[] = []
    const engine = await import('@pixelsky/engine')
    engine.setLogSink({
      enabled: () => true,
      write: (level, scope, message, fields) => lines.push({ level, scope, message, fields }),
    })
    return lines
  }

  it('没处理完的 invoke 请求列在 ipcInFlight 里，处理完（成功或失败）就去掉', async () => {
    let finish!: (v: string) => void
    guard.handle('platform:groups', () => new Promise<string>(r => (finish = r)))
    guard.handle('platform:models', () => Promise.reject(new Error('坏了')))
    const pending = mocks.handlers.get('platform:groups')!(scene()) as Promise<string>
    expect(guard.ipcInFlight().map(c => c.channel)).toEqual(['platform:groups'])
    await expect(mocks.handlers.get('platform:models')!(scene(), '1') as Promise<unknown>).rejects.toThrow('坏了')
    expect(guard.ipcInFlight().map(c => c.channel)).toEqual(['platform:groups'])
    finish('ok')
    await expect(pending).resolves.toBe('ok')
    expect(guard.ipcInFlight()).toEqual([])
  })

  it('处理函数同步部分超过 500 毫秒记一条 warn；快的不记', async () => {
    const lines = await sink()
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      guard.handle('platform:groups', () => {
        clock += 800
        return 'slow'
      })
      guard.on('log:write', () => {
        clock += 10
      })
      expect(mocks.handlers.get('platform:groups')!(scene())).toBe('slow')
      mocks.listeners.get('log:write')!(scene())
    } finally {
      now.mockRestore()
    }
    expect(lines).toEqual([
      {
        level: 'warn',
        scope: 'perf',
        message: 'IPC 处理占住了主进程',
        fields: { channel: 'platform:groups', ms: 800 },
      },
    ])
    expect(guard.ipcInFlight()).toEqual([])
  })

  describe('最近结束的请求', () => {
    function withClock<T>(run: (tick: (ms: number) => void) => T): T {
      let clock = 1_000
      const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
      try {
        return run(ms => (clock += ms))
      } finally {
        now.mockRestore()
      }
    }

    it('处理完的请求留 5 秒：通道、结束距今、耗时、回复的粗略大小；最近结束的在前', () => {
      withClock(tick => {
        guard.handle('platform:groups', () => {
          tick(30)
          return [1, 2, 3]
        })
        guard.handle('engine:openSession', () => {
          tick(120)
          return { snapshot: { items: new Array(500).fill(0) }, seq: 9 }
        })
        mocks.handlers.get('platform:groups')!(scene())
        tick(1_000)
        mocks.handlers.get('engine:openSession')!(scene(), 's1')
        tick(200)
        expect(guard.ipcRecent()).toEqual([
          { channel: 'engine:openSession', agoMs: 200, ms: 120, size: 'items:500' },
          { channel: 'platform:groups', agoMs: 1_320, ms: 30, size: 'len:3' },
        ])
        // 5 秒后掉出窗口；传了卡住时长就把窗口放宽
        tick(4_000)
        expect(guard.ipcRecent().map(r => r.channel)).toEqual(['engine:openSession'])
        expect(guard.ipcRecent(2_000).map(r => r.channel)).toEqual(['engine:openSession', 'platform:groups'])
      })
    })

    it('异步请求等 Promise 落定才算结束；失败的也记，没有大小', async () => {
      let finish!: (v: string) => void
      guard.handle('platform:groups', () => new Promise<string>(r => (finish = r)))
      guard.handle('platform:models', () => Promise.reject(new Error('坏了')))
      const pending = mocks.handlers.get('platform:groups')!(scene()) as Promise<string>
      expect(guard.ipcRecent()).toEqual([])
      await expect(mocks.handlers.get('platform:models')!(scene(), '1') as Promise<unknown>).rejects.toThrow('坏了')
      expect(guard.ipcRecent().map(r => [r.channel, r.size])).toEqual([['platform:models', undefined]])
      finish('x'.repeat(40))
      await pending
      expect(guard.ipcRecent().map(r => [r.channel, r.size])).toEqual([
        ['platform:groups', 'chars:40'],
        ['platform:models', undefined],
      ])
    })

    it('同步抛错的请求也记；高频通道最多留 256 条，列出来最多 20 条', () => {
      guard.handle('platform:groups', () => {
        throw new Error('同步坏了')
      })
      expect(() => mocks.handlers.get('platform:groups')!(scene())).toThrow('同步坏了')
      expect(guard.ipcRecent().map(r => r.channel)).toEqual(['platform:groups'])
      for (let i = 0; i < 300; i++) guard.track('hot', () => i)
      const listed = guard.ipcRecent()
      expect(listed).toHaveLength(20)
      expect(listed.every(r => r.channel === 'hot')).toBe(true)
    })

    it('卡住超过 5 秒、卡住期间又有请求处理完：卡住前刚结束的那条仍能在日志里看到', () => {
      withClock(tick => {
        guard.track('culprit', () => [1, 2, 3])
        // 主进程卡住 6 秒；排队的请求先于日志写入处理完，写入时不能把罪魁清掉
        tick(6_000)
        for (let i = 0; i < 3; i++) guard.track('queued', () => i)
        expect(guard.ipcRecent(6_000).map(r => r.channel)).toEqual(['queued', 'queued', 'queued', 'culprit'])
        // 不放宽时窗口只有 5 秒，罪魁不在（读取时过滤，不是写入时丢掉）
        expect(guard.ipcRecent().map(r => r.channel)).toEqual(['queued', 'queued', 'queued'])
      })
    })

    it('卡住期间排队的请求超过 20 条：卡住前最后结束的那条挤不掉', () => {
      withClock(tick => {
        guard.track('before', () => 0)
        guard.track('culprit', () => [1])
        tick(6_000)
        for (let i = 0; i < 40; i++) guard.track('queued', () => i)
        const listed = guard.ipcRecent(6_000)
        expect(listed).toHaveLength(20)
        expect(listed.at(-1)).toMatchObject({ channel: 'culprit', size: 'len:1' })
        expect(listed.slice(0, -1).every(r => r.channel === 'queued')).toBe(true)
      })
    })

    it('手机网关的调用（mobile: 前缀）同样计时并留痕，卡住时能在 ipcInFlight 里看到', async () => {
      let finish!: (v: unknown) => void
      const pending = guard.track('mobile:engine:openSession', () => new Promise(r => (finish = r)))
      expect(guard.ipcInFlight().map(c => c.channel)).toEqual(['mobile:engine:openSession'])
      finish({ items: [1, 2] })
      await pending
      expect(guard.ipcInFlight()).toEqual([])
      expect(guard.ipcRecent()).toMatchObject([{ channel: 'mobile:engine:openSession', size: 'items:2' }])
    })
  })

  describe('回复大小的估计', () => {
    it('只看顶层长度，不遍历也不序列化', () => {
      const toJSON = vi.fn()
      expect(guard.roughSize('abc')).toBe('chars:3')
      expect(guard.roughSize([1, 2])).toBe('len:2')
      expect(guard.roughSize(new Uint8Array(8))).toBe('bytes:8')
      expect(guard.roughSize({ items: [1, 2, 3] })).toBe('items:3')
      expect(guard.roughSize({ snapshot: { items: [1] }, seq: 1 })).toBe('items:1')
      expect(guard.roughSize({ toJSON, other: { deep: [1, 2, 3] } })).toBeUndefined()
      expect(toJSON).not.toHaveBeenCalled()
      expect(guard.roughSize(null)).toBeUndefined()
      expect(guard.roughSize(undefined)).toBeUndefined()
      expect(guard.roughSize(42)).toBeUndefined()
    })
  })
})
