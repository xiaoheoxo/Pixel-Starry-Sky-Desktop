// 引擎子进程的日志（docs/ui/logging.md §4.5）：启动、退出；异常退出时带 stderr 最后几行，详细日志打开时 stderr 逐行记
import type { ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import { describeError, type Logger } from './log'

const TAIL_LINES = 20
/** 我们自己结束的进程只带最后几行 */
const KILLED_TAIL_LINES = 3

export function logProcess(
  log: Logger,
  child: ChildProcess,
  /** fields：启动、退出两条都带（用途、会话 id：排查日志里每个 pid 是谁起的） */
  info: { command: string; cwd: string; fields?: Record<string, unknown> },
  /** 进程的 stderr 尾巴（异常退出时取最后几行） */
  stderrTail: () => string,
  /** 是不是我们自己在结束它（关 stdin、taskkill）：Windows 上 taskkill 结束的进程 child.killed 仍是 false */
  stopping: () => boolean = () => false,
  /** 退出时一起记的字段（用途、怎么结束的，docs/ui/claude-login-recovery.md §1 第 3 条） */
  meta?: () => Record<string, unknown>,
): void {
  const started = Date.now()
  const command = basename(info.command)
  if (child.pid !== undefined) log.info('进程启动', { command, pid: child.pid, cwd: info.cwd, ...info.fields })
  let partial = ''
  child.stderr?.on('data', (data: Buffer) => {
    if (!log.enabled('debug')) return
    const lines = (partial + data.toString('utf8')).split(/\r?\n/)
    partial = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) log.debug('stderr', { pid: child.pid, line })
  })
  child.once('exit', (code, signal) => {
    const fields = { command, pid: child.pid, code, signal, runMs: Date.now() - started, ...info.fields, ...meta?.() }
    const tail = (lines: number): string => stderrTail().split(/\r?\n/).filter(Boolean).slice(-lines).join('\n')
    if (code === 0) log.info('进程退出', fields)
    else if (child.killed || stopping()) {
      // 我们自己结束的（空闲关闭、停止、退出应用）不算异常；有 stderr 时带上最后几行（被结束前在做什么）
      const stderr = tail(KILLED_TAIL_LINES)
      log.info('进程退出', stderr ? { ...fields, stderr } : fields)
    } else log.warn('进程异常退出', { ...fields, stderr: tail(TAIL_LINES) })
  })
  child.once('error', error => log.warn('进程启动失败', { command, cwd: info.cwd, error: describeError(error) }))
}
