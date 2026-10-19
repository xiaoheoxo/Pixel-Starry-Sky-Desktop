// 设置 › 子智能体（docs/ui/subagent-routing.md）：设置存在主进程，这里读、改并跟随其他窗口的修改
import { useEffect, useSyncExternalStore } from 'react'
import {
  DEFAULT_SUBAGENT_SETTINGS,
  type SubagentSettings,
  type SubagentTarget,
  type SubagentType,
} from '../../../../shared/types/subagents'
import type { ProviderView } from '../../../../shared/types/providers'
import type { PlatformGroup } from '@/features/account/platform'

let state: SubagentSettings = DEFAULT_SUBAGENT_SETTINGS
let loaded = false
let started = false
const listeners = new Set<() => void>()
function set(next: SubagentSettings): void {
  state = next
  loaded = true
  listeners.forEach(fn => fn())
}

function start(): void {
  if (started) return
  const bridge = window.pixelsky?.subagents
  if (!bridge) return
  started = true
  bridge.onChange(set)
  void bridge
    .get()
    .then(set)
    .catch(() => {})
}

export function useSubagentSettings(): { settings: SubagentSettings; loaded: boolean } {
  useEffect(start, [])
  const settings = useSyncExternalStore(
    fn => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => state,
  )
  return { settings, loaded }
}

/** 改设置：先改界面，主进程存好后以它回的为准；存不上时退回去并抛出原因 */
export async function setSubagentSettings(patch: Partial<SubagentSettings>): Promise<void> {
  const before = state
  const next = { ...state, ...patch }
  set(next)
  try {
    const saved = await window.pixelsky?.subagents.set(next)
    if (saved) set(saved)
  } catch (error) {
    set(before)
    throw error
  }
}

/** 站点下拉框的值：custom:<接口 id> / platform:<线路 id> */
export type SiteKey = `custom:${string}` | `platform:${string}`

export const siteKey = (target: SubagentTarget): SiteKey =>
  target.kind === 'custom' ? `custom:${target.providerId}` : `platform:${target.groupId}`

/** 选的站点现在能不能用；不能用时写原因（主进程按同样的规则判断，这时子智能体跟随主会话） */
export function targetProblem(
  target: SubagentTarget,
  providers: readonly ProviderView[],
  platform: { email: string | null; loaded: boolean; groups: readonly PlatformGroup[] },
): 'providerGone' | 'noKey' | 'modelGone' | 'signedOut' | 'routeGone' | null {
  if (target.kind === 'custom') {
    const p = providers.find(x => x.id === target.providerId)
    if (!p) return 'providerGone'
    if (!p.keyHint) return 'noKey'
    return p.models.some(m => m.id === target.model) ? null : 'modelGone'
  }
  if (platform.email !== target.account) return 'signedOut'
  if (!platform.loaded) return null
  const group = platform.groups.find(g => g.id === target.groupId)
  if (!group) return 'routeGone'
  return group.models.length && !group.models.includes(target.model) ? 'modelGone' : null
}

/**
 * 编辑区「保存」后的类型列表：新建的追加在最后；已有的整个换成编辑结果，但启用状态只认卡片开关
 * （编辑期间开关可能已单独保存过，草稿里的是打开编辑区时的旧值）
 */
export function savedTypes(
  types: readonly SubagentType[],
  id: string,
  next: SubagentType,
  isNew: boolean,
): SubagentType[] {
  if (isNew) return [...types, next]
  return types.map(t => (t.id === id ? { ...next, enabled: t.enabled } : t))
}
