import { randomBytes } from 'node:crypto'
import { platformGateway, type GatewaySession } from './gateway'
import { engineProviderProtocols, groupEngines, pixelApi, pixelGatewayEnv, pixelSubagentRoute } from './pixel-env'
import { compactWindows, longContextModels } from './compact-window'
import { once } from 'node:events'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { SessionRecord } from '@pixelsky/protocol'
import {
  CLAUDE_COMPACT_MARKER,
  CODEX_WINDOW_ENV,
  logger,
  LONG_CONTEXT_ENV,
  claudeModelName,
  rewriteCompaction,
  type CompactionRequestReport,
} from '@pixelsky/engine'
import type { PlatformGroupInfo } from '../../shared/types/platform-catalog'
import { platformModelSupportsEngine } from '../../shared/platform-models'
import { platformFetch, signedInEmail } from '../account/account'
import * as ipc from '../ipc/guard'
import type { ProviderStore, ResolvedProvider } from '../core/providers/store'
import { smallModelOf } from '../core/providers/upstream'
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentSettings, type SubagentTarget } from '../../shared/types/subagents'

const log = logger('subagents')

async function jsonRequest(path: string, method = 'GET'): Promise<unknown> {
  const res = await platformFetch(path, { method, signal: AbortSignal.timeout(30_000) })
  const body = (await res.json()) as { data?: unknown; error?: unknown }
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : '平台服务暂时不可用，请刷新重试')
  return body.data
}

/** 最近读到的分组 → platform（openai / anthropic …）；像素星空按它选 Responses 还是 Messages */
const groupPlatforms = new Map<string, string>()
/** 最近读到的分组名：子智能体卡片上写站点名用 */
const groupNames = new Map<string, string>()

export async function platformGroups(): Promise<PlatformGroupInfo[]> {
  const data = await jsonRequest('/v1/platform/groups')
  if (!Array.isArray(data)) throw new Error('平台分组数据格式异常')
  const groups = data.filter(
    (g): g is PlatformGroupInfo =>
      !!g &&
      typeof g.id === 'string' &&
      /^\d+$/.test(g.id) &&
      typeof g.name === 'string' &&
      typeof g.rate_multiplier === 'number' &&
      Number.isFinite(g.rate_multiplier) &&
      g.rate_multiplier >= 0 &&
      Array.isArray(g.models) &&
      g.models.every((m: unknown) => typeof m === 'string'),
  )
  for (const g of groups) {
    groupPlatforms.set(g.id, g.platform)
    groupNames.set(g.id, g.name)
  }
  return groups
}

/** 自定义 API 会话：接口还在、协议对得上引擎、有 Key（docs/ui/custom-api.md §3.3） */
export function checkProvider(record: SessionRecord, providers: ProviderStore | null): ResolvedProvider | null {
  if (!record.provider || record.platform) return null
  const p = providers?.resolve(record.provider.id)
  if (!p) throw new Error('这个会话用的自定义接口已删除，请换一个接口')
  if (!engineProviderProtocols(record.engine).includes(p.protocol)) throw new Error('接口协议与当前引擎不兼容')
  if (!p.apiKey) throw new Error(`自定义接口「${p.name}」还没有 Key，请在设置里填写`)
  return p
}

/** 子智能体单独走的站点现在能不能用；不能用时返回原因（这时子智能体跟随主会话） */
export function checkSubagentTarget(
  target: SubagentTarget,
  providers: ProviderStore | null,
  account: string | null,
): { ok: true; provider: ResolvedProvider | null } | { ok: false; reason: string } {
  if (target.kind === 'custom') {
    const p = providers?.resolve(target.providerId)
    if (!p) return { ok: false, reason: '选的自定义接口已删除' }
    if (!engineProviderProtocols('pixel').includes(p.protocol)) return { ok: false, reason: '接口协议不支持' }
    if (!p.apiKey) return { ok: false, reason: `自定义接口「${p.name}」还没有 Key` }
    if (!p.models.some(m => m.id === target.model)) return { ok: false, reason: `接口里已经没有模型 ${target.model}` }
    return { ok: true, provider: p }
  }
  if (account !== target.account) return { ok: false, reason: '平台账号已退出或切换' }
  if (!platformModelSupportsEngine(target.model, 'pixel')) return { ok: false, reason: '线路协议不支持' }
  return { ok: true, provider: null }
}

/** 排队任务执行前核对身份、当前目录权限与模型；实际请求还会重新检查。 */
export async function validateQueuedInput(record: SessionRecord, providers: ProviderStore | null): Promise<void> {
  checkProvider(record, providers)
  const p = record.platform
  if (!p) return
  if (!platformModelSupportsEngine(record.model, record.engine)) throw new Error('线路协议与当前引擎不兼容')
  if (signedInEmail() !== p.account) throw new Error('平台账号已退出或切换，请登录原账号后重试')
  const groups = await platformGroups()
  const group = groups.find(g => g.id === p.groupId)
  if (!group) throw new Error('排队消息的线路已不可用，请撤回后重新选择')
  if (!groupEngines(group).includes(record.engine)) throw new Error('线路协议与当前引擎不兼容')
  const models = group.models.length
    ? group.models
    : await jsonRequest(`/v1/platform/groups/${p.groupId}/models`, 'POST')
  if (record.model && (!Array.isArray(models) || !models.includes(record.model)))
    throw new Error('排队消息的模型已不可用，请撤回后重新选择')
}

