// Antigravity 后台命令追踪（docs/antigravity-engine.md §17）：
// agy 的 run_command 转入后台时，工具输出给出 task id 与实时日志文件 .system_generated/tasks/task-N.log；
// ACP 协议没有 background_tasks_changed / stop_task / get_task_output，这里读日志尾部更新进度与端口，
// 并在 agy acp 的子进程树下定位命令子进程：支持 0 秒停止与空闲时自动检测退出收尾
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { BackgroundTask, EngineEvent, Item, NoticeTask, TaskOutput } from '@pixelsky/protocol'
import { IS_WINDOWS, plainLine } from '../exec'

const TASK_ID_RE = /Tool is running as a background task with task id:\s*(\S+)/
const TASK_LOG_RE = /Task logs are available at:\s*(\S+)/
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{1,5}\b/gi
const LOG_TAIL_BYTES = 24_000
const MESSAGE_MAX = 200
const DEFAULT_POLL_MS = 1_500
/** 找不到子进程、日志也不再增长：连续这么多轮才按完成收尾（找子进程偶尔失败或超时，一次没找到不算） */
const UNMATCHED_SETTLE_TICKS = 3

export interface AgyBackgroundParsed {
  taskId: string
  logPath: string | null
}

export interface AgyBackgroundStart {
  taskId: string
  logPath: string | null
  callId: string
  command: string
  item: Extract<Item, { kind: 'command' }>
}

export interface AgyProcessOps {
  /** 在 agyPid 的直接子进程里找这条命令对应的进程（排除已被别的后台任务认领的 PID） */
  findChild(agyPid: number, command: string, claimed: ReadonlySet<number>): Promise<number | null>
  /** 进程还在不在（不拉起外部程序） */
  isAlive(pid: number): boolean
  /** 结束这个子进程和它派生的整个进程树（不动父进程 agy） */
  killTree(pid: number): Promise<void>
}

/** file:///C:/... 或本机路径 → 本机文件路径 */
function resolveLogPath(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed)
    } catch {
      const fallback = decodeURIComponent(trimmed.replace(/^file:\/\/\/?/, ''))
      return IS_WINDOWS && /^[A-Za-z]:/.test(fallback) ? fallback.replace(/\//g, '\\') : '/' + fallback
    }
  }
  return trimmed
}

/** 识别 run_command 转入后台时的返回格式；普通前台命令返回 null */
export function parseAgyBackgroundTask(output: string): AgyBackgroundParsed | null {
  const idMatch = TASK_ID_RE.exec(output)
  if (!idMatch?.[1]) return null
  const logMatch = TASK_LOG_RE.exec(output)
  return {
    taskId: idMatch[1].trim(),
    logPath: logMatch?.[1] ? resolveLogPath(logMatch[1]) : null,
  }
}

/** 读取后台任务日志的最后一段（大文件只读尾部字节，不在内存里展开整份构建日志） */
export function readLogTail(logPath: string | null, maxBytes = LOG_TAIL_BYTES): TaskOutput {
  if (!logPath) return { output: '', truncated: false }
  let size: number
  try {
    size = statSync(logPath).size
  } catch {
    return { output: '', truncated: false }
  }
  if (size <= 0) return { output: '', truncated: false }
  if (size <= maxBytes) {
    try {
      const text = readFileSync(logPath, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
      return { output: text, truncated: false }
    } catch {
      return { output: '', truncated: false }
    }
  }
  let fd: number | null = null
  try {
    fd = openSync(logPath, 'r')
    const buf = Buffer.allocUnsafe(maxBytes)
    const bytes = readSync(fd, buf, 0, maxBytes, size - maxBytes)
    let text = buf.subarray(0, bytes).toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
    // 截断起点可能落在半行或多字节字符中间：前 512 个字符里有换行就从下一整行起显示
    const nl = text.indexOf('\n')
    if (nl >= 0 && nl < 512) text = text.slice(nl + 1)
    return { output: text, truncated: true }
  } catch {
    return { output: '', truncated: false }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 关闭失败忽略
      }
    }
  }
}

/**
 * 从日志尾部提取一行进度摘要，并记住出现过的本机端口地址：
 * Vite / Next 启动后继续打印帮助或 HMR 行时，把本机地址拼在后面，顶条和概况里的 `:端口` 按钮不会消失
 */
