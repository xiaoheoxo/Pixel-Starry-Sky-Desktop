// AI 成员的额度来源（docs/ui/channels-local-ai.md §3.1 #1）：自有账号 / 像素星空平台 / 自定义接口，和输入框同样的规则。
// 先选引擎，再选来源，模型列表跟着来源变；存成会话设置里的 platform / provider / model（AgentSettings）。纯函数。
import type { Effort, EngineId } from '@pixelsky/protocol'
import type { AiMemberDraft, MemberDraftField } from '../../../../shared/types/ai'
import type { AgentSettings } from '../../../../shared/types/channels'
import type { ProviderView } from '../../../../shared/types/providers'
import { platformModelSupportsEngine } from '../../../../shared/platform-models'
import {
  groupSupportsEngine,
  groupsForModel,
  platformModels,
  resolvePlatform,
  type PlatformGroup,
} from '@/features/account/platform'
import { providersFor, resolveCustomModel } from '@/features/account/providers'
import { tr } from '../../i18n/core'

/** 下拉框里的来源：'self'、'platform'、'custom:<接口 id>' */
export type SourceKey = 'self' | 'platform' | `custom:${string}`

export interface SourceContext {
  /** 登录的像素星空账号；没登录是 null */
  email: string | null
  groups: PlatformGroup[]
  providers: ProviderView[]
}

export const sourceKeyOf = (settings: AgentSettings | undefined): SourceKey =>
  settings?.platform ? 'platform' : settings?.provider ? `custom:${settings.provider.id}` : 'self'

const providerOf = (key: SourceKey, ctx: SourceContext): ProviderView | undefined =>
  key.startsWith('custom:') ? ctx.providers.find(p => p.id === key.slice(7)) : undefined

/** 平台上这个引擎能跑的模型（模型协议和线路声明的引擎都要对得上） */
export function platformModelsFor(engine: EngineId, groups: PlatformGroup[]): string[] {
  return platformModels(groups).filter(
    m => platformModelSupportsEngine(m, engine) && groupsForModel(groups, m).some(g => groupSupportsEngine(g, engine)),
  )
}

/** 这个引擎能用的线路，按倍率从低到高（倍率相同按管理员排序）；读不出模型的线路也列出来，界面灰掉写原因 */
export function platformRoutesFor(engine: EngineId, groups: PlatformGroup[]): PlatformGroup[] {
  return groups
    .map((g, i) => ({ g, i }))
    .filter(({ g }) => groupSupportsEngine(g, engine))
    .sort((a, b) => a.g.rate_multiplier - b.g.rate_multiplier || a.i - b.i)
    .map(({ g }) => g)
}

/** 线路上这个引擎能跑的模型 */
export const routeModelsFor = (engine: EngineId, group: PlatformGroup): string[] =>
  group.models.filter(m => platformModelSupportsEngine(m, engine))

/**
 * 成员实际用的（线路，模型）：只在这个引擎能用的线路、能跑的模型里按 resolvePlatform 对齐——
 * 记下的线路有这个模型就用它，没有就换到有这个模型、倍率最低的线路
 */
export function resolveRoute(
  engine: EngineId,
  groups: PlatformGroup[],
  groupId: string | null,
  model: string,
): { groupId: string | null; model: string | null } {
  const usable = groups
    .filter(g => groupSupportsEngine(g, engine))
    .map(g => ({ ...g, models: routeModelsFor(engine, g) }))
  return resolvePlatform(usable, groupId, model || null)
}

/** 换到某条线路：线路有当前模型就保留，没有就换成线路的第一个模型；线路用不了时返回 null */
export function pickRoute(
  engine: EngineId,
  groups: PlatformGroup[],
  groupId: string,
  model: string,
): { groupId: string; model: string } | null {
  const group = groups.find(g => g.id === groupId && groupSupportsEngine(g, engine))
  const models = group ? routeModelsFor(engine, group) : []
  if (!models.length) return null
  return { groupId, model: models.includes(model) ? model : models[0] }
}

export interface SourceOption {
  value: SourceKey
  kind: 'self' | 'platform' | 'custom'
  /** 自定义接口的名字 */
  name?: string
  /** 选不了的原因：没登录像素星空 / 平台上没有这个引擎能用的线路 */
  disabled?: 'signin' | 'no-route'
}

/** 来源下拉的选项：自有账号、像素星空平台（没登录或没线路时灰掉）、这个引擎能用的自定义接口 */
export function sourceOptions(engine: EngineId, ctx: SourceContext): SourceOption[] {
  const platform: SourceOption = { value: 'platform', kind: 'platform' }
  if (!ctx.email) platform.disabled = 'signin'
  else if (platformModelsFor(engine, ctx.groups).length === 0) platform.disabled = 'no-route'
  return [
    { value: 'self', kind: 'self' },
    platform,
    ...providersFor(ctx.providers, engine).map(p => ({
      value: `custom:${p.id}` as SourceKey,
      kind: 'custom' as const,
      name: p.name,
    })),
  ]
}

