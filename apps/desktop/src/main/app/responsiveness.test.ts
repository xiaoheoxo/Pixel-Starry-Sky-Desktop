// 卡顿诊断（docs/ui/logging.md §4.9）
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Session } from 'electron'

const mocks = vi.hoisted(() => ({
  metrics: [] as {
    pid: number
    type: string
    name?: string
    memory: { workingSetSize: number; privateBytes?: number }
  }[],
  lines: [] as { level: string; message: string; fields?: Record<string, unknown> }[],
  flushSync: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getAppMetrics: () => mocks.metrics, commandLine: { appendSwitch: vi.fn() } },
  powerMonitor: { on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}))
vi.mock('@pixelsky/engine', () => ({
  logger: () => {
    const write = (level: string) => (message: string, fields?: Record<string, unknown>) =>
      mocks.lines.push({ level, message, fields })
    return {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      enabled: () => true,
    }
  },
}))
vi.mock('./logging', () => ({ logService: () => ({ flushSync: mocks.flushSync }) }))

import {
  allowCallStacks,
  mainLag,
  memoryLevel,
  remoteMemoryChecker,
  stallFields,
  trimStack,
  watchMemory,
  watchRemoteMemory,
  watchWindow,
} from './responsiveness'

const KB = 1024

beforeEach(() => {
  mocks.lines.length = 0
  mocks.metrics.length = 0
  mocks.flushSync.mockClear()
})
afterEach(() => vi.useRealTimers())

function fakeWindow(
  stack: string | undefined = '\n    at spin (file:///app/index.js:2:58)\n    at render (file:///app/index.js:9:1)',
) {
  const win = Object.assign(new EventEmitter(), {
    id: 3,
    isDestroyed: () => false,
    isFocused: () => true,
    isMinimized: () => false,
    isVisible: () => true,
    webContents: {
      getOSProcessId: () => 42,
      mainFrame: { collectJavaScriptCallStack: vi.fn(() => Promise.resolve(stack)) },
    },
  })
  return win
}

describe('窗口没有响应', () => {
  it('记下离切回窗口多久、页面进程的内存和正在跑的调用栈，马上写盘；恢复时记卡了多久', async () => {
    mocks.metrics.push({ pid: 42, type: 'Tab', memory: { workingSetSize: 2_500 * KB, privateBytes: 2_000 * KB } })
    const win = fakeWindow()
    watchWindow(win as unknown as BrowserWindow)
    win.emit('blur')
    win.emit('focus')
    win.emit('unresponsive')
    await vi.waitFor(() => expect(mocks.lines).toHaveLength(1))
    const [entry] = mocks.lines
    expect(entry).toMatchObject({
      level: 'warn',
      message: '窗口没有响应',
      fields: {
        window: 3,
        focused: true,
        minimized: false,
        visible: true,
        memory: { workingSetMb: 2500, privateMb: 2000 },
        stack: 'at spin (file:///app/index.js:2:58)\n    at render (file:///app/index.js:9:1)',
      },
    })
    expect(entry.fields!.sinceFocusMs).toBeGreaterThanOrEqual(0)
    expect(entry.fields!.sinceRestoreMs).toBeNull()
    expect(mocks.flushSync).toHaveBeenCalledTimes(1)

    // 已经在「没响应」里，重复的事件不再记
    win.emit('unresponsive')
    win.emit('responsive')
    expect(mocks.lines).toHaveLength(2)
    expect(mocks.lines[1]).toMatchObject({ level: 'info', message: '窗口恢复响应', fields: { window: 3 } })
    win.emit('responsive')
    expect(mocks.lines).toHaveLength(2)
  })

  it('一直没响应：每 30 秒再记一次，最多 10 次；拿不到调用栈时不带 stack', async () => {
    vi.useFakeTimers()
    const win = fakeWindow('')
    watchWindow(win as unknown as BrowserWindow)
    win.emit('unresponsive')
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.lines.map(l => l.message)).toEqual(['窗口没有响应'])
    expect(mocks.lines[0].fields).not.toHaveProperty('stack')
    await vi.advanceTimersByTimeAsync(30_000 * 12)
    expect(mocks.lines.filter(l => l.message === '窗口仍然没有响应')).toHaveLength(10)
    win.emit('closed')
  })
})

describe('取调用栈的准备', () => {
  it('只给应用自己的顶层页面加 Document-Policy 响应头', () => {
    let listener!: (details: unknown, callback: (r: unknown) => void) => void
    const session = { webRequest: { onHeadersReceived: (fn: typeof listener) => (listener = fn) } }
    allowCallStacks(session as unknown as Session, url => url.startsWith('file:'))
    const run = (details: object) => {
      let result: unknown
      listener({ responseHeaders: { a: ['1'] }, ...details }, r => (result = r))
      return result
    }
    expect(run({ resourceType: 'mainFrame', url: 'file:///app/index.html' })).toEqual({
      responseHeaders: { a: ['1'], 'Document-Policy': ['include-js-call-stacks-in-crash-reports'] },
    })
    expect(run({ resourceType: 'script', url: 'file:///app/index.js' })).toEqual({})
    expect(run({ resourceType: 'mainFrame', url: 'https://example.com/' })).toEqual({})
  })

  it('调用栈去掉首尾空白、最多 25 行；空的当没有', () => {
    expect(trimStack(undefined)).toBeNull()
    expect(trimStack('  \n ')).toBeNull()
    const long = Array.from({ length: 40 }, (_, i) => `    at f${i} (x.js:1:1)`).join('\n')
    expect(trimStack(long)!.split('\n')).toHaveLength(25)
  })
})

