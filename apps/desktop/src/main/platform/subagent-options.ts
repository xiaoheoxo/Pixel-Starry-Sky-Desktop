// 主模型调度（docs/ui/subagent-model-dispatch.md §4）：命令行派活时问本机网关「现在能选哪些模型」。
// 候选在这里现算：同账号换分组不换进程，命令行手里的启动数据会过期，只有网关知道会话现在在哪个分组。
import { parseSubagentOverrides, type SessionRecord, type SubagentOverride } from '@pixelsky/protocol'
import { resolveDispatch, type DispatchCatalog } from '../../shared/subagent-dispatch'
import type { SubagentSettings, SubagentSite, SubagentTarget } from '../../shared/types/subagents'
import { stripLongContextSuffix } from './pixel-env'

export const SUBAGENT_OPTIONS_PATH = '/pixelsky/subagent-options'
/** 选中的路线的密钥放在子进程的这个环境变量里（编号从 1 开始的是固定站点的类型用的） */
export const DISPATCH_TOKEN_ENV = 'PIXELSKY_PIXEL_SUB_TOKEN_0'

export type SubagentOptionsPick =
  /** 用主模型自己 */
  | { outcome: 'self' }
  /** 走这条路线；secret 只给这个子进程 */
  | { outcome: 'route'; route: unknown; secret: string; source: 'chosen' | 'default'; outside: boolean }
  /** 选的模型现在不允许 */
  | { outcome: 'rejected' }

export interface SubagentOptionsReply {
  /** 用户的本会话覆盖；模型指定仅限主会话当前通道，路线仍由网关签发。 */
  override?: Omit<SubagentOverride, 'type'> & { route?: unknown; secret?: string }
  currentModel: string
  options: Array<{ model: string; note: string; outside: boolean }>
  /** 不填 model 时用的；null：用主模型自己 */
  defaultModel: string | null
  /** 请求里 pick 为真时才有 */
  pick?: SubagentOptionsPick
}

/**
 * 这把子智能体密钥要不要作废（类型关了、删了、站点不能用了）。`@` 后面是主模型选的路线（登记时写的 key）：
 * 可能有子任务正在用，而旁聊也会算一次环境（subagentEnv），不能清；密钥只在那个子进程手里，它结束就没人用了
 */
export const staleSubagentKey = (key: string, prefix: string, used: ReadonlySet<string>): boolean =>
  key.startsWith(prefix) && !key.slice(prefix.length).includes('@') && !used.has(key)

/** 包含来源种类和账号，换来源后签发新路线不会改掉正在运行的子任务的目标。 */
export const subagentRouteKey = (recordId: string, typeId: string, target: SubagentTarget): string =>
  `${recordId}#subagent:${typeId}@${JSON.stringify(target)}`

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export const recordSite = (record: SessionRecord): SubagentSite | null =>
  record.platform
    ? { kind: 'platform', groupId: record.platform.groupId }
    : record.provider
      ? { kind: 'custom', providerId: record.provider.id }
      : null

/** 只按当前记录和活的设置算，请求里能影响结果的只有类型和想选的模型 */
export async function answerSubagentOptions(deps: {
  settings: SubagentSettings
  record: SessionRecord
  request: unknown
  catalog: (site: SubagentSite | null) => Promise<DispatchCatalog>
  /** 给选中的模型登记一把只通向它的密钥；这时已经不能用了就返回 null */
  issue: (typeId: string, target: SubagentTarget) => { route: unknown; secret: string } | null
}): Promise<SubagentOptionsReply> {
  const { settings, record } = deps
  const request = (deps.request && typeof deps.request === 'object' ? deps.request : {}) as Record<string, unknown>
  const typeId = str(request.type)
  const dispatch = settings.types.find(t => t.id === typeId && t.enabled)?.dispatch
  // 会话记录里没写模型时（跟随默认）才用命令行报的
  const model = stripLongContextSuffix(record.model || str(request.mainModel))
  const site = recordSite(record)
  const reply: SubagentOptionsReply = {
    currentModel: model,
    options: [],
    defaultModel: null,
  }
  const override =
    request.configure === true && record.engine === 'pixel'
      ? parseSubagentOverrides(record.subagentOverrides).find(o => o.type === typeId)
      : undefined
  if (override) {
    const { type: _type, ...config } = override
    reply.override = config
    if (config.model && site) {
      const available = await deps.catalog(site)
      if (!available.siteModels.includes(config.model)) throw new Error('子智能体模型已不在当前通道，请重新选择')
      const target: SubagentTarget =
        site.kind === 'custom'
          ? { ...site, model: config.model }
          : { ...site, account: record.platform!.account, model: config.model }
      if (available.problem(target)) throw new Error('子智能体模型的通道暂不可用')
      const issued = deps.issue(typeId, target)
      if (!issued) throw new Error('子智能体模型的通道暂不可用')
      Object.assign(reply.override, issued)
    }
    // 用户指定模型优先于主模型的调度选择；null 表示明确跟随主会话。
    if ('model' in config) return reply
  }
  const result =
    dispatch && record.engine === 'pixel'
      ? resolveDispatch(dispatch, { site, account: record.platform?.account ?? null, model }, await deps.catalog(site))
      : { options: [], defaultModel: null }
  reply.options = result.options.map(({ model: m, note, outside }) => ({ model: m, note, outside }))
  reply.defaultModel = result.defaultModel
  if (request.pick !== true) return reply
  const requested = str(request.model)
  const chosen = requested || result.defaultModel
  // 没有默认时主模型本来就是用它自己，写上自己的名字不算选错
  if (!chosen || (chosen === model && result.defaultModel === null)) return { ...reply, pick: { outcome: 'self' } }
  const option = result.options.find(o => o.model === chosen)
  const issued = option ? deps.issue(typeId, option.target) : null
  if (!option || !issued) return { ...reply, pick: { outcome: 'rejected' } }
  return {
    ...reply,
    pick: {
      outcome: 'route',
      route: issued.route,
      secret: issued.secret,
      source: requested ? 'chosen' : 'default',
      outside: option.outside,
    },
  }
}
