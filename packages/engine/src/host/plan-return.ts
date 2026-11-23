// 「先出计划」和权限档位分开（docs/ui/plan-mode-split.md §3、§7）：permissionMode 仍是 plan，另记批准后回到哪一档
import { PERMISSION_MODES, type PermissionMode, type SessionRecord } from '@pixelsky/protocol'

type Return = NonNullable<SessionRecord['planReturn']>

/** 调用方给的 planReturn：null 或一档非计划的权限 */
export function checkPlanReturn(v: unknown): Return | null {
  if (v === null) return null
  if (v === 'plan' || !PERMISSION_MODES.includes(v as PermissionMode)) throw new Error('计划批准后的档位不对')
  return v as Return
}

/**
 * 改设置后 planReturn 该是什么。mode 是改完的权限模式：
 * - 从别的档进只规划：记下原来那档（调用方显式给了就用给的）；
 * - 规划中只换 planReturn（菜单里换「批准后用哪档」）：用给的；
 * - 离开只规划（手动关掉、按计划执行）：清掉。
 */
export function nextPlanReturn(current: SessionRecord, mode: PermissionMode, patched: unknown): Return | null {
  if (mode !== 'plan') return null
  if (patched !== undefined) return checkPlanReturn(patched)
  if (current.permissionMode !== 'plan') return current.permissionMode
  return current.planReturn ?? null
}

/**
 * 引擎自己报了新的模式：会话在计划中、引擎报「离开计划」（各引擎的计划批准）时改用 planReturn。
 * 返回要写进记录的模式，以及要不要推回给引擎（引擎报的和要用的不一样时）。
 * approved：刚批准了计划、引擎还没报它退回的档；这时用户已经不在计划中，就是计划卡等着时换了档，以用户换的为准（§11）
 */
export function reportedMode(
  current: SessionRecord,
  reported: PermissionMode,
  chosen = false,
  approved = false,
): { permissionMode: PermissionMode; planReturn: Return | null; push: boolean } {
  if (current.permissionMode === 'plan' && reported !== 'plan' && current.planReturn && !chosen)
    return { permissionMode: current.planReturn, planReturn: null, push: current.planReturn !== reported }
  if (approved && current.permissionMode !== 'plan' && reported !== 'plan' && !chosen)
    return { permissionMode: current.permissionMode, planReturn: null, push: current.permissionMode !== reported }
  // 引擎自己进了计划（Claude 的 EnterPlanMode）：同样记下原来那档
  if (reported === 'plan' && current.permissionMode !== 'plan')
    return { permissionMode: 'plan', planReturn: current.permissionMode, push: false }
  return {
    permissionMode: reported,
    planReturn: reported === 'plan' ? (current.planReturn ?? null) : null,
    push: false,
  }
}
