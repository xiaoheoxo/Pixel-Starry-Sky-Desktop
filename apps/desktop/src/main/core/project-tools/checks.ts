// 产出检查（docs/ui/channels-collab-v2.md §8）：识别项目的检查命令、跑命令、看这次改动里新增的 TODO / 占位符 / 坏链接。
// 本机和 SSH 辅助进程共用（经 ops.ts 的操作表）；同一个项目目录同时只跑一次，后来的排队
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative } from 'node:path'
import { ConsoleLineDecoder, detectOemCodePage } from '@pixelsky/engine'
import { LOCKFILE_NAMES, detectPackageManager, scriptCommand } from '@pixelsky/protocol'
import {
  CHECK_COMMANDS_MAX,
  CHECK_COMMAND_CHARS,
  CHECK_TIMEOUT_MS,
  DEFAULT_CHECK_CONFIG,
  pageCheckUrl,
  type CheckCommand,
  type CheckCommandResult,
  type CheckConfig,
  type CheckFinding,
  type CheckPlan,
  type CheckRun,
  type CheckTextResult,
} from '../../../shared/types/checks'
import type { WorkspaceRef } from '../../../shared/types/workspace'
import { JsonStore, exec, run as runProgram, type ToolsHost } from './common'
import { childEnvironment, findProgram, redact } from './services'

const OUTPUT_CHARS = 8000

/**
 * macOS / Linux 上正在跑的检查（各自一个进程组）：退出应用时结束掉，不然卡住的检查会一直跑。
 * Windows 不用记：子进程在 Node 的作业对象里，应用退出时系统一起结束
 */
const running = new Set<number>()

export function killChecks(): void {
  for (const pid of running)
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* 已经退出 */
    }
  running.clear()
}
const FINDINGS_MAX = 50
const FILE_BYTES = 1024 * 1024
const UNTRACKED_MAX = 200
/** package.json 里按这个顺序找；有 check 就只跑它 */
const SCRIPTS = ['typecheck', 'lint', 'test']
const NO_TEST = /no test specified/i

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function text(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).size > FILE_BYTES) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** 按项目文件识别检查命令：package.json 有 check 就只跑它，没有就跑 typecheck / lint / test；再找 Makefile、gradlew */
export async function detectChecks(root: string): Promise<CheckCommand[]> {
  const pkg = await text(join(root, 'package.json'))
  if (pkg) {
    let scripts: Record<string, unknown> = {}
    let manager: unknown
    try {
      const json = JSON.parse(pkg) as { scripts?: Record<string, unknown>; packageManager?: unknown }
      scripts = json.scripts && typeof json.scripts === 'object' ? json.scripts : {}
      manager = json.packageManager
    } catch {
      /* 坏的 package.json 当没有 */
    }
    const present = new Set<string>()
    for (const name of LOCKFILE_NAMES) if (await exists(join(root, name))) present.add(name)
    const pm = detectPackageManager(manager, name => present.has(name))
    const usable = (name: string) =>
      typeof scripts[name] === 'string' && !(name === 'test' && NO_TEST.test(scripts[name] as string))
    const names = usable('check') ? ['check'] : SCRIPTS.filter(usable)
    if (names.length) return names.map(name => ({ label: name, command: scriptCommand(pm, name) }))
  }
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    const make = await text(join(root, name))
    if (!make) continue
    const target = ['check', 'test'].find(t => new RegExp(`^${t}\\s*:`, 'm').test(make))
    if (target) return [{ label: target, command: `make ${target}` }]
  }
  if (await exists(join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')))
    return [{ label: 'test', command: process.platform === 'win32' ? '.\\gradlew.bat test' : './gradlew test' }]
  return []
}

/** 检查并整理界面传来的设置 */
export function cleanCheckConfig(raw: unknown): CheckConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  let commands: string[] | null = null
  if (Array.isArray(r.commands)) {
    commands = r.commands
      .filter((c): c is string => typeof c === 'string')
      .map(c => c.replace(/[\r\n]+/g, ' ').trim())
      .filter(Boolean)
    if (commands.length > CHECK_COMMANDS_MAX) throw new Error(`检查命令最多 ${CHECK_COMMANDS_MAX} 条`)
    if (commands.some(c => c.length > CHECK_COMMAND_CHARS)) throw new Error(`每条命令最多 ${CHECK_COMMAND_CHARS} 个字`)
  }
  const page = typeof r.page === 'string' ? r.page.trim() : ''
  if (page && !pageCheckUrl(page)) throw new Error('页面地址只能填这台电脑上的，比如 localhost:5173')
  return {
    commands,
    text: r.text === undefined ? DEFAULT_CHECK_CONFIG.text : r.text === true,
    channel: r.channel === undefined ? DEFAULT_CHECK_CONFIG.channel : r.channel === true,
    page,
  }
}

// ---------------------------------------------------------------------------
// 文本检查
// ---------------------------------------------------------------------------

const TODO = /\b(?:TODO|FIXME)\b/
const PLACEHOLDER = /<(?:填写|待填写?|待补充|请填写|placeholder|TBD)[^<>\n]{0,40}>/i
const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g

