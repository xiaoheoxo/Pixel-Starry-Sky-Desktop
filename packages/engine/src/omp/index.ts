// oh-my-pi（omp，用户自己装的引擎，docs/omp-engine.md）：协议和 Pi 同源，会话复用 PixelSession（flavor: 'omp'）
import { existsSync, mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, parse } from 'node:path'
import {
  codedError,
  viaGateway,
  type AgentRuns,
  type EngineCatalog,
  type EngineInfo,
  type EngineUpdateResult,
  type ExtensionLaunch,
  type Item,
  type SessionRecord,
  type TuiMark,
} from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, Launcher, RewindAnchor, SessionContext, TuiLaunch } from '../adapter'
import type { ListOptions, NativeRead, NativeSessionList, NewerTurns, ReadOptions } from '../native/types'
import { markOfFile, readSinceMark } from '../pixel/tui'
import { engineEnv, systemProxyEnv } from '../env'
import { crashReason, outputTail, pathValue, removeTree, run, runStream, startupReason } from '../exec'
import { engineBase } from '../registry'
import { pixelCatalog } from '../pixel/catalog'
import { PixelProcess, object, string } from '../pixel/process'
import { PixelSession, negotiateOmp, ompStartupHint, type PixelLaunchOptions } from '../pixel/session'
import { transcriptItems } from '../pixel/transcript'
import { ompAgentFile, ompRunsFromSession } from './agents'
import { ompAnchor } from './branch'
import { customOmp, discoverOmp, ompInstaller } from './discover'
import { writeOmpGateway } from './gateway-ext'
import { ompNativeSessions, ompReadNative, ompCwd, ompSessionFile } from './native'
import { ompApproval, ompLaunch, ompTuiArgs, reservedOmpArg } from './launch'
import { ompOverlayText, writeOmpOverlay } from './overlay'
import { writeOmpPlan } from './plan-ext'
import { ompSideQuestion } from './side'
import { cleanOmpPlugins, writeOmpPlugin } from './plugin-dir'
import { writeOmpSubagents } from './subagent-ext'
import { writeOmpTools } from './tools-ext'
import { writeOmpTurn } from './turn-ext'

export interface OmpAdapterOptions {
  /** 用户在设置里替换的命令 */
  overridePath?: () => string | null
  env?: NodeJS.ProcessEnv
  extraEnv?: () => Record<string, string>
  systemProxy?: () => string | null
  /** 平台 / 自定义 API 会话的网关环境（platform.ts sessionEnv，同像素星空引擎） */
  sessionEnv?: (record: SessionRecord) => NodeJS.ProcessEnv
  launchOptions?: () => Pick<PixelLaunchOptions, 'args' | 'contextWindows'>
  /** 应用数据目录：网关扩展写在 <dataDir>/omp/ 下；没给时用临时目录 */
  dataDir?: string
  /** 测试里直接给启动方式（不查找、不跑 --version） */
  launcher?: Launcher
}

export class OmpAdapter implements EngineAdapter {
  private cached: { info: EngineInfo; launcher: Launcher | null } | null = null
  private detecting: Promise<EngineInfo> | null = null
  private catalogCache: EngineCatalog | null = null
  private extensionFile: string | null = null
  private dir: string | null = null
  /** 各对话最近创建的会话对象（按会话记录 id）：旁聊优先在它的进程里用 btw 问 */
  private readonly live = new Map<string, PixelSession>()
  constructor(private readonly opts: OmpAdapterOptions = {}) {}

  private env(): NodeJS.ProcessEnv {
    const base = engineEnv(this.opts.env ?? process.env)
    const extra = this.opts.extraEnv?.() ?? {}
    return { ...base, ...extra, ...systemProxyEnv(base, extra, this.opts.systemProxy?.() ?? null) }
  }
  checkLaunch(command: string | null, args: readonly string[]): void {
    if (command) {
      const custom = customOmp(command, this.env())
      if ('error' in custom) throw new Error(custom.error)
    }
    const reserved = reservedOmpArg(args)
    if (reserved) throw codedError('launch.reserved', { arg: reserved })
  }
  async info(force = false): Promise<EngineInfo> {
    if (this.cached && !force) return this.cached.info
    if (this.detecting) return this.detecting
    this.detecting = this.detect().finally(() => {
      this.detecting = null
    })
    return this.detecting
  }
  private async detect(): Promise<EngineInfo> {
    const result = this.opts.launcher
      ? {
          info: {
            ...engineBase('omp'),
            status: 'ready' as const,
            version: null,
            path: this.opts.launcher.command,
            message: null,
          },
          launcher: this.opts.launcher,
        }
      : await discoverOmp(this.opts.overridePath?.() ?? null, this.env())
    this.cached = result
    this.catalogCache = null
    return result.info
  }