/**
 * 这个来源能选的模型：自有账号用引擎自己的目录（ownModels，'' 表示引擎默认）；平台是这个引擎能跑的平台模型；
 * 自定义接口是接口里列的模型。平台和自定义接口没有「默认」，必须选一个
 */
export function modelChoices(
  engine: EngineId,
  key: SourceKey,
  ctx: SourceContext,
  ownModels: Array<{ id: string; label: string }>,
): Array<{ id: string; label: string }> {
  if (key === 'self') return ownModels
  if (key === 'platform') return platformModelsFor(engine, ctx.groups).map(m => ({ id: m, label: m }))
  return (providerOf(key, ctx)?.models ?? []).map(m => ({ id: m.id, label: m.id }))
}

/** 换了来源（或引擎）后模型该是什么：还在列表里就保留，否则平台 / 自定义取第一个，自有账号回到默认（''） */
export function modelForSource(
  engine: EngineId,
  key: SourceKey,
  model: string,
  ctx: SourceContext,
  ownModels: Array<{ id: string; label: string }>,
): string {
  if (key === 'self') return ownModels.some(m => m.id === model) ? model : ''
  if (key === 'platform') {
    const list = platformModelsFor(engine, ctx.groups)
    return list.includes(model) ? model : (list[0] ?? '')
  }
  return resolveCustomModel(providerOf(key, ctx), model || null) ?? ''
}

/**
 * 存进成员配置的设置：平台用选的线路（没选或线路没有这个模型时取有这个模型、倍率最低、支持这个引擎的线路），
 * 记下登录的账号；自定义接口记接口 id。
 * 平台没登录、没线路，或接口已经删了时抛错（界面已经灰掉这些选项，这里兜底）
 */
export function settingsForSource(
  engine: EngineId,
  key: SourceKey,
  model: string,
  ctx: SourceContext,
  groupId: string | null = null,
): Pick<AgentSettings, 'platform' | 'provider' | 'model'> {
  if (key === 'self') return model ? { model } : {}
  if (key === 'platform') {
    if (!ctx.email) throw new Error(tr('channels.agent.source.signin'))
    const picked = resolveRoute(engine, ctx.groups, groupId, model)
    if (!picked.groupId || !picked.model) throw new Error(tr('channels.agent.source.noRoute'))
    return { platform: { groupId: picked.groupId, account: ctx.email }, model: picked.model }
  }
  const provider = providerOf(key, ctx)
  if (!provider) throw new Error(tr('channels.agent.source.providerGone'))
  const m = resolveCustomModel(provider, model || null)
  return { provider: { id: provider.id }, ...(m ? { model: m } : {}) }
}

// ---------------------------------------------------------------------------
// 一句话建成员（docs/ui/channels-member-quickstart-memory.md §A）
// ---------------------------------------------------------------------------

export interface DraftContext {
  /** 就绪的引擎（能力表没加载出来时 caps 为空） */
  ready: Array<{ id: EngineId; name: string; caps?: { efforts: readonly Effort[]; fast: boolean; ultracode: boolean } }>
  /** 表单现在的引擎、来源、模型；自有模型只知道这个引擎的（别的引擎目录没加载） */
  engine: EngineId
  source: SourceKey
  model: string
  /** 用户选的平台线路 */
  groupId: string | null
  ownModels: Array<{ id: string; label: string }>
  sourceCtx: SourceContext
  /** 所有本机 AI 成员的名字（不分大小写不能重名） */
  names: string[]
}

/** 给模型看的可选项：每个模型 id 只列一次，写明哪些来源 / 引擎能用；超过 budget 字截掉并写明还有几个 */
export function memberDraftContext(ctx: DraftContext, budget: number): string {
  const engines = ctx.ready.map(e => {
    const caps = e.caps
      ? [`efforts: ${e.caps.efforts.join('/') || 'none'}`, e.caps.fast && 'fast', e.caps.ultracode && 'ultracode']
      : []
    return `- ${e.id} (${[e.name, ...caps].filter(Boolean).join('; ')})`
  })
  const models = new Map<string, string[]>()
  const add = (id: string, where: string) => models.set(id, [...(models.get(id) ?? []), where])
  const sources = ['- self: the engine’s own account (every engine; model optional, omit for the engine default)']
  const platformFor = ctx.ready.filter(
    e => !sourceOptions(e.id, ctx.sourceCtx).find(o => o.kind === 'platform')?.disabled,
  )
  if (platformFor.length)
    sources.push(`- platform: PixelSky platform (engines: ${platformFor.map(e => e.id).join(', ')})`)
  for (const p of ctx.sourceCtx.providers) {
    const usable = ctx.ready.filter(e => sourceOptions(e.id, ctx.sourceCtx).some(o => o.value === `custom:${p.id}`))
    if (usable.length) sources.push(`- custom:${p.id}: "${p.name}" (engines: ${usable.map(e => e.id).join(', ')})`)
    for (const m of p.models) if (usable.length) add(m.id, `custom:${p.id}`)
  }
  for (const e of platformFor) for (const m of platformModelsFor(e.id, ctx.sourceCtx.groups)) add(m, `platform/${e.id}`)
  for (const m of ctx.ownModels) add(m.id, `self/${ctx.engine}`)
  const lines = [
    'Engines:',
    ...engines,
    'Sources:',
    ...sources,
    ...(ctx.names.length ? [`Existing member names (do not reuse): ${ctx.names.join(', ')}`] : []),
    'Models (id: usable with):',
    ...[...models].map(([id, where]) => `- ${id}: ${where.join(', ')}`),
  ]
  let text = ''
  for (let i = 0; i < lines.length; i++) {
    const more = `\n(${lines.length - i} more not listed)`
    if (text.length + lines[i].length + 1 + more.length > budget) return text + more
    text += (text ? '\n' : '') + lines[i]
  }
  return text
}

