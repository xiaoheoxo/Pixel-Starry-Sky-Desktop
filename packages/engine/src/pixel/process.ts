// 像素星空命令行（packages/cli，基于 Pi）的 RPC 子进程：标准输入输出上一行一个 JSON（docs/own-cli.md §6）。
// 按 \n 切行读，不能用 readline（会在 U+2028 / U+2029 处多切）；标准输出只有协议，日志在标准错误。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { Launcher } from '../adapter'
import { LineSplitter, TailBuffer, droppedRef } from '../jsonl'
import { logger, redact } from '../log'
import { logProcess } from '../process-log'
import { killTree } from '../exec'

export { redact }
const log = logger('engine.pixel')

/** 进程退出后等 stdio 读完的最长时间（见 exitPromise） */
const STDIO_DRAIN_MS = 1_000

export type Message = Record<string, unknown>
export const object = (v: unknown): Message => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Message) : {})
export const string = (v: unknown): string => (typeof v === 'string' ? v : '')
export const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const number = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0)

/** 拼好的一条最大多少字节（oh-my-pi ready 帧里的 maxReassembledFrameBytes 是 64 MiB） */
const MAX_REASSEMBLED = 64 * 1024 * 1024
/** 同时在拼的最多几条（拼不全的不能一直留着占内存） */
const MAX_OPEN_CHUNKS = 8

/**
 * oh-my-pi 第 2 版协议（negotiate_protocol 之后）：超过 1 MiB 的消息拆成一串 rpc_chunk，
 * 每块是一段字节的 base64（各自补齐），按 chunkId 拼回原来那条 JSON（docs/omp-engine.md §3）。Pi 不发这种帧
 */
export class ChunkAssembler {
  private readonly open = new Map<string, { parts: (Buffer | undefined)[]; got: number; bytes: number }>()
  /** 收到一块；拼齐了返回原来那条消息，否则 null（格式不对、超限的整条丢掉） */
  push(frame: Message): Message | null {
    const id = string(frame.chunkId)
    const count = Number(frame.count),
      index = Number(frame.index)
    if (!id || !Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count)
      return null
    let entry = this.open.get(id)
    if (!entry) {
      if (Number(frame.byteLength) > MAX_REASSEMBLED) return null
      if (this.open.size >= MAX_OPEN_CHUNKS) this.open.delete(this.open.keys().next().value as string)
      entry = { parts: new Array<Buffer | undefined>(count), got: 0, bytes: 0 }
      this.open.set(id, entry)
    }
    if (entry.parts.length !== count) return null
    if (!entry.parts[index]) {
      const part = Buffer.from(string(frame.data), 'base64')
      entry.bytes += part.length
      if (entry.bytes > MAX_REASSEMBLED) {
        this.open.delete(id)
        return null
      }
      entry.parts[index] = part
      entry.got++
    }
    if (entry.got < count) return null
    this.open.delete(id)
    try {
      return object(JSON.parse(Buffer.concat(entry.parts as Buffer[]).toString('utf8')))
    } catch {
      return null
    }
  }
}

export interface PixelHandlers {
  /** 命令回应以外的所有记录：会话事件、extension_ui_request 等 */
  event(event: Message): void
  exit(code: number | null, tail: string): void
}

/** 一条命令的回应（success 为 false 时 request() 会抛错，不会返回这个值） */
export interface PixelResponse {
  command: string
  data: Message
}