export function logProgressMessage(
  output: string,
  prevUrl: string | null = null,
): { message: string | null; url: string | null } {
  const clean = output
    .split(/\r\n|\r|\n/)
    .map(plainLine)
    .filter(Boolean)
  let url = prevUrl
  for (const line of clean) {
    LOCAL_URL_RE.lastIndex = 0
    const m = LOCAL_URL_RE.exec(line)
    if (m?.[0]) url = m[0]
  }
  const last = clean.at(-1) ?? ''
  const clipped = last.length > MESSAGE_MAX ? last.slice(0, MESSAGE_MAX) + '…' : last
  if (!clipped) return { message: url, url }
  if (url && !clipped.toLowerCase().includes(url.toLowerCase())) {
    return { message: `${clipped} · ${url}`, url }
  }
  return { message: clipped, url }
}

/** 进程存活检查：kill(pid, 0) 纯系统调用，不拉起子进程；EPERM 说明进程存在 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 去掉引号、反斜杠转义和多余空白，匹配 PowerShell / sh 包装后的命令行参数 */
export function normalizeCmd(text: string): string {
  return text
    .replace(/[\\"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const HELPER_PROC = /^(?:conhost|agy|language_server[\w.-]*)(?:\.exe)?$/i
const SHELL_PROC = /^(?:powershell|pwsh|cmd|sh|bash|zsh)(?:\.exe)?$/i

export interface ChildCandidate {
  pid: number
  name: string
  commandLine: string
}

/** 在候选子进程里挑出对应这条命令的 PID：命令行包含关系优先，否则退回未认领的 shell 子进程 */
export function pickCommandChild(
  children: readonly ChildCandidate[],
  command: string,
  claimed: ReadonlySet<number>,
): number | null {
  const pool = children.filter(c => c.pid > 0 && !claimed.has(c.pid) && !HELPER_PROC.test(c.name))
  if (!pool.length) return null
  const firstLine = command.split(/\r?\n/).find(l => l.trim()) ?? command
  const needle = normalizeCmd(firstLine)
  if (needle) {
    const matched = pool.find(c => normalizeCmd(c.commandLine).includes(needle))
    if (matched) return matched.pid
  }
  const shell = pool.find(c => SHELL_PROC.test(c.name))
  return shell?.pid ?? null
}

function execText(file: string, args: string[], timeout = 4_000): Promise<string> {
  return new Promise(resolve => {
    try {
      execFile(file, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve(err ? '' : String(stdout ?? ''))
      })
    } catch {
      resolve('')
    }
  })
}

async function listDirectChildren(agyPid: number): Promise<ChildCandidate[]> {
  if (!Number.isInteger(agyPid) || agyPid <= 0) return []
  if (IS_WINDOWS) {
    const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${agyPid}' | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress`
    const raw = (await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])).trim()
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : [parsed]
      return list.flatMap(item => {
        if (!item || typeof item !== 'object') return []
        const o = item as Record<string, unknown>
        const pid = typeof o.ProcessId === 'number' ? o.ProcessId : 0
        const name = typeof o.Name === 'string' ? o.Name : ''
        const commandLine = typeof o.CommandLine === 'string' ? o.CommandLine : ''
        return pid > 0 ? [{ pid, name, commandLine }] : []
      })
    } catch {
      return []
    }
  }
  const raw = await execText('ps', ['-ax', '-o', 'pid=,ppid=,comm=,args='])
  const out: ChildCandidate[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    if (ppid === agyPid && pid > 0) {
      const comm = m[3]!.split('/').pop() ?? m[3]!
      out.push({ pid, name: comm, commandLine: m[4] ?? '' })
    }
  }
  return out
}

/** 收集 Unix 下某个 PID 的所有后代进程（自底向上排列），避免误杀父进程 agy 所在的进程组 */
export function collectDescendants(rows: readonly { pid: number; ppid: number }[], rootPid: number): number[] {
  const byParent = new Map<number, number[]>()
  for (const r of rows) {
    const list = byParent.get(r.ppid) ?? []
    list.push(r.pid)
    byParent.set(r.ppid, list)
  }
  const order: number[] = []
  const visit = (pid: number): void => {
    for (const child of byParent.get(pid) ?? []) visit(child)
    order.push(pid)
  }
  visit(rootPid)
  return order
}

async function killSubtree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (IS_WINDOWS) {
    await execText('taskkill', ['/pid', String(pid), '/T', '/F'], 5_000)
    return
  }
  const raw = await execText('ps', ['-ax', '-o', 'pid=,ppid='])
  const rows: { pid: number; ppid: number }[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) })
  }
  const targets = collectDescendants(rows, pid)
  for (const t of targets) {
    try {
      process.kill(t, 'SIGTERM')
    } catch {
      // 已退出
    }
  }
  if (targets.some(isPidAlive)) {
    await new Promise(r => setTimeout(r, 150))
    for (const t of targets) {
      try {
        process.kill(t, 'SIGKILL')
      } catch {
        // 已退出
      }
    }
  }
}

