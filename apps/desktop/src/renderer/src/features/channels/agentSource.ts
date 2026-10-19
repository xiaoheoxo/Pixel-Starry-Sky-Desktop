// AI 成员的额度来源（docs/ui/channels-local-ai.md §3.1 #1）：自有账号 / 像素星空平台 / 自定义接口，和输入框同样的规则。
// 先选引擎，再选来源，模型列表跟着来源变；存成会话设置里的 platform / provider / model（AgentSettings）。纯函数。
import type { EngineId } from '@pixelsky/protocol'
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
 * 存进成员配置的设置：平台按模型取倍率最低、支持这个引擎的线路，记下登录的账号；自定义接口记接口 id。
 * 平台没登录、没线路，或接口已经删了时抛错（界面已经灰掉这些选项，这里兜底）
 */
export function settingsForSource(
  engine: EngineId,
  key: SourceKey,
  model: string,
  ctx: SourceContext,
): Pick<AgentSettings, 'platform' | 'provider' | 'model'> {
  if (key === 'self') return model ? { model } : {}
  if (key === 'platform') {
    if (!ctx.email) throw new Error(tr('channels.agent.source.signin'))
    const groups = ctx.groups.filter(g => groupSupportsEngine(g, engine))
    const picked = resolvePlatform(groups, null, model || null)
    if (!picked.groupId || !picked.model) throw new Error(tr('channels.agent.source.noRoute'))
    return { platform: { groupId: picked.groupId, account: ctx.email }, model: picked.model }
  }
  const provider = providerOf(key, ctx)
  if (!provider) throw new Error(tr('channels.agent.source.providerGone'))
  const m = resolveCustomModel(provider, model || null)
  return { provider: { id: provider.id }, ...(m ? { model: m } : {}) }
}
