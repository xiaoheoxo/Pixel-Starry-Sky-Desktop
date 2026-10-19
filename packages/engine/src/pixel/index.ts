import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codedError,
  type AgentRuns,
  type EngineCatalog,
  type EngineInfo,
  type Item,
  type SessionRecord,
  viaGateway,
} from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, Launcher, SessionContext } from '../adapter'
import { engineEnv, systemProxyEnv } from '../env'
import { startupReason } from '../exec'
import { engineBase } from '../registry'
import { runsFromSession } from './agents'
import { customPixel, discoverPixel, pixelEnvironment } from './discover'
import { pixelCatalog } from './catalog'
import { PixelProcess } from './process'
import { PixelSession, reservedPixelArg, type PixelLaunchOptions } from './session'
import { transcriptItems } from './transcript'

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
  /** 测试里直接给启动方式（不查找、不跑 --version） */
  launcher?: Launcher
  launchOptions?: () => PixelLaunchOptions
}

export class PixelAdapter implements EngineAdapter {
  private cached: { info: EngineInfo; launcher: Launcher | null } | null = null
  private detecting: Promise<EngineInfo> | null = null
  private catalogCache: EngineCatalog | null = null
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
      return this.catalogCache
    } catch (error) {
      info.launchError = startupReason(tail) || (error as Error).message
      return empty
    } finally {
      await proc.close()
      rmSync(cwd, { recursive: true, force: true })
    }
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
    const env = pixelEnvironment(result.launcher, this.env())
    const record = ctx.record()
    if (viaGateway(record)) {
      // 平台 / 自定义 API 会话：不带本机的密钥，只用宿主给的网关环境
      for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_)/i.test(key)) delete env[key]
      Object.assign(env, this.opts.sessionEnv?.(record) ?? {})
    }
    return new PixelSession(result.launcher, env, ctx, this.opts.launchOptions?.() ?? {})
  }
}
