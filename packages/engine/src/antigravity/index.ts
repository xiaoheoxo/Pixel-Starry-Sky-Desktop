// Antigravity CLI 引擎（agy acp，docs/antigravity-engine.md）：检测、安装、更新、模型目录、会话（session.ts）
import type { EngineCatalog, EngineInfo, EngineUpdateResult } from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, Launcher, LoginProcess, SessionContext } from '../adapter'
import { engineEnv, systemProxyEnv } from '../env'
import { outputTail, runInteractive, runStream } from '../exec'
import { agyCatalog, agyInstaller, agyLogout, agyOneShot, customAgy, discoverAgy, probeAgyAuth } from './discover'
import { OneShotError, type OneShotReply, type OneShotRequest } from '../oneshot'
import { AntigravitySession, type AgyLaunch } from './session'
import { agyNativeSessions, agyProjectDirs, agyReadNative } from './native'
import type { ListOptions, NativeRead, NativeSessionList, ReadOptions } from '../native/types'

/** 官方安装器的更新服务（install.ps1 里的 DOWNLOAD_BASE_URL） */
const AGY_UPDATER = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'

export interface AntigravityAdapterOptions {
  /** 用户在设置里替换的命令 */
  overridePath?: () => string | null
  env?: NodeJS.ProcessEnv
  /** 设置 › 本机引擎里填的环境变量（GEMINI_API_KEY、GOOGLE_GEMINI_BASE_URL 等） */
  extraEnv?: () => Record<string, string>
  systemProxy?: () => string | null
  /** 追加的启动参数（agy acp 后面） */
  launchArgs?: () => string[]
  /** 设置 › 本机引擎里的对话 / 上下文开关（提问、自动列任务、压缩阈值） */
  launchOptions?: () => AgyLaunch
  /** 查最新版本用的 fetch（桌面端是 net.fetch，走系统代理） */
  fetch?: typeof fetch
  /** 测试用：替换探登录 */
  probe?: typeof probeAgyAuth
}

export class AntigravityAdapter implements EngineAdapter {
  private cached: { info: EngineInfo; launcher: Launcher | null } | null = null
  private detecting: Promise<EngineInfo> | null = null
  constructor(private readonly opts: AntigravityAdapterOptions = {}) {}

  private env(): NodeJS.ProcessEnv {
    const base = engineEnv(this.opts.env ?? process.env)
    const extra = this.opts.extraEnv?.() ?? {}
    return { ...base, ...extra, ...systemProxyEnv(base, extra, this.opts.systemProxy?.() ?? null) }
  }

  checkLaunch(command: string | null): void {
    if (!command) return
    const custom = customAgy(command, this.env())
    if ('error' in custom) throw new Error(custom.error)
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
    const env = this.env()
    const found = await discoverAgy(this.opts.overridePath?.() ?? null, env)
    if (found.info.status === 'ready' && found.launcher) {
      try {
        const auth = await (this.opts.probe ?? probeAgyAuth)(found.launcher, this.opts.launchArgs?.() ?? [], env)
        if (auth.signedIn) found.info.auth = { kind: auth.kind }
        else
          Object.assign(found.info, {
            status: 'unauthenticated',
            message: '还没登录：在终端运行 agy 用 Google 账号登录，或在下面的环境变量里填 GEMINI_API_KEY',
          })
      } catch (error) {
        // 握手失败（进程起不来、超时）：程序本身能跑，按可用算，把原因放进启动错误给设置页看
        found.info.launchError = (error as Error).message
      }
    }
    this.cached = found
    this.catalogCache = null
    return found.info
  }

  /** agy 自己分配会话 id（session/new 返回），宿主不预先塞 */
  readonly enginePicksSessionId = true

  createSession(ctx: SessionContext): EngineSession {
    const result = this.cached
    if (!result?.launcher || result.info.status === 'missing' || result.info.status === 'outdated')
      throw new Error(result?.info.message ?? 'Antigravity CLI is unavailable')
    return new AntigravitySession(
      result.launcher,
      this.env(),
      ctx,
      this.opts.launchArgs?.() ?? [],
      this.opts.launchOptions?.() ?? { askQuestions: true, autoPlan: true, autoCompactPct: null },
    )
  }

  /**
   * 模型目录：agy models 要 Google 登录（Key 不行），所以起一个临时 ACP 会话读 configOptions 和 availableModels
   * （「模型-档位」组合 id 里看出每个模型有哪几档），读完关掉。结果缓存；没装好、没登录时给空目录
   */
  async catalog(force = false): Promise<EngineCatalog> {
    const info = await this.info(force)
    if (this.catalogCache && !force) return this.catalogCache
    const empty: EngineCatalog = { outputStyles: [], currentOutputStyle: null }
    const launcher = this.cached?.launcher
    if (!launcher || info.status !== 'ready') return empty
    try {
      this.catalogCache = await agyCatalog(launcher, this.opts.launchArgs?.() ?? [], this.env())
      return this.catalogCache
    } catch (error) {
      info.launchError = (error as Error).message
      return empty
    }
  }
  private catalogCache: EngineCatalog | null = null