  /** npm 上的版本和官方安装器给的稳定版一致（docs/omp-engine.md §14） */
  readonly npmPackage = '@oh-my-pi/pi-coding-agent'
  /** 正在跑也换得了文件；先关空闲的进程，下一条消息就用新版本 */
  readonly updateNeedsIdle = true

  /** omp update：安装器、Homebrew、mise、bun、npm 装的它自己认。它按 PATH 找自己，所以把这份的目录放到最前 */
  async update(onLine: (line: string) => void = () => undefined): Promise<EngineUpdateResult> {
    const launcher = this.cached?.launcher ?? (await this.info(true), this.cached?.launcher)
    if (!launcher) throw new Error('没找到 oh-my-pi')
    if (parse(launcher.command).name.toLowerCase() !== 'omp') throw new Error('自定义的命令不叫 omp，没法在软件里更新')
    const base = this.env()
    const env = Object.fromEntries(Object.entries(base).filter(([k]) => k.toUpperCase() !== 'PATH'))
    env.PATH = dirname(launcher.command) + delimiter + pathValue(base)
    const r = await runStream(launcher, ['update'], env, 10 * 60_000, onLine)
    // Nix、别的软件管着的：只打印一句，退出码仍是 0
    const managed = /cannot update itself|installed and kept up to date by/.test(r.stdout)
    return { ok: r.ok && !managed, output: outputTail(r), version: null }
  }

  /** 官方安装器：放到 %LOCALAPPDATA%\omp 或 ~/.local/bin，检测本来就会找那里 */
  async install(onLine: (line: string) => void = () => undefined): Promise<EngineUpdateResult> {
    const env = this.env()
    const installer = ompInstaller(env)
    if (!installer) throw new Error('没找到 PowerShell / curl，请按提示在终端安装 oh-my-pi')
    const r = await runStream(installer, [], env, 10 * 60_000, onLine)
    return { ok: r.ok, output: outputTail(r), version: null }
  }

  /** 模型目录：起一个临时 RPC 进程问 get_available_models（不发消息、不花钱），结果缓存（同像素星空引擎） */
  async catalog(force = false): Promise<EngineCatalog> {
    const info = await this.info(force)
    if (this.catalogCache && !force) return this.catalogCache
    const empty: EngineCatalog = { outputStyles: [], currentOutputStyle: null }
    if (!this.cached?.launcher || info.status !== 'ready') return empty
    try {
      this.catalogCache = await this.probe(async proc => (await pixelCatalog(proc, true)).catalog)
      delete info.launchError
      return this.catalogCache
    } catch (error) {
      info.launchError = (error as Error).message
      return empty
    }
  }

  /** 起一个临时 RPC 进程问点东西（不发消息），问完关掉；顺便记下 omp 的会话目录 */
  private async probe<T>(ask: (proc: PixelProcess) => Promise<T>): Promise<T> {
    const launcher = this.launcher()
    const cwd = mkdtempSync(join(tmpdir(), 'pixelsky-omp-catalog-'))
    let tail = ''
    const proc = new PixelProcess(
      launcher,
      ['--mode', 'rpc', '--approval-mode', 'always-ask', ...(this.opts.launchOptions?.().args ?? [])],
      cwd,
      this.env(),
      { event() {}, exit: (_code, stderr) => (tail = stderr) },
    )
    try {
      await negotiateOmp(proc)
      const own = string(object((await proc.request('get_state')).data).sessionFile)
      if (own) this.sessions = dirname(dirname(own))
      return await ask(proc)
    } catch (error) {
      throw new Error(ompStartupHint(tail) || startupReason(tail) || (error as Error).message)
    } finally {
      await proc.close()
      try {
        removeTree(cwd)
      } catch {
        // 留下的空临时目录无害
      }
    }
  }

  /** omp 放会话的目录（用户的配置、profile、--profile 参数都会改，问它自己最准）；每个工作目录一个子文件夹 */
  private sessions: string | null = null
  private async sessionsRoot(): Promise<string> {
    await this.info()
    if (!this.sessions) await this.probe(async () => {})
    if (!this.sessions) throw new Error('oh-my-pi 没有给出会话目录')
    return this.sessions
  }

  /** 接着终端里用过的 omp 会话：列出这个项目的 */
  async nativeSessions(cwd: string, opts?: ListOptions): Promise<NativeSessionList> {
    return ompNativeSessions(await this.sessionsRoot(), cwd, opts)
  }

