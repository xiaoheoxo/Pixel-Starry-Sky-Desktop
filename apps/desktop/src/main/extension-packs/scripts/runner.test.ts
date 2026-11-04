import { describe, expect, it, vi } from 'vitest'
import vm from 'node:vm'
import { checkCall, ScriptCallError, SCRIPT_LIMITS } from './api'
import { runScriptCommand, SCRIPT_TIMING, type RunnerDeps, type ScriptPort } from './runner'
import { userScript, WORKER_JS } from './source'

class FakePort implements ScriptPort {
  sent: Array<Record<string, unknown>> = []
  private message: ((e: { data: unknown }) => void) | null = null
  private closed: (() => void) | null = null
  postMessage(m: unknown): void {
    this.sent.push(m as Record<string, unknown>)
  }
  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.message = listener
    else this.closed = listener
  }
  start(): void {}
  emit(data: unknown): void {
    this.message?.({ data })
  }
  close(): void {
    this.closed?.()
  }
}

const target = (granted: string[] = ['editor.read', 'editor.write', 'ui.notify', 'storage']) => ({
  key: 'k',
  id: 'a.b',
  commandId: 'cmd',
  granted,
  code: '',
})

function setup(granted?: string[], over: Partial<RunnerDeps> = {}) {
  const port = new FakePort()
  const stop = vi.fn()
  const finished = vi.fn()
  const viaWindow = vi.fn(async (): Promise<unknown> => 'from-window')
  const storage = { get: vi.fn(() => 'stored'), set: vi.fn(), delete: vi.fn() }
  let memory = (): void => undefined
  const run = runScriptCommand(target(granted), {
    open: async (_t, onMemoryLimit) => {
      memory = onMemoryLimit
      return { port, stop }
    },
    viaWindow,
    finished,
    storage,
    ...over,
  })
  return { run, port, stop, finished, viaWindow, storage, memory: () => memory() }
}
const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('运行一次命令', () => {
  it('ready 后发 run，done 后结束并停掉 Worker', async () => {
    const t = setup()
    await tick()
    t.port.emit({ t: 'ready' })
    expect(t.port.sent).toEqual([{ t: 'run', id: 'cmd' }])
    t.port.emit({ t: 'done', ok: true })
    await expect(t.run.done).resolves.toEqual({ status: 'done' })
    expect(t.stop).toHaveBeenCalledOnce()
    expect(t.finished).toHaveBeenCalledOnce()
  })
  it('起不来：加载阶段报错、超时都算 loadFailed；命令里抛错算 thrown', async () => {
    const a = setup()
    await tick()
    a.port.emit({ t: 'fail', message: 'boom' })
    await expect(a.run.done).resolves.toEqual({ status: 'failed', code: 'loadFailed', detail: 'boom' })

    vi.useFakeTimers()
    try {
      const b = setup()
      await vi.advanceTimersByTimeAsync(SCRIPT_TIMING.startMs + 1)
      await expect(b.run.done).resolves.toMatchObject({ code: 'loadFailed' })
    } finally {
      vi.useRealTimers()
    }

    const c = setup()
    await tick()
    c.port.emit({ t: 'ready' })
    c.port.emit({ t: 'done', ok: false, message: 'x' })
    await expect(c.run.done).resolves.toEqual({ status: 'failed', code: 'thrown', detail: 'x' })
  })
  it('超过时间被停掉；等用户回答时暂停，但总时长有上限', async () => {
    vi.useFakeTimers()
    try {
      const a = setup()
      await vi.advanceTimersByTimeAsync(0)
      a.port.emit({ t: 'ready' })
      await vi.advanceTimersByTimeAsync(SCRIPT_TIMING.commandMs + 1)
      await expect(a.run.done).resolves.toMatchObject({ code: 'timeout' })
      expect(a.stop).toHaveBeenCalled()

      let answer: (v: unknown) => void = () => undefined
      const b = setup(undefined, { viaWindow: () => new Promise(r => (answer = r)) })
      await vi.advanceTimersByTimeAsync(0)
      b.port.emit({ t: 'ready' })
      b.port.emit({ t: 'call', seq: 1, method: 'ui.input', args: [{}] })
      await vi.advanceTimersByTimeAsync(SCRIPT_TIMING.commandMs * 3)
      answer('typed')
      await vi.advanceTimersByTimeAsync(0)
      expect(b.port.sent.at(-1)).toEqual({ t: 'reply', seq: 1, ok: true, value: 'typed' })
      // 恢复计时后还能跑完
      b.port.emit({ t: 'done', ok: true })
      await expect(b.run.done).resolves.toEqual({ status: 'done' })

      const c = setup(undefined, { viaWindow: () => new Promise(() => undefined) })
      await vi.advanceTimersByTimeAsync(0)
      c.port.emit({ t: 'ready' })
      c.port.emit({ t: 'call', seq: 1, method: 'ui.pick', args: [['a']] })
      await vi.advanceTimersByTimeAsync(SCRIPT_TIMING.totalMs + 1)
      await expect(c.run.done).resolves.toMatchObject({ code: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })
  it('进程崩了（端口关闭）、超内存都结束这次运行', async () => {
    const a = setup()
    await tick()
    a.port.close()
    await expect(a.run.done).resolves.toMatchObject({ code: 'crashed' })
    const b = setup()
    await tick()
    b.memory()
    await expect(b.run.done).resolves.toMatchObject({ code: 'memory' })
  })
})

describe('脚本的调用', () => {
  const started = async (granted?: string[], over?: Partial<RunnerDeps>) => {
    const t = setup(granted, over)
    await tick()
    t.port.emit({ t: 'ready' })
    return t
  }
  it('有权限：转给窗口或存储，结果回给脚本', async () => {
    const t = await started()
    t.port.emit({ t: 'call', seq: 1, method: 'editor.getText', args: [] })
    await tick()
    expect(t.viaWindow).toHaveBeenCalledWith('editor.getText', [])
    expect(t.port.sent.at(-1)).toEqual({ t: 'reply', seq: 1, ok: true, value: 'from-window' })
    t.port.emit({ t: 'call', seq: 2, method: 'storage.get', args: ['x'] })
    await tick()
    expect(t.storage.get).toHaveBeenCalledWith('a.b', 'x')
    expect(t.port.sent.at(-1)).toEqual({ t: 'reply', seq: 2, ok: true, value: 'stored' })
  })
  it('没权限：不转发，报错给脚本，命令不算崩', async () => {
    const t = await started(['ui.notify'])
    t.port.emit({ t: 'call', seq: 1, method: 'editor.getText', args: [] })
    await tick()
    expect(t.viaWindow).not.toHaveBeenCalled()
    expect(t.port.sent.at(-1)).toEqual({ t: 'reply', seq: 1, ok: false, message: 'permission required: editor.read' })
  })
  it('不认识的方法、不认识的消息：直接停掉', async () => {
    const a = await started()
    a.port.emit({ t: 'call', seq: 1, method: 'fs.read', args: [] })
    await expect(a.run.done).resolves.toMatchObject({ code: 'badCall' })
    const b = await started()
    b.port.emit({ t: 'hack' })
    await expect(b.run.done).resolves.toMatchObject({ code: 'badCall' })
  })
  it('调用次数和提示条数有上限', async () => {
    const a = await started()
    for (let i = 0; i <= SCRIPT_LIMITS.calls; i++)
      a.port.emit({ t: 'call', seq: i, method: 'storage.get', args: ['x'] })
    await expect(a.run.done).resolves.toMatchObject({ code: 'badCall' })
    const d = await started()
    for (let i = 0; i <= SCRIPT_LIMITS.dialogs; i++) d.port.emit({ t: 'call', seq: i, method: 'ui.input', args: [{}] })
    await tick()
    expect(d.viaWindow).toHaveBeenCalledTimes(SCRIPT_LIMITS.dialogs)
    expect(d.port.sent.some(m => m.message === 'too many dialogs')).toBe(true)
    const w = await started()
    const big = 'x'.repeat(SCRIPT_LIMITS.text)
    for (let i = 0; i <= SCRIPT_LIMITS.written / SCRIPT_LIMITS.text; i++)
      w.port.emit({ t: 'call', seq: i, method: 'editor.replaceRange', args: [0, 0, big] })
    await tick()
    expect(w.viaWindow).toHaveBeenCalledTimes(SCRIPT_LIMITS.written / SCRIPT_LIMITS.text)
    expect(w.port.sent.some(m => m.message === 'too much text written')).toBe(true)
    const s = await started()
    for (let i = 0; i <= SCRIPT_LIMITS.storageCalls; i++)
      s.port.emit({ t: 'call', seq: i, method: 'storage.get', args: ['x'] })
    await tick()
    expect(s.storage.get).toHaveBeenCalledTimes(SCRIPT_LIMITS.storageCalls)
    expect(s.port.sent.some(m => m.message === 'too many storage calls')).toBe(true)
    const b = await started()
    for (let i = 0; i <= SCRIPT_LIMITS.messages; i++)
      b.port.emit({ t: 'call', seq: i, method: 'ui.showMessage', args: ['m'] })
    await tick()
    expect(b.viaWindow).toHaveBeenCalledTimes(SCRIPT_LIMITS.messages)
    expect(b.port.sent.some(m => m.message === 'too many messages')).toBe(true)
  })
  it('运行结束后再来的消息不处理', async () => {
    const t = await started()
    t.port.emit({ t: 'done', ok: true })
    await t.run.done
    t.port.emit({ t: 'call', seq: 1, method: 'editor.getText', args: [] })
    await tick()
    expect(t.viaWindow).not.toHaveBeenCalled()
  })
})

describe('checkCall', () => {
  const bad = (m: unknown, a: unknown): unknown => {
    try {
      checkCall(m, a)
      return null
    } catch (e) {
      return e
    }
  }
  it('参数不对报错；超大的文字直接算不合规', () => {
    expect(checkCall('editor.replaceRange', [1, 2, 'x'])).toMatchObject({
      permission: 'editor.write',
      args: [1, 2, 'x'],
    })
    expect(bad('editor.replaceRange', [2, 1, 'x'])).toBeInstanceOf(ScriptCallError)
    expect(bad('editor.replaceRange', [-1, 1, 'x'])).toBeInstanceOf(ScriptCallError)
    expect(bad('editor.replaceRange', [0, 0, 5])).toBeInstanceOf(ScriptCallError)
    expect(bad('editor.replaceRange', [0, 0, 'x'.repeat(SCRIPT_LIMITS.text + 1)])).toMatchObject({ fatal: true })
    expect(bad('ui.pick', [[]])).toBeInstanceOf(ScriptCallError)
    expect(bad('__proto__', [])).toMatchObject({ fatal: true })
    expect(bad('constructor', [])).toMatchObject({ fatal: true })
    expect(bad('editor.getText', 'x')).toMatchObject({ fatal: true })
  })
  it('等用户回答的、经窗口的分清楚', () => {
    expect(checkCall('ui.input', [{ title: 't' }])).toMatchObject({
      waitsForUser: true,
      viaWindow: true,
      args: ['t', ''],
    })
    expect(checkCall('storage.set', ['k', 'v'])).toMatchObject({ waitsForUser: false, viaWindow: false })
    expect(bad('storage.set', ['k', { a: 1 }])).toBeInstanceOf(ScriptCallError)
  })
})

describe('Worker 启动代码', () => {
  /** importScripts 和真的 Worker 一样：另起一个脚本同步运行 */
  const sandbox = (user: string, extra: Record<string, unknown> = {}) => {
    const context: Record<string, unknown> = {
      addEventListener: () => undefined,
      importScripts: () => vm.runInContext(userScript(user), context),
      setTimeout: () => 0,
      fetch: () => 'net',
      Blob: class {},
      indexedDB: {},
      OffscreenCanvas: class {},
      ...extra,
    }
    vm.createContext(context)
    return context
  }
  it('删掉白名单外的全局，留下语言内置和 pixelsky', () => {
    const ctx = sandbox(
      'this.__seen = [typeof fetch, typeof Blob, typeof indexedDB, typeof OffscreenCanvas, typeof addEventListener, typeof importScripts, typeof setTimeout, typeof WebAssembly, typeof pixelsky, typeof JSON, typeof Promise].join()',
    )
    vm.runInContext(WORKER_JS, ctx)
    expect(ctx.__seen).toBe(
      'undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,object,object,function',
    )
  })
  it('删不掉的不是已知常量：抛错，后面的用户脚本不运行', () => {
    const ctx = sandbox('this.__ran = true')
    Object.defineProperty(ctx, 'stubborn', { value: 1, configurable: false })
    expect(() => vm.runInContext(WORKER_JS, ctx)).toThrow(/sandbox setup failed: stubborn/)
    expect(ctx.__ran).toBeUndefined()
  })
  it('已知的两个常量删不掉没关系', () => {
    const ctx = sandbox('this.__ran = true')
    Object.defineProperty(ctx, 'TEMPORARY', { value: 0, configurable: false })
    Object.defineProperty(ctx, 'PERSISTENT', { value: 1, configurable: false })
    vm.runInContext(WORKER_JS, ctx)
    expect(ctx.__ran).toBe(true)
  })
  it('pixelsky 改不了；两个脚本都是严格模式', () => {
    expect(WORKER_JS.startsWith("'use strict';")).toBe(true)
    const ctx = sandbox(
      "this.__frozen = Object.isFrozen(pixelsky) && Object.isFrozen(pixelsky.editor) && !Reflect.deleteProperty(this, 'pixelsky'); this.__strict = (function () { return this === undefined })()",
    )
    vm.runInContext(WORKER_JS, ctx)
    expect(ctx.__frozen).toBe(true)
    expect(ctx.__strict).toBe(true)
  })
  it('用户顶层的 function、var 正常可用；同名内置对象不会在清理之前跑起来', () => {
    const ctx = sandbox(`
      function helper() { return 1 }
      var kept = 2
      function Set() { return null }
      function Reflect() { return null }
      this.__r = [helper(), kept, typeof Blob, typeof fetch].join()`)
    vm.runInContext(WORKER_JS, ctx)
    expect(ctx.__r).toBe('1,2,undefined,undefined')
  })
  it('启动脚本里没有用户代码', () => {
    expect(WORKER_JS).toContain("load('/user.js')")
    expect(userScript('MARK').startsWith("'use strict';")).toBe(true)
  })
})