export interface DraftApplied {
  values: {
    name?: string
    engine?: EngineId
    source?: SourceKey
    model?: string
    groupId?: string | null
    permission?: AiMemberDraft['permission']
    effort?: Effort
    fast?: boolean
    ultracode?: boolean
    instructions?: string
    mode?: AiMemberDraft['mode']
  }
  /** 采纳了的字段 → 为什么（没写理由是 ''） */
  fields: Partial<Record<MemberDraftField, string>>
}

/**
 * 把草稿对到表单上：引擎只认就绪的，来源只认这个引擎能用的，模型按 modelForSource 收窄（别的引擎的自有模型变成默认），
 * 平台线路按 resolveRoute 挑；名字重名加数字后缀。推理强度、Fast、Ultracode 原样带上，表单渲染时按能力收窄
 */
export function applyDraft(draft: AiMemberDraft, ctx: DraftContext): DraftApplied {
  const values: DraftApplied['values'] = {}
  const fields: DraftApplied['fields'] = {}
  const take = (f: MemberDraftField) => (fields[f] = draft.reasons[f] ?? '')

  if (draft.name) {
    const taken = new Set(ctx.names.map(n => n.trim().toLowerCase()))
    let name = draft.name.slice(0, 40)
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${draft.name.slice(0, 40 - ` ${n}`.length)} ${n}`
    values.name = name
    take('name')
  }
  const readyEngine = draft.engine && ctx.ready.some(e => e.id === draft.engine) ? draft.engine : null
  const engine = readyEngine ?? ctx.engine
  if (readyEngine) take('engine')
  if (engine !== ctx.engine) values.engine = engine
  const usable = (key: string) => sourceOptions(engine, ctx.sourceCtx).some(o => o.value === key && !o.disabled)
  const drafted = draft.source && usable(draft.source) ? (draft.source as SourceKey) : null
  const source = drafted ?? (usable(ctx.source) ? ctx.source : 'self')
  const own = engine === ctx.engine ? ctx.ownModels : []
  // 不在这个来源列表里的模型不认：留着表单原来的，不拿它去换成列表第一个
  const wanted = draft.model && modelChoices(engine, source, ctx.sourceCtx, own).some(m => m.id === draft.model)
  if (drafted || wanted || values.engine) {
    const kept = source === ctx.source && !values.engine
    const model = modelForSource(engine, source, wanted ? draft.model! : kept ? ctx.model : '', ctx.sourceCtx, own)
    values.source = source
    values.model = model
    values.groupId =
      source === 'platform'
        ? resolveRoute(engine, ctx.sourceCtx.groups, kept ? ctx.groupId : null, model).groupId
        : null
    if (drafted) take('source')
    if (draft.model && model === draft.model) take('model')
  }
  // 这个引擎用不了的推理强度、Fast、Ultracode 不认；能力表还没加载时也不认（表单不显示这几项，填了用户看不到却会存下）
  const caps = ctx.ready.find(e => e.id === engine)?.caps
  const supported = {
    effort: !!caps && !!draft.effort && caps.efforts.includes(draft.effort),
    fast: !!caps?.fast,
    ultracode: !!caps?.ultracode,
  }
  for (const f of ['permission', 'effort', 'fast', 'ultracode', 'instructions', 'mode'] as const) {
    if (draft[f] === undefined || (f in supported && !supported[f as keyof typeof supported])) continue
    ;(values as Record<string, unknown>)[f] = draft[f]
    take(f)
  }
  if (draft.fullAsked && fields.permission !== undefined)
    fields.permission = [fields.permission, tr('channels.agent.quick.noFull')].filter(Boolean).join(' · ')
  return { values, fields }
}
