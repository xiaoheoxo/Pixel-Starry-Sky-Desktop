import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { Launcher } from '../adapter'
import { LineSplitter, TailBuffer, droppedRef } from '../jsonl'
import { logger, redact } from '../log'
import { logProcess } from '../process-log'
import { killTree } from '../exec'

export { redact }
const log = logger('engine.codex')

export type Message = Record<string, unknown>
export const object = (v: unknown): Message => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Message) : {})
export const string = (v: unknown): string => (typeof v === 'string' ? v : '')
export const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const number = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0)

/** 进程是干什么的（写进启动 / 退出日志；线程被占着时对照进程列表认出自己的进程） */
export type CodexPurpose = 'session' | 'reader' | 'oneshot' | 'detect' | 'probe' | 'history' | 'tui-check' | 'other'
export interface CodexProcessTag {
  purpose: CodexPurpose
  /** 会话进程：像素星空的会话 id */
  sessionId?: string
}

/** 像素星空现在开着的 Codex 进程：pid → 用途（进程退出时撤销） */
const running = new Map<number, CodexProcessTag>()
export function runningCodexProcesses(): ReadonlyMap<number, CodexProcessTag> {
  return running
}

export interface RpcHandlers {
  notification(method: string, params: Message): void
  request(id: string | number, method: string, params: Message): void
  exit(code: number | null, tail: string): void
}
export class CodexProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    { resolve: (value: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private readonly stderr = new TailBuffer()
  private sequence = 0
  private exited = false
  /** close() / kill() 之后为真：退出不算异常（日志用） */
  private stopping = false
  readonly exitPromise: Promise<void>

  constructor(
    launcher: Launcher,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    handlers: RpcHandlers,
    tag?: CodexProcessTag,
  ) {
    this.child = spawn(launcher.command, [...launcher.args, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: 'pipe',
      // macOS / Linux：自成进程组，强制结束时连同它启动的命令一起结束
      detached: process.platform !== 'win32',
    })
    if (this.child.pid !== undefined) running.set(this.child.pid, tag ?? { purpose: 'other' })
    this.child.stdin.on('error', () => {})
    this.child.stderr.on('data', (data: Buffer) => this.stderr.push(redact(data.toString('utf8'))))
    logProcess(
      log,
      this.child,
      { command: launcher.command, cwd, ...(tag ? { fields: { ...tag } } : {}) },
      () => this.stderr.toString(),
      () => this.stopping,
    )
    const decoder = new StringDecoder('utf8')
    // 超长的字符串边收边截短；截短后仍太大的整条丢掉，对应的请求报错，进程照常运行（docs/engine-output-limits.md）
    const splitter = new LineSplitter(dropped => {
      const { id, kind: method } = droppedRef(dropped.head, 'method')
      log.warn('协议消息太大，已丢弃', { pid: this.child.pid, chars: dropped.length, id, method })
      const request = typeof id === 'number' ? this.pending.get(id) : undefined
      if (!request || method) return
      clearTimeout(request.timer)
      this.pending.delete(id as number)
      request.reject(new Error(`Codex response too large (${Math.round(dropped.length / 1024 / 1024)} MB), dropped`))
    })
    this.child.stdout.on('data', (data: Buffer) => {
      for (const line of splitter.push(decoder.write(data))) {
        let value: Message
        try {
          value = object(JSON.parse(line))
        } catch {
          continue
        }
        if (typeof value.method === 'string') {
          // 处理器抛错（例如落盘失败）：记日志、接着处理后面的消息，不能变成主进程未捕获异常（审查报告 2026-10-14）
          try {
            if (typeof value.id === 'string' || typeof value.id === 'number')
              handlers.request(value.id, value.method, object(value.params))
            else handlers.notification(value.method, object(value.params))
          } catch (err) {
            log.error('处理 Codex 消息出错', { method: value.method, error: (err as Error).message })
          }
        } else if (typeof value.id === 'number') {
          const request = this.pending.get(value.id)
          if (!request) continue
          clearTimeout(request.timer)
          this.pending.delete(value.id)
          if (value.error) request.reject(new Error(redact(string(object(value.error).message) || 'Codex RPC error')))
          else request.resolve(object(value.result))
        }
      }
    })
    this.exitPromise = new Promise(resolve => {
      const finish = (code: number | null): void => {
        if (this.exited) return
        this.exited = true
        if (this.child.pid !== undefined) running.delete(this.child.pid)
        for (const request of this.pending.values()) {
          clearTimeout(request.timer)
          request.reject(new Error('Codex process exited'))
        }
        this.pending.clear()
        handlers.exit(code, this.stderr.toString())
        resolve()
      }
      this.child.once('exit', finish)
      this.child.once('error', error => {
        this.stderr.push(redact(error.message))
        finish(null)
      })
    })
  }
  get pid(): number | undefined {
    return this.child.pid
  }
  get alive(): boolean {
    return !this.exited
  }
  notify(method: string, params: unknown = {}): void {
    this.write({ method, params })
  }
  respond(id: string | number, result: unknown): void {
    this.write({ id, result })
  }
  respondError(id: string | number, message: string): void {
    this.write({ id, error: { code: -32601, message } })
  }
  private write(value: unknown): void {
    if (!this.exited && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + '\n')
  }
  request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<Message> {
    if (this.exited) return Promise.reject(new Error('Codex process exited'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex did not respond: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }
  async initialize(experimentalApi = false): Promise<Message> {
    const result = await this.request('initialize', {
      clientInfo: { name: 'pixelsky', title: 'Pixel Starry Sky', version: '0.1.0' },
      capabilities: { experimentalApi },
    })
    this.notify('initialized')
    return result
  }
  async close(timeoutMs = 2_000): Promise<void> {
    if (!this.alive) return
    this.stopping = true
    this.child.stdin.end()
    const timer = setTimeout(() => this.kill(), timeoutMs)
    await this.exitPromise
    clearTimeout(timer)
  }
  kill(): void {
    if (!this.alive) return
    this.stopping = true
    killTree(this.child)
  }
}
