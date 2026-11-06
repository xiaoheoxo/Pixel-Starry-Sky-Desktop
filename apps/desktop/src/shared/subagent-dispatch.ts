// 主模型调度（docs/ui/subagent-model-dispatch.md §5）：主模型这次能给子智能体选哪些模型。
// 主进程派活时和设置页的预览都用这一份，预览看到的就是实际的
import type { SubagentDispatch, SubagentSite, SubagentTarget } from './types/subagents'

export const siteOfTarget = (t: SubagentTarget): SubagentSite =>
  t.kind === 'custom' ? { kind: 'custom', providerId: t.providerId } : { kind: 'platform', groupId: t.groupId }

export const sameSite = (a: SubagentSite, b: SubagentSite): boolean =>
  a.kind === 'custom'
    ? b.kind === 'custom' && a.providerId === b.providerId
    : b.kind === 'platform' && a.groupId === b.groupId

export interface DispatchMain {
  /** 用自己的登录时没有分组 */
  site: SubagentSite | null
  /** 平台账号（没写规则时给同分组的模型用） */
  account: string | null
  model: string
}

export interface DispatchCatalog {
  /** 这个模型现在不能用的原因；能用时 null */
  problem(target: SubagentTarget): string | null
  /** 主模型所在分组的模型（读不到时空：没写规则的就只有它自己） */
  siteModels: readonly string[]
  /** 官方价（美元 / 百万 token）；查不到时 null */
  price(model: string): { input: number; output: number } | null
}

export interface DispatchOption {
  model: string
  note: string
  target: SubagentTarget
  /** 在主模型的分组以外 */
  outside: boolean
}

export interface DispatchResult {
  options: DispatchOption[]
  /** 主模型不填 model 时用的；null：用主模型自己 */
  defaultModel: string | null
  /** 规则里写了、现在不生效的（给预览和日志）；reason：OUTSIDE_OFF 或 catalog.problem 给的 */
  off: Array<{ model: string; reason: string }>
  /** 这个主模型有规则 */
  ruled: boolean
}

/** 分组外的模型，但没打开「允许调度分组以外的模型」 */
export const OUTSIDE_OFF = 'outsideOff'

export function resolveDispatch(
  dispatch: SubagentDispatch,
  main: DispatchMain,
  catalog: DispatchCatalog,
): DispatchResult {
  const self: DispatchResult = { options: [], defaultModel: null, off: [], ruled: false }
  const site = main.site
  if (!site || !main.model) return self
  const rule = dispatch.rules.find(r => r.main.model === main.model && sameSite(r.main.site, site))
  if (rule) {
    const options: DispatchOption[] = []
    const off: DispatchResult['off'] = []
    let defaultModel: string | null = null
    for (const c of rule.candidates) {
      const outside = !sameSite(siteOfTarget(c.target), site)
      const reason = outside && !dispatch.outsideGroup ? OUTSIDE_OFF : catalog.problem(c.target)
      if (reason) {
        off.push({ model: c.target.model, reason })
        continue
      }
      options.push({ model: c.target.model, note: c.note, target: c.target, outside })
      if (c.isDefault) defaultModel = c.target.model
    }
    return { options, defaultModel: defaultModel ?? options[0]?.model ?? null, off, ruled: true }
  }
  if (dispatch.unruled === 'self') return self
  const mine = catalog.price(main.model)
  if (!mine) return self
  const options: DispatchOption[] = []
  for (const model of catalog.siteModels) {
    if (model === main.model) continue
    const p = catalog.price(model)
    if (!p || p.input > mine.input || p.output > mine.output) continue
    const target: SubagentTarget | null =
      site.kind === 'custom'
        ? { kind: 'custom', providerId: site.providerId, model }
        : main.account
          ? { kind: 'platform', groupId: site.groupId, account: main.account, model }
          : null
    if (target && !catalog.problem(target)) options.push({ model, note: '', target, outside: false })
  }
  // 没写规则时不填 model 还是主模型自己：费用不会悄悄变
  return { ...self, options }
}