export const defaultAgyProcessOps: AgyProcessOps = {
  async findChild(agyPid, command, claimed) {
    const children = await listDirectChildren(agyPid)
    return pickCommandChild(children, command, claimed)
  },
  isAlive: isPidAlive,
  killTree: killSubtree,
}

interface TrackedTask {
  taskId: string
  logPath: string | null
  callId: string
  command: string
  item: Extract<Item, { kind: 'command' }>
  message: string | null
  url: string | null
  lastSize: number
  pid: number | null
  binding: Promise<number | null> | null
  /** 没匹配到存活子进程的连续巡检次数（刚启动就已跑完的短后台命令，日志不再增长后自动收尾） */
  unmatchedTicks: number
  stopping: boolean
}

const TASK_STATUS_TEXT: Record<'completed' | 'stopped', string> = {
  completed: '已完成',
  stopped: '已停止',
}

export class AgyBackgroundTracker {
  private readonly tasks = new Map<string, TrackedTask>()
  private timer: NodeJS.Timeout | null = null
  private polling = false

  constructor(
    private readonly emit: (e: EngineEvent) => void,
    private readonly agyPid: () => number | undefined = () => undefined,
    private readonly ops: AgyProcessOps = defaultAgyProcessOps,
    private readonly pollMs = DEFAULT_POLL_MS,
  ) {}

  private claimedPids(excludeTaskId?: string): Set<number> {
    const set = new Set<number>()
    for (const t of this.tasks.values()) {
      if (t.taskId !== excludeTaskId && t.pid !== null) set.add(t.pid)
    }
    return set
  }

  private fileSize(logPath: string | null): number {
    if (!logPath) return 0
    try {
      return statSync(logPath).size
    } catch {
      return 0
    }
  }

  private snapshot(): BackgroundTask[] {
    return [...this.tasks.values()].map(t => ({
      id: t.taskId,
      kind: 'local_bash',
      description: t.command,
      message: t.message,
    }))
  }

  private emitTasks(): void {
    this.emit({ type: 'tasks', tasks: this.snapshot() })
  }

  private ensureTimer(): void {
    if (this.timer || this.tasks.size === 0) return
    this.timer = setInterval(() => {
      void this.poll()
    }, this.pollMs)
    this.timer.unref?.()
  }

