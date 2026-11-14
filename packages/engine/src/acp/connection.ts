// Agent Client Protocol 的 JSON-RPC 连接（每行一条 JSON，走子进程 stdin / stdout）。
// Antigravity（agy acp）用它探测登录，第二期的会话也走它（docs/antigravity-engine.md §5、§7）
import { spawn, type ChildProcess } from 'node:child_process'
import type { Launcher } from '../adapter'
import { IS_WINDOWS, killTree } from '../exec'

export type AcpMessage = Record<string, unknown>

export class AcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

/** ACP 规定：没登录时请求回 -32000 Authentication required */
export const ACP_AUTH_REQUIRED = -32000

export interface AcpHandlers {
  /** 对方发来的通知（session/update 等） */
  notification?(method: string, params: AcpMessage): void
  /** 对方发来的请求（session/request_permission 等）；不处理时回「不支持」 */
  request?(method: string, params: AcpMessage): Promise<unknown> | undefined
  /** 进程退出；stderr 是最后一段输出 */
  exit?(code: number | null, stderr: string): void
}

export class AcpConnection {
  private readonly child: ChildProcess
  private nextId = 0
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  private buffer = ''
  private stderr = ''
  private exited = false

  constructor(
    launcher: Launcher,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly handlers: AcpHandlers = {},
  ) {
    this.child = spawn(launcher.command, [...launcher.args, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !IS_WINDOWS,
    })
    this.child.stdout!.setEncoding('utf8').on('data', (chunk: string) => this.read(chunk))
    // 只留最后 8 KB：agy 把日志写到自己的文件，stderr 一般只有启动失败的原因
    this.child
      .stderr!.setEncoding('utf8')
      .on('data', (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-8192)))
    this.child.on('error', err => this.finish(null, err.message))
    this.child.on('exit', code => this.finish(code, this.stderr))
    this.child.stdin!.on('error', () => {})
  }

  request<T = AcpMessage>(method: string, params: AcpMessage = {}, timeoutMs = 30_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error(this.exitReason()))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: v => (clearTimeout(timer), resolve(v as T)),
        reject: e => (clearTimeout(timer), reject(e)),
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: AcpMessage = {}): void {
    if (!this.exited) this.write({ jsonrpc: '2.0', method, params })
  }

  /** 关 stdin 让对方自己退出（agy 在 0.5 秒内退），超时再结束进程树 */
  async close(graceMs = 2000): Promise<void> {
    if (this.exited) return
    this.child.stdin!.end()
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        killTree(this.child)
        resolve()
      }, graceMs)
      this.child.once('exit', () => (clearTimeout(timer), resolve()))
    })
  }

  private write(msg: AcpMessage): void {
    this.child.stdin!.write(JSON.stringify(msg) + '\n')
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let i: number
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim()
      this.buffer = this.buffer.slice(i + 1)
      if (!line) continue
      let msg: AcpMessage
      try {
        msg = JSON.parse(line) as AcpMessage
      } catch {
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: AcpMessage): void {
    const method = typeof msg.method === 'string' ? msg.method : null
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as AcpMessage
    // 对方的请求 id 可能是字符串（agy 的权限请求是 "1"、"2"）
    if (method && msg.id !== undefined) {
      const answer = this.handlers.request?.(method, params)
      if (!answer) {
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${method} not supported` } })
        return
      }
      answer.then(
        result => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }),
        (err: Error) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } }),
      )
      return
    }
    if (method) {
      this.handlers.notification?.(method, params)
      return
    }
    const waiter = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
    if (!waiter) return
    this.pending.delete(msg.id as number)
    const error = msg.error as { code?: unknown; message?: unknown } | undefined
    if (error)
      waiter.reject(
        new AcpError(typeof error.code === 'number' ? error.code : -32603, String(error.message ?? 'error')),
      )
    else waiter.resolve(msg.result)
  }

  private exitReason(): string {
    return this.stderr.trim().split(/\r?\n/).slice(-3).join('\n') || '进程已退出'
  }

  private finish(code: number | null, stderr: string): void {
    if (this.exited) return
    this.exited = true
    const reason = new Error(this.exitReason())
    for (const w of this.pending.values()) w.reject(reason)
    this.pending.clear()
    this.handlers.exit?.(code, stderr)
  }
}
