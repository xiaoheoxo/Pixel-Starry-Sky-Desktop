import type { Effort, EngineCatalog, FileChange, PermissionMode, SessionDefaults } from './types'

/** 权限模式，按菜单里的顺序 */
export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'edits', 'plan', 'full']

/** 推理强度，从低到高 */
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** 汇总几处改动的增删行数 */
export function diffStat(changes: readonly FileChange[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const c of changes) {
    added += c.added
    removed += c.removed
  }
  return { added, removed }
}

/** 自动压缩触发点可选的百分比（设置 › 本机引擎 › 上下文，docs/ui/engine-settings-redesign.md §3.2） */
export const AUTO_COMPACT_PCTS = [60, 70, 80, 90] as const

/**
 * 推理强度弹窗里的几项（推理强度、Ultracode、Fast、思考摘要）和它们的出厂值（GitHub #6）。
 * 这几项在会话里改只影响这个会话，要「设为默认」才改新会话的默认值；模型和权限照旧记住上次的选择。
 * 引擎配置里打开 rememberChoices 时，这几项也记住上次的选择（旧版的行为）。
 */
export const EFFORT_PANEL_KEYS = ['effort', 'ultracode', 'fast', 'thinkingSummaries'] as const
export type EffortPanelDefaults = Pick<SessionDefaults, (typeof EFFORT_PANEL_KEYS)[number]>
export const EFFORT_PANEL_FACTORY: EffortPanelDefaults = {
  effort: 'high',
  ultracode: false,
  fast: false,
  thinkingSummaries: true,
}

/** Ultrafast 只给官方登录（ChatGPT 账号 + openai），模型目录要列了这一档；走平台、自定义接口由调用方另外排除 */
export function ultrafastEligible(catalog: EngineCatalog | null | undefined, model: string | null): boolean {
  if (catalog?.authType !== 'chatgpt' || (catalog.currentProvider ?? 'openai') !== 'openai') return false
  // 跟随默认、config.toml 也没写模型时，实际用的是目录标的默认模型
  const id = model ?? catalog.currentModel
  return catalog.models?.find(m => (id ? m.id === id : m.isDefault))?.ultrafast === true
}
/** 退回 Fast 时留在会话里的提示（界面按 codex.ultrafastDropped 翻译） */
export const ULTRAFAST_DROPPED = 'This model or route has no Ultrafast, so it was changed to Fast'
