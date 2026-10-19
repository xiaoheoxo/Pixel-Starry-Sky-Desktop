import { PROVIDER_ID } from './source'
import type { SessionRecord } from './types/session'

/** null means follow the parent session. Credentials always remain in the host. */
export type SubagentConfig =
  | { source: 'custom'; providerId: string; model: string }
  | { source: 'platform'; groupId: string; account: string; model: string }

export function subagentConfig(raw: unknown): SubagentConfig | null {
  if (raw == null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('子代理配置无效')
  const o = raw as Record<string, unknown>
  const text = (key: string): string => {
    const value = o[key]
    if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error('子代理配置无效')
    return value.trim()
  }
  const model = text('model')
  if (o.source === 'custom') {
    const providerId = text('providerId')
    if (!PROVIDER_ID.test(providerId)) throw new Error('子代理接口无效')
    return { source: 'custom', providerId, model }
  }
  if (o.source === 'platform') {
    const groupId = text('groupId')
    if (!/^\d+$/.test(groupId)) throw new Error('子代理线路无效')
    return { source: 'platform', groupId, account: text('account'), model }
  }
  throw new Error('子代理配置无效')
}

/** Snapshot the selected route at dispatch time, independent of later parent changes. */
export function subagentTarget(
  parent: SessionRecord,
  config: SubagentConfig | null,
): Pick<SessionRecord, 'engine' | 'model' | 'platform' | 'provider'> {
  if (!config)
    return {
      engine: parent.engine,
      model: parent.model,
      platform: parent.platform ? { ...parent.platform } : null,
      provider: parent.provider ? { ...parent.provider } : null,
    }
  return {
    engine: 'pixel',
    model: config.model,
    platform: config.source === 'platform' ? { groupId: config.groupId, account: config.account } : null,
    provider: config.source === 'custom' ? { id: config.providerId } : null,
  }
}