describe('主进程卡住', () => {
  it('计时器晚到 2 秒以上才算；睡眠刚醒的不算', () => {
    expect(mainLag(1_999, false)).toBeNull()
    expect(mainLag(2_400.4, false)).toBe(2400)
    expect(mainLag(60_000, true)).toBeNull()
  })

  it('日志带上没处理完的请求、最近结束的请求和引擎运行时数量', async () => {
    const { track } = await import('../ipc/guard')
    track('engine:openSession', () => ({ items: [1, 2, 3] }))
    let finish!: (v: unknown) => void
    void track('mobile:engine:sessions', () => new Promise(r => (finish = r)))
    const fields = stallFields(2_900, () => ({ runtimes: 12, processes: 3, running: 1 }))
    expect(fields).toMatchObject({
      lagMs: 2_900,
      ipc: [{ channel: 'mobile:engine:sessions' }],
      recent: [{ channel: 'engine:openSession', size: 'items:3' }],
      engine: { runtimes: 12, processes: 3, running: 1 },
    })
    finish([])
    // 引擎还没加载 / 取数出错：不带 engine，也不影响这条日志
    expect(stallFields(2_100, () => null)).not.toHaveProperty('engine')
    expect(
      stallFields(2_100, () => {
        throw new Error('x')
      }),
    ).not.toHaveProperty('engine')
    expect(stallFields(2_100)).not.toHaveProperty('engine')
  })
})

describe('内存占用高', () => {
  it('1.5 GB 起记，每再涨 512 MB 记一次；回落到 1 GB 以下重新开始', async () => {
    expect([1_000, 1_536, 2_047, 2_048, 3_000].map(memoryLevel)).toEqual([0, 1, 1, 2, 3])
    vi.useFakeTimers()
    watchMemory()
    const tick = async (mbNow: number) => {
      mocks.metrics.splice(0, mocks.metrics.length, { pid: 7, type: 'Tab', memory: { workingSetSize: mbNow * KB } })
      await vi.advanceTimersByTimeAsync(60_000)
    }
    for (const value of [1_200, 1_600, 1_700, 2_100, 1_600, 2_100, 900, 1_600]) await tick(value)
    expect(mocks.lines.map(l => l.fields!.workingSetMb)).toEqual([1_600, 2_100, 1_600])
    expect(mocks.lines[0]).toMatchObject({ level: 'warn', message: '内存占用高', fields: { type: 'Tab', pid: 7 } })
  })
})

describe('WSL 内存占用高', () => {
  const warn = vi.fn()
  beforeEach(() => warn.mockClear())

  it('分档只记一次，带 machine 和 processes；降下来清档，断开也清档，stats 失败保留档位', () => {
    const check = remoteMemoryChecker({ warn })
    const at = (rssMb: number) => [{ id: 'wsl-a', rssMb, processes: 3 }]
    check(at(1_000))
    check(at(1_600))
    check(at(1_700))
    check(at(2_100))
    expect(warn.mock.calls.map(c => c[1])).toEqual([
      { machine: 'wsl-a', rssMb: 1_600, processes: 3 },
      { machine: 'wsl-a', rssMb: 2_100, processes: 3 },
    ])
    check([], ['wsl-a']) // 仍连着但没取到
    check(at(2_100))
    expect(warn).toHaveBeenCalledTimes(2)
    check([]) // 断开
    check(at(2_100))
    expect(warn).toHaveBeenCalledTimes(3)
    check(at(900))
    check(at(1_600))
    expect(warn).toHaveBeenCalledTimes(4)
  })

  it('只问已连接的 WSL；上一轮没回来就跳过，5 秒超时', async () => {
    vi.useFakeTimers()
    const stats = vi.fn((id: string) =>
      id === 'wsl-slow' ? new Promise<null>(() => {}) : Promise.resolve({ rssMb: 1_600, processes: 2 }),
    )
    const machines = {
      state: () => ({
        machines: [
          { id: 'local', kind: 'local', status: 'local' },
          { id: 'ssh-1', kind: 'ssh', status: 'connected' },
          { id: 'wsl-off', kind: 'wsl', status: 'disconnected' },
          { id: 'wsl-ok', kind: 'wsl', status: 'connected' },
          { id: 'wsl-slow', kind: 'wsl', status: 'connected' },
        ],
      }),
      stats,
    }
    watchRemoteMemory(() => machines, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(stats.mock.calls.map(c => c[0])).toEqual(['wsl-ok', 'wsl-slow'])
    await vi.advanceTimersByTimeAsync(3_000) // 慢的还没超时，跳过
    expect(stats).toHaveBeenCalledTimes(2)
    expect(mocks.lines).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2_000) // 5 秒超时，这一轮收尾
    expect(mocks.lines.map(l => l.fields)).toEqual([{ machine: 'wsl-ok', rssMb: 1_600, processes: 2 }])
    await vi.advanceTimersByTimeAsync(2_000) // 下一轮继续
    expect(stats).toHaveBeenCalledTimes(4)
  })
})