  /**
   * 授权登录：agy acp --login 印出 Google 授权网址，等用户粘贴授权码（LoginProcess.write）；只有这一种方式，
   * method 不区分。登录完宿主重新检测
   */
  async login(_method: 'browser' | 'device', onLine: (line: string) => void): Promise<LoginProcess> {
    await this.info()
    const launcher = this.cached?.launcher
    if (!launcher) throw new Error(this.cached?.info.message ?? '没找到 Antigravity CLI')
    return runInteractive(launcher, ['acp', '--login'], this.env(), onLine)
  }

  /** 接着终端里用过的 agy 会话：列出这个项目的（session/list） */
  async nativeSessions(cwd: string, opts?: ListOptions): Promise<NativeSessionList> {
    const launcher = await this.readyLauncher()
    return agyNativeSessions(launcher, this.opts.launchArgs?.() ?? [], this.env(), cwd, opts)
  }

  /** 把 agy 的一个会话读成条目（session/load 回放） */
  async readNativeSession(cwd: string, id: string, opts?: ReadOptions): Promise<NativeRead | null> {
    const launcher = await this.readyLauncher()
    return agyReadNative(launcher, this.opts.launchArgs?.() ?? [], this.env(), cwd, id, opts)
  }

  /** 用过的工作目录（设置 › 项目 › 从其他工具导入） */
  async nativeProjects(): Promise<string[]> {
    return agyProjectDirs(await this.readyLauncher(), this.opts.launchArgs?.() ?? [], this.env())
  }

  private async readyLauncher(): Promise<Launcher> {
    const info = await this.info()
    const launcher = this.cached?.launcher
    if (!launcher || info.status !== 'ready') throw new Error(info.message ?? 'Antigravity 不可用')
    return launcher
  }

  /** 不带会话问一次（AI 写提交信息等，「Google 账号」通道） */
  async oneShot(req: OneShotRequest, signal: AbortSignal): Promise<OneShotReply> {
    const info = await this.info()
    const launcher = this.cached?.launcher
    if (!launcher || info.status === 'missing' || info.status === 'outdated')
      throw new OneShotError('notInstalled', info.message ?? '没找到 Antigravity CLI')
    if (info.status === 'unauthenticated')
      throw new OneShotError('notAuthorized', info.message ?? 'Antigravity 没有登录')
    if (info.status !== 'ready') throw new OneShotError('failed', info.message ?? 'Antigravity 不可用')
    return agyOneShot(launcher, this.opts.launchArgs?.() ?? [], this.env(), req, signal)
  }

  /** 取消授权：退出 Google 登录（环境变量里的 GEMINI_API_KEY 不动，有它时宿主会提示仍可用） */
  async logout(): Promise<EngineUpdateResult> {
    await this.info()
    const launcher = this.cached?.launcher
    if (!launcher) throw new Error(this.cached?.info.message ?? '没找到 Antigravity CLI')
    await agyLogout(launcher, this.opts.launchArgs?.() ?? [], this.env())
    return { ok: true, output: '', version: null }
  }

  /** 最新版本：官方安装器读的清单（install.ps1 / install.sh 同一个地址），按本机系统和架构取 */
  async latestVersion(): Promise<string | null> {
    const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
    const res = await (this.opts.fetch ?? fetch)(`${AGY_UPDATER}/manifests/${os}_${arch}.json`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const version = ((await res.json()) as { version?: unknown }).version
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : null
  }

  /** Windows 上 agy.exe 被会话进程占着时换不掉：宿主先关空闲的进程，有任务在跑就不更新 */
  readonly updateNeedsIdle = true

  /** agy update：官方自更新 */
  async update(onLine: (line: string) => void = () => undefined): Promise<EngineUpdateResult> {
    const launcher = this.cached?.launcher ?? (await this.info(true), this.cached?.launcher)
    if (!launcher) throw new Error('没找到 Antigravity CLI')
    const r = await runStream(launcher, ['update'], this.env(), 10 * 60_000, onLine)
    return { ok: r.ok, output: outputTail(r), version: null }
  }

  /** 官方安装器（install.ps1 / install.sh）：放到 %LOCALAPPDATA%\agy\bin 或 ~/.local/bin，检测本来就会找那里 */
  async install(onLine: (line: string) => void = () => undefined): Promise<EngineUpdateResult> {
    const env = this.env()
    const installer = agyInstaller(env)
    if (!installer) throw new Error('没找到 PowerShell / curl，请按提示在终端安装 Antigravity CLI')
    const r = await runStream(installer, [], env, 10 * 60_000, onLine)
    return { ok: r.ok, output: outputTail(r), version: null }
  }
}
