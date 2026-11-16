import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import {
  codedError,
  type AgentRuns,
  type EngineCatalog,
  type EngineInfo,
  type Item,
  type ExtensionLaunch,
  type SessionRecord,
  type TuiMark,
  viaGateway,
} from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, Launcher, SessionContext, TuiLaunch } from '../adapter'
import { logger } from '../log'
import type { NewerTurns } from '../native/types'
import type { NodeRuntime } from '../npm'
import { engineEnv, systemProxyEnv } from '../env'
import { resolveCommand, startupReason, removeTree } from '../exec'
import { engineBase } from '../registry'
import { runsFromSession } from './agents'
import { customPixel, discoverPixel, pixelEnvironment, pixelShell } from './discover'
import { pixelCatalog } from './catalog'
import { PixelProcess, object, string } from './process'
import {
  ALLOW_TOOLS_ENV,
  applyPixelModels,
  MCP_FILE_ENV,
  PixelSession,
  pixelLaunch,
  reservedPixelArg,
  type PixelLaunchOptions,
} from './session'
import { pixelSideModel, pixelSideQuestion } from './side'
import { transcriptItems } from './transcript'
import { findNode, markOfFile, needsRealNode, pixelTuiArgs, privateNode, readSinceMark } from './tui'

const log = logger('engine.pixel')

/** 自动压缩阈值交给命令行的环境变量：Pi 补丁里的 shouldCompact 读它（patches/@earendil-works__pi-coding-agent@1.4.0.patch，docs/own-cli.md §15） */
export const AUTO_COMPACT_ENV = 'PIXELSKY_AUTOCOMPACT_PCT'

export interface PixelAdapterOptions {
  /** 用户在设置里替换的命令（脚本入口或可执行文件，绝对路径或 PATH 上的命令名） */
  overridePath?: () => string | null
  /** 自带的命令行入口（开发时是 packages/cli/src/cli.ts，桌面端打包后传自带的文件）；比 PATH 上的 pixelsky 优先 */
  bundledCli?: string | null
  env?: NodeJS.ProcessEnv
  extraEnv?: () => Record<string, string>
  /** 系统代理（http://主机:端口）；没开代理、开关关了时为 null。用户自己设了代理变量时不用（env.ts systemProxyEnv） */
  systemProxy?: () => string | null
  sessionEnv?: (record: SessionRecord) => NodeJS.ProcessEnv
  /** 私有 Node.js（node-runtime.ts）：终端模式跑命令行用，找不到别的 Node 时下载（docs/ui/tui-toggle.md §12.3） */
  nodeRuntime?: NodeRuntime
  /** 测试里直接给启动方式（不查找、不跑 --version） */
  launcher?: Launcher
  launchOptions?: () => PixelLaunchOptions
  /** 测试用：替换 Windows 上的 shell 检查（discover.ts pixelShell） */
  shell?: (env: NodeJS.ProcessEnv) => { pathDir?: string; warning?: string }
}

export class PixelAdapter implements EngineAdapter {
  private cached: { info: EngineInfo; launcher: Launcher | null } | null = null
  private detecting: Promise<EngineInfo> | null = null
  private catalogCache: EngineCatalog | null = null
  /** Windows 上命令工具要用的 Git Bash（检测时定下，见 discover.ts pixelShell） */
  private shell: { pathDir?: string; warning?: string } = {}
  constructor(private readonly opts: PixelAdapterOptions = {}) {}