/** 线路的模型列表，压缩换模型时核对用；缓存 5 分钟，读不到当作空（不换模型） */
const routeModelCache = new Map<string, { at: number; models: Promise<string[]> }>()
function routeModels(groupId: string): Promise<string[]> {
  const hit = routeModelCache.get(groupId)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.models
  const models = jsonRequest(`/v1/platform/groups/${groupId}/models`, 'POST')
    .then(d => (Array.isArray(d) ? d.filter((m): m is string => typeof m === 'string') : []))
    .catch(() => [] as string[])
  routeModelCache.set(groupId, { at: Date.now(), models })
  return models
}

/**
 * 平台代理。引擎只拿到本机短期凭据；账号访问令牌留在主进程。getRecord 读会话的当前记录：每个请求都按当前记录取分组和账号，
 * 所以会话中途换分组下一个请求就生效；会话改回自有后，旧进程的请求一律拒绝（docs/ui/source-switch.md §3.4）。
 */
export async function initPlatform(
  getRecord: (id: string) => SessionRecord | null | Promise<SessionRecord | null>,
  /** Claude Code 压缩上下文用的模型（设置 › 本机引擎）；null 表示跟随会话模型 */
  compactModel: () => string | null = () => null,
  requestContext?: (
    record: SessionRecord,
  ) => ((requestId: string, model: string, chargeId?: string) => void | Promise<void>) | undefined,
  /** 自定义 API 的接口配置；网关转发时按会话取真实 Key */
  providers: ProviderStore | null = null,
  /** Claude Code 压缩请求的实时进度，报给会话所在的宿主 */
  compaction?: (record: SessionRecord, report: CompactionRequestReport) => void,
  /** 设置 › 子智能体（只管像素星空引擎的会话） */
  subagents: () => SubagentSettings = () => DEFAULT_SUBAGENT_SETTINGS,
): Promise<(record: SessionRecord) => NodeJS.ProcessEnv> {
  ipc.handle('platform:groups', () => platformGroups())
  ipc.handle(
    'platform:models',
    async (_e, id: unknown) => {
      if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error('无效的分组')
      const data = await jsonRequest(`/v1/platform/groups/${id}/models`, 'POST')
      if (!Array.isArray(data) || !data.every(m => typeof m === 'string')) throw new Error('平台模型数据格式异常')
      return data
    },
    { deny: '无效的分组' },
  )

  const sessions = new Map<string, GatewaySession>()
  const settingsFiles = new Set<string>()
  const server = platformGateway({
    sessions,
    record: getRecord,
    account: signedInEmail,
    fetch: platformFetch,
    requestContext,
    compaction,
    routeModels,
    provider: id => providers?.resolve(id) ?? null,
    rewrite: async (body, models) => {
      const model = compactModel()
      return model && body.includes(CLAUDE_COMPACT_MARKER)
        ? (rewriteCompaction(body, model, await models()) ?? body)
        : body
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  server.unref()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('平台代理启动失败')
  app.on('will-quit', () => {
    server.closeAllConnections()
    server.close()
    for (const file of settingsFiles) rmSync(file, { force: true })
  })
  /**
   * 像素星空会话的子智能体（设置 › 子智能体）：启用的类型写进 PIXELSKY_SUBAGENT_TYPES；指定了站点且能用的类型各登记一把密钥
   * （sessions 里 `<会话 id>#subagent:<类型>`），不能用的跟随主会话。进程启动时取一次，改了设置在新开或重新连上的会话生效
   */
  const subagentEnv = (record: SessionRecord): Record<string, string> => {
    const settings = subagents()
    const prefix = `${record.id}#subagent:`
    const used = new Set<string>()
    const env: Record<string, string> = {
      PIXELSKY_SUBAGENT_FALLBACK: settings.fallback ? '1' : '0',
      PIXELSKY_SUBAGENT_MAX_CONCURRENT: String(settings.maxConcurrent),
    }
    const types = settings.types
      .filter(t => t.enabled)
      .map((type, i) => {
        let route: ReturnType<typeof pixelSubagentRoute> | null = null
        const check = type.target ? checkSubagentTarget(type.target, providers, signedInEmail()) : null
        if (type.target && check?.ok) {
          const target = type.target
          const key = prefix + type.id
          used.add(key)
          let entry = sessions.get(key)
          if (!entry) {
            entry = { recordId: record.id, secret: randomBytes(32).toString('hex') }
            sessions.set(key, entry)
          }
          entry.target = target
          const token = `PIXELSKY_PIXEL_SUB_TOKEN_${i + 1}`
          env[token] = entry.secret
          const provider = check.provider
          route = pixelSubagentRoute({
            api: pixelApi({
              protocol: provider?.protocol,
              groupPlatform: target.kind === 'platform' ? (groupPlatforms.get(target.groupId) ?? null) : null,
              model: target.model,
            }),
            model: target.model,
            contextWindow: provider?.models.find(m => m.id === target.model)?.contextWindow ?? null,
            upstreamBaseUrl: provider?.baseUrl ?? null,
            label: provider?.name ?? (target.kind === 'platform' ? (groupNames.get(target.groupId) ?? '平台线路') : ''),
            token,
          })
        } else if (check && !check.ok)
          log.info('子智能体的站点不能用，跟随主会话', { sessionId: record.id, type: type.id, reason: check.reason })
        return {
          id: type.id,
          name: type.name,
          description: type.description,
          tools: type.tools,
          maxMs: type.maxMinutes * 60_000,
          instructions: type.instructions,
          route,
        }
      })
    // 设置里关掉、删掉或站点不能用了的类型：旧密钥作废
    for (const key of [...sessions.keys()]) if (key.startsWith(prefix) && !used.has(key)) sessions.delete(key)
    env.PIXELSKY_SUBAGENT_TYPES = JSON.stringify(types)
    if (used.size) env.PIXELSKY_PIXEL_SUB_BASE_URL = `http://127.0.0.1:${address.port}`
    return env
  }
  const sessionEnv = (record: SessionRecord): NodeJS.ProcessEnv => {
    const provider = checkProvider(record, providers)
    if (!record.platform && !provider) return {}
    if (record.platform && !platformModelSupportsEngine(record.model, record.engine))
      throw new Error('线路协议与当前引擎不兼容')
    if (record.platform && signedInEmail() !== record.platform.account) throw new Error('请登录此会话使用的平台账号')
    let entry = sessions.get(record.id)
    if (!entry) {
      entry = { recordId: record.id, secret: randomBytes(32).toString('hex') }
      sessions.set(record.id, entry)
    }
    if (record.engine === 'codex') {
      // 自定义 API 里这个模型填的上下文窗口，Codex 启动时带上（GitHub #20）；换模型时宿主会重启进程、重新取
      const window = provider?.models.find(m => m.id === record.model)?.contextWindow
      return {
        PIXELSKY_CODEX_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        PIXELSKY_CODEX_TOKEN: entry.secret,
        ...(window ? { [CODEX_WINDOW_ENV]: String(window) } : {}),
      }
    }
    if (record.engine === 'pixel') {
      // 像素星空不读设置文件，地址 / 密钥 / 协议 / 模型直接给环境变量，由适配器写进会话自己的 models.json（密钥只在环境变量里）。
      // 协议跟着线路 / 接口走：Messages、Responses、Chat Completions（docs/own-cli.md §12）
      const api = pixelApi({
        protocol: provider?.protocol,
        groupPlatform: record.platform ? (groupPlatforms.get(record.platform.groupId) ?? null) : null,
        model: record.model,
      })
      return pixelGatewayEnv({
        port: address.port,
        secret: entry.secret,
        api,
        models: provider?.models,
        model: record.model ?? null,
        upstreamBaseUrl: provider?.baseUrl ?? null,
      })
    }
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_AUTH_TOKEN: entry.secret,
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_USE_BEDROCK: '0',
      CLAUDE_CODE_USE_VERTEX: '0',
      CLAUDE_CODE_USE_FOUNDRY: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }
    // 自定义 API：Claude Code 的默认模型、sonnet / opus 别名和后台小模型都指向这个接口里的模型，
    // 免得它去请求接口里没有的官方模型名（网关另有兜底，docs/ui/custom-api.md §4.1）
    const ids = provider?.models.map(m => m.id) ?? []
    if (provider && ids.length) {
      // 上下文超过 200K 的模型带 [1m]，不然 Claude Code 最多按 200K 算（docs/ui/custom-api.md §10）
      const long = longContextModels(provider.models)
      if (long.length) env[LONG_CONTEXT_ENV] = JSON.stringify(long)
      const main = claudeModelName(record.model && ids.includes(record.model) ? record.model : ids[0], env)
      const small = claudeModelName(smallModelOf(provider) ?? ids[0], env)
      Object.assign(env, {
        ANTHROPIC_MODEL: main,
        ANTHROPIC_DEFAULT_OPUS_MODEL: main,
        ANTHROPIC_DEFAULT_SONNET_MODEL: main,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
        ANTHROPIC_SMALL_FAST_MODEL: small,
      })
    }
    // 真实 Key 不在这里：设置文件和进程环境里只有本机地址和会话密钥。
    // --settings 优先于本机已有的 settings.json，防止其中的 API 地址覆盖平台路由。
    const dir = join(app.getPath('userData'), 'gateway')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${randomBytes(12).toString('hex')}.json`)
    // 填了上下文长度的模型按它自动压缩（docs/ui/custom-api.md §9）
    const modelSettings = provider ? compactWindows(provider.models) : null
    writeFileSync(file, JSON.stringify(modelSettings ? { env, modelSettings } : { env }), { mode: 0o600 })
    settingsFiles.add(file)
    return { ...env, PIXELSKY_GATEWAY_SETTINGS: file }
  }
  return record => (record.engine === 'pixel' ? { ...sessionEnv(record), ...subagentEnv(record) } : sessionEnv(record))
}