/** git diff --unified=0 的输出 → 每个文件新增的行（行号是新文件里的） */
export function addedLines(diff: string): Map<string, { line: number; text: string }[]> {
  const files = new Map<string, { line: number; text: string }[]>()
  let current: { line: number; text: string }[] | null = null
  let next = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim()
      current = path === '/dev/null' ? null : (files.get(path.replace(/^b\//, '')) ?? [])
      if (current) files.set(path.replace(/^b\//, ''), current)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      next = Number(hunk[1])
      continue
    }
    if (current && raw.startsWith('+')) current.push({ line: next++, text: raw.slice(1) })
    else if (raw.startsWith(' ')) next++
  }
  return files
}

/** 一行里打不开的相对链接（Markdown 文件才看） */
async function brokenLinks(root: string, file: string, line: string): Promise<string[]> {
  const out: string[] = []
  for (const m of line.matchAll(LINK)) {
    const target = m[1]
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) continue
    let path = target.replace(/[#?].*$/, '')
    if (!path) continue
    try {
      path = decodeURIComponent(path)
    } catch {
      /* 留原样 */
    }
    if (!(await exists(join(root, dirname(file), path)))) out.push(target)
  }
  return out
}

/** 只看这次改动的文件（files 给了就只看这些，相对项目目录；项目是大仓库里的子目录时只看这个目录里的）：新增行里的 TODO / FIXME、占位符，Markdown 新增的坏链接 */
export async function textChecks(root: string, files?: readonly string[] | null): Promise<CheckTextResult> {
  const only = files?.length ? new Set(files.map(f => f.replace(/\\/g, '/'))) : null
  const gitArgs = ['-C', root, '-c', 'core.quotepath=false']
  const opts = { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' as const, timeout: 60_000 }
  try {
    await exec('git', [...gitArgs, 'rev-parse', '--is-inside-work-tree'], opts)
  } catch {
    return { kind: 'text', status: 'skipped', findings: [], note: '不是 Git 仓库' }
  }
  const added = new Map<string, { line: number; text: string }[]>()
  try {
    const { stdout } = await exec(
      'git',
      [
        ...gitArgs,
        'diff',
        'HEAD',
        '--relative',
        '--unified=0',
        '--no-color',
        '--no-ext-diff',
        '--src-prefix=a/',
        '--dst-prefix=b/',
      ],
      opts,
    )
    for (const [file, lines] of addedLines(stdout)) added.set(file, lines)
  } catch {
    /* 还没有提交（没有 HEAD）：只看新文件 */
  }
  try {
    const { stdout } = await exec('git', [...gitArgs, 'ls-files', '--others', '--exclude-standard', '-z'], opts)
    for (const file of stdout.split('\0').filter(Boolean).slice(0, UNTRACKED_MAX)) {
      if (only && !only.has(file)) continue
      const body = await text(join(root, file))
      if (body === null || body.includes('\0')) continue
      added.set(
        file,
        body.split(/\r?\n/).map((t, i) => ({ line: i + 1, text: t })),
      )
    }
  } catch {
    /* 列不出新文件就只看改动 */
  }
  const findings: CheckFinding[] = []
  const push = (f: CheckFinding) => {
    if (findings.length < FINDINGS_MAX) findings.push({ ...f, text: f.text.trim().slice(0, 200) })
  }
  for (const [file, lines] of added) {
    if (only && !only.has(file)) continue
    const markdown = /\.(?:md|mdx|markdown)$/i.test(file)
    for (const { line, text: t } of lines) {
      if (TODO.test(t)) push({ rule: 'todo', file, line, text: t })
      else if (PLACEHOLDER.test(t)) push({ rule: 'placeholder', file, line, text: t })
      if (markdown) for (const link of await brokenLinks(root, file, t)) push({ rule: 'link', file, line, text: link })
    }
  }
  return { kind: 'text', status: findings.length ? 'warn' : 'pass', findings }
}

// ---------------------------------------------------------------------------
// 跑命令
// ---------------------------------------------------------------------------

/** 用系统的 shell 跑一条命令（和项目服务一样：Windows 用 PowerShell，其余 /bin/sh），到 deadline 结束整棵进程树 */
export async function runCommand(root: string, c: CheckCommand, deadline: number): Promise<CheckCommandResult> {
  const started = Date.now()
  const left = deadline - started
  const base = { kind: 'command' as const, label: c.label, command: c.command }
  if (left <= 0) return { ...base, status: 'timeout', exitCode: null, ms: 0, output: '' }
  const shell =
    process.platform === 'win32'
      ? ((await findProgram('pwsh.exe')) ??
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'))
      : '/bin/sh'
  const args =
    process.platform === 'win32'
      ? [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // PowerShell 自己只回 0 / 1：把程序的退出码原样传回来，命令本身出错也算失败。
          // 用换行接在命令后面：命令末尾带 # 注释时不会把后面一起注释掉
          `${c.command}\n$ok = $?; if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $ok) { exit 1 }`,
        ]
      : ['-c', c.command]
  await detectOemCodePage()
  return new Promise(resolve => {
    let output = ''
    let timedOut = false
    const env = { ...childEnvironment([], null), CI: '1' }
    const child = spawn(shell, args, {
      cwd: root,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const pid = child.pid
    if (pid && process.platform !== 'win32') running.add(pid)
    const decoders = [new ConsoleLineDecoder(), new ConsoleLineDecoder()]
    const take = (decoder: ConsoleLineDecoder) => (chunk: Buffer) => {
      output = (output + decoder.write(chunk)).slice(-OUTPUT_CHARS * 2)
    }
    child.stdout?.on('data', take(decoders[0]))
    child.stderr?.on('data', take(decoders[1]))
    const timer = setTimeout(() => {
      timedOut = true
      if (!pid) return
      if (process.platform === 'win32')
        void runProgram('taskkill.exe', ['/PID', String(pid), '/T', '/F'], undefined, 6000).catch(() => {})
      else
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* 已经退出 */
        }
    }, left)
    const done = (status: CheckCommandResult['status'], exitCode: number | null, extra = '') => {
      clearTimeout(timer)
      if (pid) running.delete(pid)
      output += decoders.map(d => d.end()).join('')
      resolve({
        ...base,
        status,
        exitCode,
        ms: Date.now() - started,
        output: redact((output + extra).trimEnd(), []).slice(-OUTPUT_CHARS),
      })
    }
    child.once('error', error => done('error', null, `\n${error.message}`))
    child.once('close', code => done(timedOut ? 'timeout' : code === 0 ? 'pass' : 'fail', code))
  })
}

interface ChecksData {
  projects: Record<string, CheckConfig>
  /** 打开了「做完自动检查」的会话 */
  sessions: string[]
}

/** 项目的检查设置、会话的自动检查开关，和按目录排队的检查 */
export class Checks {
  readonly store: JsonStore<ChecksData>
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(
    dir: string,
    private readonly host: ToolsHost,
  ) {
    this.store = new JsonStore(join(dir, 'checks.json'), { projects: {}, sessions: [] })
  }

  init(): Promise<void> {
    return this.store.init()
  }

  async plan(ref: WorkspaceRef): Promise<CheckPlan> {
    const target = this.host.resolve(ref)
    // 旧版存的设置没有 page
    const config = { ...DEFAULT_CHECK_CONFIG, ...this.store.data.projects[target.projectId] }
    const detected = await detectChecks(target.path)
    const commands = config.commands
      ? config.commands.map(command => ({ label: command.split(/\s+/).slice(-1)[0] ?? command, command }))
      : detected
    return { config, detected, commands }
  }

  async saveConfig(projectId: string, raw: unknown): Promise<CheckPlan> {
    this.host.resolve({ projectId })
    const config = cleanCheckConfig(raw)
    await this.store.transaction(data => {
      data.projects[projectId] = config
    })
    return this.plan({ projectId })
  }

  sessionEnabled(sessionId: string): boolean {
    return this.store.data.sessions.includes(sessionId)
  }

  async setSession(sessionId: string, on: boolean): Promise<boolean> {
    await this.store.transaction(data => {
      data.sessions = data.sessions.filter(id => id !== sessionId)
      if (on) data.sessions.push(sessionId)
    })
    return on
  }

  /**
   * 跑一次检查：命令一条条跑（合计最长 10 分钟），再做文本检查。
   * when = 'channel' 时项目设置关了频道检查就不跑（返回 null）；没有命令、文本检查也关了时同样 null
   */
  async run(
    ref: WorkspaceRef,
    opts: { files?: string[] | null; when?: 'channel' | 'session' } = {},
  ): Promise<CheckRun | null> {
    const target = this.host.resolve(ref)
    const plan = await this.plan(ref)
    if (opts.when === 'channel' && !plan.config.channel) return null
    if (!plan.commands.length && !plan.config.text) return null
    const key = posix.normalize(target.path.replace(/\\/g, '/')).toLowerCase()
    const before = this.queues.get(key) ?? Promise.resolve()
    const job = before
      .catch(() => {})
      .then(async () => {
        const run: CheckRun = { id: randomUUID(), at: Date.now(), status: 'running', items: [] }
        const deadline = Date.now() + CHECK_TIMEOUT_MS
        for (const c of plan.commands) run.items.push(await runCommand(target.path, c, deadline))
        // 改动记录里的路径可能是绝对路径：换成相对项目目录；不在项目里的不看
        const files = opts.files
          ?.map(f => (isAbsolute(f) ? relative(target.path, f) : f).replace(/\\/g, '/'))
          .filter(f => f && !f.startsWith('../'))
        if (plan.config.text) run.items.push(await textChecks(target.path, files))
        return { ...run, status: 'done' as const, endedAt: Date.now() }
      })
    this.queues.set(key, job)
    try {
      return await job
    } finally {
      if (this.queues.get(key) === job) this.queues.delete(key)
    }
  }
}