export class PixelProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    string,
    { resolve: (value: PixelResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | undefined }
  >()
  private readonly stderr = new TailBuffer()
  private sequence = 0
  private exited = false
  /** close() / kill() 之后为真：退出不算异常（日志用） */
  private stopping = false
  readonly exitPromise: Promise<void>

  constructor(launcher: Launcher, args: string[], cwd: string, env: NodeJS.ProcessEnv, handlers: PixelHandlers) {
    this.child = spawn(launcher.command, [...launcher.args, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: 'pipe',
      // macOS / Linux：自成进程组，强制结束时连同它启动的命令一起结束
      detached: process.platform !== 'win32',
    })
    this.child.stdin.on('error', () => {})
    this.child.stderr.on('data', (data: Buffer) => this.stderr.push(redact(data.toString('utf8'))))
    logProcess(
      log,
      this.child,
      { command: launcher.command, cwd },
      () => this.stderr.toString(),
      () => this.stopping,
    )
    const decoder = new StringDecoder('utf8')
    // 超长的字符串边收边截短；截短后仍太大的整条丢掉，对应的命令报错，进程照常运行（docs/engine-output-limits.md）
    const splitter = new LineSplitter(dropped => {
      const { id, kind: type } = droppedRef(dropped.head, 'type')
      log.warn('协议消息太大，已丢弃', { pid: this.child.pid, chars: dropped.length, id, type })
      const request = type === 'response' && typeof id === 'string' ? this.pending.get(id) : undefined
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(id as string)
      request.reject(new Error(`Pixel response too large (${Math.round(dropped.length / 1024 / 1024)} MB), dropped`))
    })
    const chunks = new ChunkAssembler()
    this.child.stdout.on('data', (data: Buffer) => {
      for (const raw of splitter.push(decoder.write(data))) {
        // 只按 \n 切；兼容 CRLF，去掉行尾的 \r（\r 可能落在上一块末尾，所以在整行拼好后再去）
        const line = raw.replace(/\r$/, '')
        let value: Message
        try {
          value = object(JSON.parse(line))
        } catch {
          continue
        }
        if (value.type === 'rpc_chunk') {
          const whole = chunks.push(value)
          if (!whole) continue
          value = whole
        }
        if (value.type === 'response' && typeof value.id === 'string' && this.pending.has(value.id)) {
          const request = this.pending.get(value.id)!
          clearTimeout(request.timer)
          this.pending.delete(value.id)
          if (value.success === false)
            request.reject(new Error(redact(string(value.error) || `Pixel command failed: ${string(value.command)}`)))
          else request.resolve({ command: string(value.command), data: object(value.data) })
        } else if (value.type === 'response') {
          // 没有对应请求的回应（例如无法解析的命令）：不当作事件
          continue
        } else {
          // 处理器抛错（例如落盘失败）：记日志、接着处理后面的消息，不能变成主进程未捕获异常（审查报告 2026-10-14）
          try {
            handlers.event(value)
          } catch (err) {
            log.error('处理 Pixel 消息出错', { type: string(value.type), error: (err as Error).message })
          }
        }
      }
    })
    this.exitPromise = new Promise(resolve => {
      const finish = (code: number | null): void => {
        if (this.exited) return
        this.exited = true
        for (const request of this.pending.values()) {
          clearTimeout(request.timer)
          request.reject(new Error('Pixel process exited'))
        }
        this.pending.clear()
        handlers.exit(code, this.stderr.toString())
        resolve()
      }
      // 在 close（stdout / stderr 都读完）时收尾：exit 先到时 stdio 可能还没读完，stderr 结尾（崩溃原因）和最后几帧会丢。
      // 后代进程占着管道不放时 close 不来，exit 后最多再等 STDIO_DRAIN_MS
      this.child.once('exit', code => setTimeout(() => finish(code), STDIO_DRAIN_MS).unref())
      this.child.once('close', finish)
      this.child.once('error', error => {
        this.stderr.push(redact(error.message))
        finish(null)
      })
    })
  }
  get alive(): boolean {
    return !this.exited
  }
  /**
   * 发一条命令，等对应的回应（按 id 对应，不按顺序）；success: false 时抛错。
   * timeoutMs 为 0 时不限时（调用方自己管等多久，进程退出时照样失败）
   */
  request(type: string, params: Message = {}, timeoutMs = 30_000): Promise<PixelResponse> {
    if (this.exited) return Promise.reject(new Error('Pixel process exited'))
    const id = `px-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`Pixel did not respond: ${type}`))
            }, timeoutMs)
          : undefined
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, type, ...params })
    })
  }
  /** 刚发出的那条命令的 id（omp 的 prompt_result 按它对） */
  get lastId(): string {
    return `px-${this.sequence}`
  }
  /** extension_ui_response：没有回应记录 */
  respondUi(id: string, value: { value: string } | { confirmed: boolean } | { cancelled: true }): void {
    this.write({ type: 'extension_ui_response', id, ...value })
  }
  private write(value: unknown): void {
    if (!this.exited && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + '\n')
  }
  /** 关 stdin 让 Pi 收尾退出；超时强制结束 */
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
