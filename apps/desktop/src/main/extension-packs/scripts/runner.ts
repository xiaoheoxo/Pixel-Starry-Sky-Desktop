// 运行一次命令（docs/ui/extension-commands-plan.md §3、§4）：每次单独起 Worker，跑完就结束。这里不碰 electron，宿主从外面传进来
import type { ExtCommandFailure, ExtCommandOutcome } from '../../../shared/types/ext-commands'
import { checkCall, SCRIPT_LIMITS, ScriptCallError } from './api'

export const SCRIPT_TIMING = {
  /** 从建 Worker 到脚本加载完（语法错误走这里：Worker 起不来，没有别的信号） */
  startMs: 5_000,
  /** 单次命令；等用户回答时暂停 */
  commandMs: 10_000,
  /** 包括等用户回答的总时长 */
  totalMs: 5 * 60_000,
} as const

export interface ScriptPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (e: { data: unknown }) => void): void
  on(event: 'close', listener: () => void): void
  start(): void
}

export interface ScriptConnection {
  port: ScriptPort
  /** 结束这个扩展的 Worker */
  stop(): void
}

export interface ScriptRunTarget {
  /** 扩展 key：一次只跑一条 */
  key: string
  id: string
  commandId: string
  granted: readonly string[]
  /** 用户脚本的正文 */
  code: string
}

export interface RunnerDeps {
  /** 建 Worker，超内存时调 onMemoryLimit */
  open(target: ScriptRunTarget, onMemoryLimit: () => void): Promise<ScriptConnection>
  /** 经发起命令的窗口完成（编辑器、对话框）；窗口没了就 reject */
  viaWindow(method: string, args: unknown[]): Promise<unknown>
  /** 这次运行结束：关掉还开着的对话框 */
  finished(): void
  storage: {
    get(id: string, key: string): unknown
    set(id: string, key: string, value: unknown): void
    delete(id: string, key: string): void
  }
}

export function runScriptCommand(
  target: ScriptRunTarget,
  deps: RunnerDeps,
): { done: Promise<ExtCommandOutcome>; cancel(reason: ExtCommandFailure): void } {
  let finish!: (o: ExtCommandOutcome) => void
  const done = new Promise<ExtCommandOutcome>(r => (finish = r))
  let connection: ScriptConnection | null = null
  let settled = false
  let calls = 0
  let messages = 0
  let storageCalls = 0
  let dialogs = 0
  let written = 0
  let waiting = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let remaining: number = SCRIPT_TIMING.commandMs
  let armedAt = 0
  let phase: 'starting' | 'running' = 'starting'

  const end = (outcome: ExtCommandOutcome): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(total)
    connection?.stop()
    deps.finished()
    finish(outcome)
  }
  const fail = (code: ExtCommandFailure, detail?: string): void => end({ status: 'failed', code, detail })
  const arm = (ms: number): void => {
    clearTimeout(timer)
    armedAt = Date.now()
    remaining = ms
    timer = setTimeout(() => fail(phase === 'starting' ? 'loadFailed' : 'timeout'), ms)
  }
  const pause = (): void => {
    if (waiting++ > 0) return
    clearTimeout(timer)
    remaining = Math.max(0, remaining - (Date.now() - armedAt))
  }
  const resume = (): void => {
    if (--waiting === 0 && !settled) arm(remaining)
  }
  const total = setTimeout(() => fail('timeout'), SCRIPT_TIMING.totalMs)

  const reply = (seq: unknown, ok: boolean, payload: unknown): void => {
    if (settled) return
    try {
      connection?.port.postMessage(
        ok ? { t: 'reply', seq, ok, value: payload } : { t: 'reply', seq, ok, message: String(payload) },
      )
    } catch {
      fail('crashed')
    }
  }

  const handleCall = async (seq: unknown, method: unknown, args: unknown): Promise<void> => {
    if (++calls > SCRIPT_LIMITS.calls) return fail('badCall', 'too many calls')
    let waited = false
    try {
      const call = checkCall(method, args)
      if (!target.granted.includes(call.permission))
        throw new ScriptCallError(`permission required: ${call.permission}`)
      if (call.method === 'ui.showMessage' && ++messages > SCRIPT_LIMITS.messages)
        throw new ScriptCallError('too many messages')
      if (!call.viaWindow && ++storageCalls > SCRIPT_LIMITS.storageCalls)
        throw new ScriptCallError('too many storage calls')
      if (call.waitsForUser && ++dialogs > SCRIPT_LIMITS.dialogs) throw new ScriptCallError('too many dialogs')
      if (call.method === 'editor.replaceRange') {
        written += (call.args[2] as string).length
        if (written > SCRIPT_LIMITS.written) throw new ScriptCallError('too much text written')
      }
      if (call.waitsForUser) {
        waited = true
        pause()
      }
      let value: unknown
      if (call.viaWindow) value = await deps.viaWindow(call.method, call.args)
      else if (call.method === 'storage.get') value = deps.storage.get(target.id, call.args[0] as string)
      else if (call.method === 'storage.set') deps.storage.set(target.id, call.args[0] as string, call.args[1])
      else deps.storage.delete(target.id, call.args[0] as string)
      reply(seq, true, value)
    } catch (e) {
      if (e instanceof ScriptCallError && e.fatal) return fail('badCall', e.message)
      reply(seq, false, e instanceof Error ? e.message : e)
    } finally {
      if (waited) resume()
    }
  }

  const onMessage = (data: unknown): void => {
    if (settled || typeof data !== 'object' || data === null) return
    const m = data as Record<string, unknown>
    if (m.t === 'ready' && phase === 'starting') {
      phase = 'running'
      arm(SCRIPT_TIMING.commandMs)
      connection?.port.postMessage({ t: 'run', id: target.commandId })
    } else if (m.t === 'fail')
      fail(
        phase === 'starting' ? 'loadFailed' : 'thrown',
        typeof m.message === 'string' ? m.message.slice(0, 500) : undefined,
      )
    else if (m.t === 'done' && phase === 'running') {
      if (m.ok === true) end({ status: 'done' })
      else fail('thrown', typeof m.message === 'string' ? m.message.slice(0, 500) : undefined)
    } else if (m.t === 'call' && phase === 'running') void handleCall(m.seq, m.method, m.args)
    else fail('badCall')
  }

  arm(SCRIPT_TIMING.startMs)
  deps
    .open(target, () => fail('memory'))
    .then(c => {
      if (settled) return c.stop()
      connection = c
      c.port.on('message', e => onMessage(e.data))
      c.port.on('close', () => fail('crashed'))
      c.port.start()
    })
    .catch((e: unknown) => fail('loadFailed', e instanceof Error ? e.message : String(e)))

  return { done, cancel: reason => fail(reason) }
}