  private clearTimerIfIdle(): void {
    if (this.tasks.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 登记一条刚转入后台的 run_command，立即推 tasks 事件，随后异步绑定子进程 PID */
  register(start: AgyBackgroundStart): void {
    if (this.tasks.has(start.taskId)) return
    const size = this.fileSize(start.logPath)
    const initial = size > 0 ? logProgressMessage(readLogTail(start.logPath).output) : { message: null, url: null }
    const entry: TrackedTask = {
      taskId: start.taskId,
      logPath: start.logPath,
      callId: start.callId,
      command: start.command,
      item: start.item,
      message: initial.message,
      url: initial.url,
      lastSize: size,
      pid: null,
      binding: null,
      unmatchedTicks: 0,
      stopping: false,
    }
    this.tasks.set(start.taskId, entry)
    this.emitTasks()
    this.ensureTimer()
    const pid = this.agyPid()
    if (pid) this.bindPid(entry, pid)
  }

  private bindPid(entry: TrackedTask, agyPid: number): void {
    if (entry.binding) return
    const p = this.ops
      .findChild(agyPid, entry.command, this.claimedPids(entry.taskId))
      .catch(() => null)
      .then(pid => {
        const current = this.tasks.get(entry.taskId)
        if (!current || current !== entry) return null
        current.binding = null
        if (pid !== null && !this.claimedPids(entry.taskId).has(pid)) current.pid = pid
        return current.pid
      })
    entry.binding = p
  }

  /** 读取某个后台任务的最新尾部输出（「输出」展开与「刷新」） */
  taskOutput(taskId: string): TaskOutput {
    const entry = this.tasks.get(taskId)
    if (!entry) throw new Error('后台任务已结束')
    const out = readLogTail(entry.logPath)
    const next = logProgressMessage(out.output, entry.url)
    entry.url = next.url
    if (next.message !== entry.message) {
      entry.message = next.message
      this.emitTasks()
    }
    return out
  }

  /** 用户点击任务条「停止」：直接杀掉该命令的子进程树并收尾 */
  async stop(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId)
    if (!entry) return
    entry.stopping = true
    let pid = entry.pid
    if (pid === null && entry.binding) pid = await entry.binding
    const parentPid = this.agyPid()
    if (pid === null && parentPid) {
      pid = await this.ops.findChild(parentPid, entry.command, this.claimedPids(taskId)).catch(() => null)
    }
    // 找不到进程就没停下：不能写「已停止」骗人，任务条留着（界面上停止按钮复原）
    if (pid === null) {
      entry.stopping = false
      throw new Error('没找到这条后台命令的进程，没能停止')
    }
    await this.ops.killTree(pid).catch(() => {})
    // await 之后重新核对任务是否仍在表里（期间进程退出或模型 kill 可能已收尾）
    if (this.tasks.get(taskId) !== entry) return
    this.settle(entry, 'stopped')
  }

  /** 模型自己调用 manage_task(Action: 'kill') 结束了后台任务 */
  killedByModel(taskId: string): void {
    const entry = this.tasks.get(taskId)
    if (entry) this.settle(entry, 'stopped')
  }

  /** 定时巡检日志增长与子进程存活 */
  async poll(): Promise<void> {
    if (this.polling || this.tasks.size === 0) return
    this.polling = true
    try {
      const parentPid = this.agyPid()
      let messageChanged = false
      for (const entry of [...this.tasks.values()]) {
        if (entry.stopping || this.tasks.get(entry.taskId) !== entry) continue
        const size = this.fileSize(entry.logPath)
        const grew = size !== entry.lastSize
        if (grew) {
          entry.lastSize = size
          const next = logProgressMessage(readLogTail(entry.logPath).output, entry.url)
          entry.url = next.url
          if (next.message !== entry.message) {
            entry.message = next.message
            messageChanged = true
          }
        }
        if (entry.pid !== null) {
          if (!this.ops.isAlive(entry.pid)) {
            this.settle(entry, 'completed')
          }
          continue
        }
        if (entry.binding) continue
        if (parentPid) {
          const found = await this.ops
            .findChild(parentPid, entry.command, this.claimedPids(entry.taskId))
            .catch(() => null)
          if (this.tasks.get(entry.taskId) !== entry || entry.stopping) continue
          if (found !== null) {
            entry.pid = found
            entry.unmatchedTicks = 0
            continue
          }
        }
        // 转后台后子进程已经很快跑完退出了，且日志不再增长：连续几轮都这样才按完成收尾。
        // 日志里出现过本机地址的是开发服务：启动完日志就不动了，找不到进程时不能当它结束了（留着等停止 / 模型结束）
        if (!grew) {
          entry.unmatchedTicks++
          if (entry.unmatchedTicks >= UNMATCHED_SETTLE_TICKS && entry.url === null) this.settle(entry, 'completed')
        } else {
          entry.unmatchedTicks = 0
        }
      }
      if (messageChanged && this.tasks.size > 0) this.emitTasks()
    } finally {
      this.polling = false
      this.clearTimerIfIdle()
    }
  }

  private settle(entry: TrackedTask, status: 'completed' | 'stopped'): void {
    if (!this.tasks.delete(entry.taskId)) return
    this.clearTimerIfIdle()
    const tail = readLogTail(entry.logPath)
    const next = logProgressMessage(tail.output, entry.url)
    const itemStatus = status === 'completed' ? 'completed' : 'interrupted'
    this.emit({
      type: 'item_completed',
      item: { ...entry.item, output: tail.output, status: itemStatus, background: false },
    })
    this.emitTasks()
    const summary = next.message ?? ''
    const task: NoticeTask = {
      toolUseId: entry.callId,
      kind: 'bash',
      status,
      label: entry.command,
      ...(summary ? { summary } : {}),
    }
    this.emit({
      type: 'item_completed',
      item: {
        kind: 'notice',
        id: 'ag-bg-done-' + randomUUID().slice(0, 8),
        level: 'info',
        text: '后台命令' + TASK_STATUS_TEXT[status] + (summary ? '：' + summary : ''),
        detail: null,
        task,
      },
    })
  }

  /** 会话关闭或 agy 进程退出：清空后台任务条、清理残留子进程树，还在跑的后台命令条目按中断收尾 */
  processGone(killChildren = true): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.tasks.size === 0) return
    const active = [...this.tasks.values()]
    this.tasks.clear()
    this.emit({ type: 'tasks', tasks: [] })
    for (const entry of active) {
      if (killChildren && entry.pid !== null) void this.ops.killTree(entry.pid).catch(() => {})
      const tail = readLogTail(entry.logPath)
      this.emit({
        type: 'item_completed',
        item: { ...entry.item, output: tail.output, status: 'interrupted', background: false },
      })
    }
  }
}
