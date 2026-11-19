// 线程被占着（thread/resume 报 active writer）时查是谁占的，只写日志（docs/ui/codex-resume.md §13.2）。
// 真 Codex 的锁只在某个 codex 进程加载着线程时占着、进程退出即放（§13.1 实测），所以列出本机所有 codex 进程、
// 标出哪些是像素星空自己登记的，日志里就能分清：自己没关掉的、上次运行留下的（父进程已经没了）、别的程序开的。
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from '../log'
import { runningCodexProcesses } from './process'

/** 查进程列表最多等多久 */
const LIST_TIMEOUT_MS = 5_000
/** 命令行最多记多长（脱敏后） */
const COMMAND_CHARS = 300

export interface CodexProcessInfo {
  pid: number
  ppid: number
  /** 父进程的程序名；父进程已经不在了是 null */
  parent: string | null
  /** 启动时间（Windows 是 ISO 时间，其它系统是 ps 的已运行时长） */
  started: string
  command: string
}

/** 锁文件：不存在 / 在但没人占 / 被占着（只有 Windows 能看出来，其它系统锁是建议锁）/ 在、看不出 */
export type LockFileState = 'none' | 'free' | 'held' | 'exists'

export function lockFileState(codexHome: string, threadId: string): LockFileState {
  const file = join(codexHome, 'thread-writer-locks', `${threadId}.lock`)
  if (!existsSync(file)) return 'none'
  if (process.platform !== 'win32') return 'exists'
  // Codex 用区域锁（LockFileEx）：打开总能成功，读才报 EBUSY（实测 0.169）
  try {
    readFileSync(file)
    return 'free'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EBUSY' ? 'held' : 'exists'
  }
}

const WINDOWS_SCRIPT = [
  '$all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,CommandLine',
  '$names = @{}; foreach ($p in $all) { $names[[int]$p.ProcessId] = $p.Name }',
  "@($all | Where-Object { $_.Name -eq 'codex.exe' } | ForEach-Object { [pscustomobject]@{",
  '  pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; parent = $names[[int]$_.ParentProcessId]',
  "  started = if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' }; command = [string]$_.CommandLine",
  '} }) | ConvertTo-Json -Compress',
].join('\n')

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      { timeout: LIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  )
}

/** Windows：PowerShell 的 JSON（一个进程时是对象，没有时是空） */
export function parseWindowsList(text: string): CodexProcessInfo[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const value: unknown = JSON.parse(trimmed)
  return (Array.isArray(value) ? value : [value]).flatMap(v => {
    const p = v as Record<string, unknown>
    if (typeof p.pid !== 'number') return []
    return [
      {
        pid: p.pid,
        ppid: typeof p.ppid === 'number' ? p.ppid : 0,
        parent: typeof p.parent === 'string' && p.parent ? p.parent : null,
        started: typeof p.started === 'string' ? p.started : '',
        command: typeof p.command === 'string' ? p.command : '',
      },
    ]
  })
}

/** macOS / Linux：`ps -A -o pid=,ppid=,etime=,args=` 的输出；codex 进程是程序名以 codex 开头的 */
export function parsePsList(text: string): CodexProcessInfo[] {
  const rows = text
    .split(/\r?\n/)
    .map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), started: m[3], command: m[4] }))
  const program = (command: string): string => command.split(/\s+/)[0]?.split('/').pop() ?? ''
  const byPid = new Map(rows.map(r => [r.pid, r]))
  return rows
    .filter(r => /^codex/.test(program(r.command)))
    .map(r => {
      const parent = byPid.get(r.ppid)
      return { ...r, parent: parent ? program(parent.command) || null : null }
    })
}

export async function listCodexProcesses(): Promise<CodexProcessInfo[]> {
  if (process.platform === 'win32')
    return parseWindowsList(
      await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_SCRIPT,
      ]),
    )
  return parsePsList(await run('ps', ['-A', '-o', 'pid=,ppid=,etime=,args=']))
}

/** 写进日志的一份报告：每个 codex 进程标上是不是像素星空自己的、父进程是不是本应用 */
export async function lockHolderReport(
  codexHome: string,
  threadId: string,
  list: () => Promise<CodexProcessInfo[]> = listCodexProcesses,
): Promise<Record<string, unknown>> {
  const ours = runningCodexProcesses()
  const report: Record<string, unknown> = { lock: lockFileState(codexHome, threadId) }
  try {
    report.processes = (await list()).map(p => {
      const tag = ours.get(p.pid)
      return {
        pid: p.pid,
        ppid: p.ppid,
        parent: p.parent ?? '(已退出)',
        ...(p.ppid === process.pid ? { parentIsApp: true } : {}),
        started: p.started,
        ...(tag ? { ours: tag.sessionId ? `${tag.purpose}:${tag.sessionId}` : tag.purpose } : {}),
        // 用户把 Codex 换成了外面包一层的命令：真正的 codex 是像素星空进程的子进程
        ...(!tag && ours.has(p.ppid) ? { parentOurs: true } : {}),
        // 命令行里有这个线程 id 的（终端里 codex resume <id>）多半就是它
        ...(p.command.includes(threadId) ? { mentionsThread: true } : {}),
        command: redact(p.command).slice(0, COMMAND_CHARS),
      }
    })
  } catch (error) {
    report.listError = (error as Error).message.split('\n')[0]
  }
  report.oursRunning = [...ours].map(([pid, tag]) =>
    tag.sessionId ? `${pid} ${tag.purpose}:${tag.sessionId}` : `${pid} ${tag.purpose}`,
  )
  return report
}