  private env(): NodeJS.ProcessEnv {
    const base = engineEnv(this.opts.env ?? process.env)
    const extra = this.opts.extraEnv?.() ?? {}
    // 补的代理变量放最后：只在用户没设代理时才有，NO_PROXY 已经并进了用户原有的
    return { ...base, ...extra, ...systemProxyEnv(base, extra, this.opts.systemProxy?.() ?? null) }
  }
  checkLaunch(command: string | null, args: readonly string[]): void {
    if (command) {
      const custom = customPixel(command, this.env())
      if ('error' in custom) throw new Error(custom.error)
    }
    const reserved = reservedPixelArg(args)
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
            ...engineBase('pixel'),
            status: 'ready' as const,
            version: null,
            path: this.opts.launcher.command,
            message: null,
          },
          launcher: this.opts.launcher,
        }
      : await discoverPixel(this.opts.overridePath?.() ?? null, this.env(), this.opts.bundledCli ?? null)
    // Windows 上 Pi 找不到 Git Bash：装在别处的放到会话进程的 PATH 最前面；没装的（或只有 WSL 的 bash）放进设置 › 本机引擎的配置提示
    this.shell = result.info.status === 'ready' ? (this.opts.shell ?? pixelShell)(this.env()) : {}
    if (this.shell.warning) result.info.configWarnings = [this.shell.warning]
    this.cached = result
    this.catalogCache = null
    return result.info
  }
  /**
   * 模型目录：起一个临时的 RPC 进程问 get_available_models（不发消息、不花钱），结果缓存；
   * 没装好或起不来时给空目录，不影响引擎状态
   */
  async catalog(force = false): Promise<EngineCatalog> {
    const info = await this.info(force)
    if (this.catalogCache && !force) return this.catalogCache
    const launcher = this.cached?.launcher
    const empty: EngineCatalog = { outputStyles: [], currentOutputStyle: null }
    if (!launcher || info.status !== 'ready') return empty
    // 在临时空目录里启动：不让 Pi 读到某个项目里的上下文文件
    const cwd = mkdtempSync(join(tmpdir(), 'pixelsky-pixel-catalog-'))
    let tail = ''
    const proc = new PixelProcess(
      launcher,
      ['--mode', 'rpc', '--permission-mode', 'default', ...(this.opts.launchOptions?.().args ?? [])],
      cwd,
      pixelEnvironment(launcher, this.env()),
      { event() {}, exit: (_code, stderr) => (tail = stderr) },
    )
    try {
      this.catalogCache = (await pixelCatalog(proc)).catalog
      // 这次起得来：清掉以前失败时记下的启动错误（info 是缓存的那份）
      delete info.launchError
      return this.catalogCache
    } catch (error) {
      info.launchError = startupReason(tail) || (error as Error).message
      return empty
    } finally {
      await proc.close()
      // Windows 上目录可能还被占着（EBUSY / EPERM）：删不掉就留给系统清，不能盖掉已经拿到的结果
      try {
        removeTree(cwd)
      } catch {
        // 留下的空临时目录无害
      }
    }
  }
  /**
   * Pi 的会话文件还在不在（引擎会话 id 就是会话文件路径）：不在时宿主派发前把整段聊天交接进新会话（handoff.ts）。
   * 还没有会话、id 不是路径（看不出来）时按在算
   */
  hasNativeSession(record: SessionRecord): boolean {
    const file = record.engineSessionId
    return !file || !isAbsolute(file) || existsSync(file)
  }
  /** 智能体追踪：子智能体记在 Pi 主会话文件里（引擎会话 id 就是会话文件路径） */
  loadRuns(record: SessionRecord): AgentRuns {
    return {
      workflows: [],
      agents: runsFromSession(record.engineSessionId ?? '').map(({ sessionFile: _, ...run }) => run),
    }
  }
  subagentTranscript(record: SessionRecord, agentId: string): Item[] {
    const run = runsFromSession(record.engineSessionId ?? '').find(r => r.id === agentId)
    if (!run?.sessionFile) throw new Error('Subagent transcript not found')
    return transcriptItems(run.sessionFile, record.cwd)
  }

  createSession(ctx: SessionContext): EngineSession {
    const result = this.cached
    if (!result?.launcher || result.info.status !== 'ready')
      throw new Error(result?.info.message ?? 'Pixel is unavailable')
    const launch = this.opts.launchOptions?.() ?? {}
    const env = this.sessionEnvironment(result.launcher, ctx.record())
    // 只给会话进程：旁聊是复制出来的会话文件，问一次就丢，不该花钱压缩
    if (launch.autoCompactPct) env[AUTO_COMPACT_ENV] = String(launch.autoCompactPct)
    return new PixelSession(result.launcher, env, ctx, launch)
  }

  /** 旁聊：复制会话文件单独问一次（side.ts），不用工具，不改原会话；MCP、技能都不带 */
  async sideQuestion(record: SessionRecord, prompt: string, signal: AbortSignal): Promise<string> {
    await this.info()
    const result = this.cached
    if (!result?.launcher || result.info.status !== 'ready')
      throw new Error(result?.info.message ?? 'Pixel is unavailable')
    const file = record.engineSessionId
    if (!file || !isAbsolute(file)) throw new Error('先在主对话里发一条消息')
    const env = this.sessionEnvironment(result.launcher, record)
    applyPixelModels(env, record, this.opts.launchOptions?.().contextWindows)
    delete env[MCP_FILE_ENV]
    delete env[ALLOW_TOOLS_ENV]
    return pixelSideQuestion({
      launcher: result.launcher,
      sessionFile: file,
      cwd: record.cwd,
      env,
      model: pixelSideModel(record),
      userArgs: this.opts.launchOptions?.().args,
      prompt,
      signal,
    })
  }

  /**
   * 终端模式找不到现成的 Node，切过去要先下载私有的（界面提示用，不拦）。只看文件在不在，版本切的时候再查
   */
  tuiNeedsNode(): boolean {
    const launcher = this.cached?.launcher
    if (!launcher || !needsRealNode(launcher)) return false
    return !privateNode(this.opts.nodeRuntime?.paths() ?? []) && !resolveCommand('node', this.env()).ok
  }

  /** 切到终端时记下会话文件的叶子（新对话的文件还没写出来，叶子为空） */
  async tuiMark(_cwd: string, file: string): Promise<TuiMark | null> {
    return markOfFile(file)
  }

  /** 切回时沿 parentId 从当前叶子走回记下的叶子（tui.ts sinceLeaf） */
  async newerSinceMark(cwd: string, file: string, mark: TuiMark): Promise<NewerTurns | null> {
    return readSinceMark(file, mark, cwd)
  }

  /**
   * 终端（TUI）模式（docs/ui/tui-toggle.md §12.3）：<node> <命令行> … --session <会话文件>，参数和 env 跟会话进程同一份（pixelLaunch）。
   * 新对话还没有会话文件：起一次临时 RPC 进程问 Pi 会把文件放在哪（不发消息），终端里 --session 这个路径就在那里新建
   */
  async tuiLaunch(record: SessionRecord, extensions?: ExtensionLaunch): Promise<TuiLaunch> {
    await this.info()
    const result = this.cached
    if (!result?.launcher || result.info.status !== 'ready')
      throw new Error(result?.info.message ?? 'Pixel is unavailable')
    const options = this.opts.launchOptions?.() ?? {}
    const launch = pixelLaunch(
      this.sessionEnvironment(result.launcher, record),
      record,
      record.permissionMode,
      extensions,
      options,
    )
    const file = record.engineSessionId || (await this.newSessionFile(result.launcher, launch, record.cwd))
    const launcher = await this.tuiLauncher(result.launcher)
    const env = { ...launch.env }
    // 真正的 Node 不需要；留着会传给终端里跑的命令（里面要是起 Electron 程序会当成 Node）
    if (launcher !== result.launcher) delete env.ELECTRON_RUN_AS_NODE
    if (options.autoCompactPct) env[AUTO_COMPACT_ENV] = String(options.autoCompactPct)
    return {
      command: launcher.command,
      args: [...launcher.args, ...pixelTuiArgs(record, file, launch.args)],
      env,
      cwd: record.cwd,
      engineSessionId: file,
    }
  }

  /** 新对话：临时 RPC 进程的 get_state.sessionFile（Pi 按用户的会话目录设置算好的路径，第一次回复后才写文件） */
  private async newSessionFile(
    launcher: Launcher,
    launch: { args: string[]; env: NodeJS.ProcessEnv },
    cwd: string,
  ): Promise<string> {
    let tail = ''
    const proc = new PixelProcess(launcher, ['--mode', 'rpc', ...launch.args], cwd, launch.env, {
      event() {},
      exit: (_code, stderr) => (tail = stderr),
    })
    try {
      const file = string(object((await proc.request('get_state')).data).sessionFile)
      if (!file) throw new Error('Pixel 没给出会话文件')
      return file
    } catch (error) {
      throw new Error(startupReason(tail) || (error as Error).message)
    } finally {
      await proc.close()
    }
  }

  /** 自带命令行是用 Electron 跑的脚本：终端里换成私有 Node / 系统 Node，都没有就下载私有的 */
  private async tuiLauncher(launcher: Launcher): Promise<Launcher> {
    if (!needsRealNode(launcher)) return launcher
    const runtime = this.opts.nodeRuntime
    let node = await findNode(this.env(), runtime?.paths() ?? [])
    if (!node && runtime) node = (await runtime.ensure(line => log.info('终端模式下载 Node.js', { line }))).node
    if (!node) throw new Error('终端模式要用 Node.js 22.19 以上，请先安装 Node.js')
    return { command: node, args: launcher.args }
  }

  /** 会话进程的环境：Git Bash、宿主给的网关 / 子智能体设置；网关会话去掉本机的密钥 */
  private sessionEnvironment(launcher: Launcher, record: SessionRecord): NodeJS.ProcessEnv {
    const env = pixelEnvironment(launcher, this.env())
    if (this.shell.pathDir) {
      // Pi 在 PATH 上找 bash.exe：Git 的 bin 放在最前面，免得找到 System32 的 WSL bash
      const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
      env[key] = [this.shell.pathDir, env[key] ?? ''].filter(Boolean).join(delimiter)
    }
    // 宿主给的环境：网关会话是网关地址和会话密钥；自有会话也要，里面有子智能体设置（不含密钥）
    const hostEnv = this.opts.sessionEnv?.(record) ?? {}
    // 平台 / 自定义 API 会话：不带本机的密钥，只用宿主给的网关环境
    if (viaGateway(record)) for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_)/i.test(key)) delete env[key]
    Object.assign(env, hostEnv)
    return env
  }
}