  /** 读一个会话当前分支的条目；id 是会话 id 或文件路径 */
  async readNativeSession(_cwd: string, id: string, opts?: ReadOptions): Promise<NativeRead | null> {
    const file = await ompSessionFile(isAbsolute(id) ? '' : await this.sessionsRoot(), id)
    return file ? ompReadNative(file, opts) : null
  }

  /** omp 自己分配会话文件：新会话的 engineSessionId 是 null，起来以后才知道 */
  readonly enginePicksSessionId = true

  /** 回退 / 分叉的截断点（branch.ts）；读不了会话文件按找不到处理 */
  rewindAnchor(record: SessionRecord, userItemIds: string[]): RewindAnchor | null {
    const file = record.engineSessionId
    if (!file || !isAbsolute(file)) return null
    const fork = record.pendingFork
    try {
      return ompAnchor(file, userItemIds, record.pendingRewind ?? (fork?.from === file ? fork.at : null))
    } catch {
      return null
    }
  }

  /** 会话文件还在不在（引擎会话 id 是会话文件路径）；看不出来时按在算 */
  hasNativeSession(record: SessionRecord): boolean {
    const file = record.engineSessionId
    return !file || !isAbsolute(file) || existsSync(file)
  }

  /** 重开应用、换回这个引擎：以前的子智能体从主会话文件读回 */
  loadRuns(record: SessionRecord): AgentRuns {
    const file = record.engineSessionId
    return { workflows: [], agents: file && isAbsolute(file) ? ompRunsFromSession(file, record.pendingRewind) : [] }
  }

  /** 子智能体的对话（只读）；是不是这个会话的由宿主按追踪里的核对 */
  subagentTranscript(record: SessionRecord, agentId: string): Item[] {
    const file = ompAgentFile(record.engineSessionId ?? '', agentId)
    if (!file) throw new Error('这个子智能体还没有对话记录')
    return transcriptItems(file, record.cwd)
  }

  /** omp 自己的 HTML 导出：一条命令读会话文件写出来，不起会话、不花钱；写到临时目录再读回（远程机器也一样） */
  async exportHtml(record: SessionRecord): Promise<string> {
    await this.info()
    const launcher = this.launcher()
    const file = record.engineSessionId
    if (!file || !isAbsolute(file) || !existsSync(file)) throw new Error('先发一条消息，再用 oh-my-pi 导出')
    // 回退要到下一条消息才落实，现在导出的还带着回退掉的
    if (record.pendingRewind) throw new Error('回退之后先发一条消息，再用 oh-my-pi 导出')
    const dir = mkdtempSync(join(tmpdir(), 'pixelsky-omp-export-'))
    try {
      const out = join(dir, 'session.html')
      const result = await run(launcher, ['--export', file, out], this.env(), 120_000, { cwd: dir })
      if (!existsSync(out)) throw new Error(crashReason(result.stderr) || 'oh-my-pi 没有导出成功')
      return await readFile(out, 'utf8')
    } finally {
      try {
        removeTree(dir)
      } catch {
        // 还被占着：留给系统清
      }
    }
  }

  private launcher(): Launcher {
    const result = this.cached
    if (!result?.launcher || result.info.status !== 'ready') throw new Error(result?.info.message ?? 'oh-my-pi 不可用')
    return result.launcher
  }

  /** 会话进程的环境：平台 / 自定义 API 会话不带本机的密钥，只用宿主给的网关环境（会话进程和旁聊共用） */
  private sessionEnvironment(record: SessionRecord): NodeJS.ProcessEnv {
    const env = this.env()
    if (viaGateway(record)) for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_)/i.test(key)) delete env[key]
    Object.assign(env, this.opts.sessionEnv?.(record) ?? {})
    return env
  }

  private launchOptions(record: SessionRecord): PixelLaunchOptions {
    return {
      ...(this.opts.launchOptions?.() ?? {}),
      flavor: 'omp',
      launch: ompLaunch,
      ...(viaGateway(record) ? { extensionFile: this.gatewayFile() } : {}),
      configFile: (settings, isolated, pick) =>
        writeOmpOverlay(this.ompDir(), ompOverlayText(settings, isolated, pick)),
      planFile: writeOmpPlan(this.ompDir()),
      turnFile: () => writeOmpTurn(this.ompDir()),
      toolsFile: () => writeOmpTools(this.ompDir()),
      subagentFile: () => writeOmpSubagents(this.ompDir()),
      pluginDir: ext => writeOmpPlugin(this.pluginRoot(), ext),
      approvalMode: mode => ompApproval(mode),
    }
  }

  /** 终端模式切过去时记下会话文件的叶子（omp 的会话文件和 Pi 同一种：只追加，条目沿 parentId 连起来） */
  async tuiMark(_cwd: string, file: string): Promise<TuiMark | null> {
    return markOfFile(file)
  }

  /** 切回时沿 parentId 从当前叶子走回记下的叶子，补回终端里新聊的 */
  async newerSinceMark(cwd: string, file: string, mark: TuiMark): Promise<NewerTurns | null> {
    return readSinceMark(file, mark, cwd)
  }

  /**
   * 终端模式：omp 自己的交互界面（原生可执行文件，不用 Node），参数和环境跟会话进程同一份（ompLaunch）。
   * 新对话还没有会话文件：omp 的 --resume 打不开不存在的文件（实测报 Session not found），临时 RPC 进程也不会先建出来，
   * 所以要先在界面里发一条消息
   */
  async tuiLaunch(record: SessionRecord, extensions?: ExtensionLaunch): Promise<TuiLaunch> {
    await this.info()
    const launcher = this.launcher()
    const file = record.engineSessionId
    if (!file || !isAbsolute(file) || !existsSync(file))
      throw new Error('oh-my-pi 要先在界面里发一条消息，才能切到终端')
    const { args, env } = ompLaunch(
      this.sessionEnvironment(record),
      record,
      record.permissionMode,
      extensions,
      // 记轮次位置的命令只给会话进程用，终端的菜单里不出现
      { ...this.launchOptions(record), turnFile: undefined },
    )
    return {
      command: launcher.command,
      args: [...launcher.args, ...ompTuiArgs(record, file, args)],
      env,
      cwd: await ompCwd(file, record.cwd),
      engineSessionId: file,
    }
  }

  /** 我们写给 omp 的文件（网关扩展、叠加设置）放应用数据目录，不放共用的临时目录（别的程序改不了） */
  private ompDir(): string {
    if (!this.dir)
      this.dir = this.opts.dataDir ? join(this.opts.dataDir, 'omp') : mkdtempSync(join(tmpdir(), 'pixelsky-omp-'))
    return this.dir
  }

  private plugins: string | null = null
  /** 拼出来的插件目录放这里；第一次用时清掉上次没删成的 */
  private pluginRoot(): string {
    if (!this.plugins) {
      this.plugins = join(this.ompDir(), 'plugins')
      cleanOmpPlugins(this.plugins)
    }
    return this.plugins
  }

  createSession(ctx: SessionContext): EngineSession {
    const launcher = this.launcher()
    const record = ctx.record()
    const session = new PixelSession(launcher, this.sessionEnvironment(record), ctx, this.launchOptions(record))
    for (const [id, s] of this.live) if (s.isClosed) this.live.delete(id)
    this.live.set(record.id, session)
    return session
  }

  /**
   * 旁聊（docs/omp-engine.md §11.6）：这个对话有会话对象时在它的进程里用 btw 问（进程没在跑就先起，续接同一会话），
   * 和 omp 终端里的 /btw 一样记进它的会话文件；这次打开应用后还没起过的，复制会话文件起临时进程问（side.ts）
   */
  async sideQuestion(record: SessionRecord, prompt: string, signal: AbortSignal): Promise<string> {
    const session = this.live.get(record.id)
    if (session && !session.isClosed) return session.ompSide(prompt, signal)
    await this.info()
    const launcher = this.launcher()
    // 分叉出来还没启动的：在来源会话的截断点上问
    const fork = record.engineSessionId ? null : record.pendingFork
    const file = record.engineSessionId ?? fork?.from
    if (!file || !isAbsolute(file)) throw new Error('先在主对话里发一条消息')
    // 旁聊不派子智能体
    const options = { ...this.launchOptions(record), subagentFile: undefined }
    // 权限按每次询问：btw 里模型发起的工具调用 omp 本来就丢掉不执行
    const { args, env } = ompLaunch(this.sessionEnvironment(record), record, 'ask', undefined, options)
    return ompSideQuestion({
      launcher,
      args,
      env,
      record: { ...record, engineSessionId: file },
      at: record.pendingRewind ?? fork?.at,
      gateway: viaGateway(record),
      prompt,
      signal,
    })
  }

  private gatewayFile(): string {
    if (!this.extensionFile || !existsSync(this.extensionFile)) this.extensionFile = writeOmpGateway(this.ompDir())
    return this.extensionFile
  }
}
