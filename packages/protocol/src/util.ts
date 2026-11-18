import type { Effort, EngineCatalog, FileChange, PermissionMode, SessionDefaults, SessionSettings } from './types'

/** 权限模式，按菜单里的顺序 */
/**
 * 自动审核的提示（docs/ui/codex-auto-review.md）：条目里存原文，界面按原文查词典翻译（translateMessage 不认键名），
 * 手机直接显示原文。词典的 zh 用这同一份，改不岔
 */
export const AUTO_REVIEW_TEXT = {
  tooMany:
    '连续被自动审核拦下，这一轮已停止。可以看看被拦下的操作，或换个说法继续；也可以在输入框的权限菜单里改成每次询问。',
  networkDenied: '自动审核拦下了一次网络访问。',
} as const

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'edits', 'auto', 'plan', 'full']

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
/**
 * 平台线路上能开 Ultrafast 的模型（docs/codex-ultrafast-platform.md）：照 sub2api 0.2.23 的 openAIModelSupportsUltrafast，
 * 它按这几个模型的倍率扣费；别的模型带了 ultrafast 只按 Fast 收、上游也不一定认，不给开。model 可以带 provider/ 前缀
 */
export function platformUltrafastModel(model: string | null | undefined): boolean {
  const id = (model ?? '').trim().toLowerCase().split('/').at(-1) ?? ''
  return (
    id === 'gpt-6.1-sol' ||
    id === 'gpt-6.2-sol' ||
    id === 'gpt-6.2-astra' ||
    id === 'gpt-6-astra' ||
    id.startsWith('gpt-6-astra-')
  )
}
/** 平台线路 Ultrafast 的扣费倍数（sub2api 0.2.23）：GPT-6.2 在 2027-03-01 00:00 太平洋时间前 3 倍，之后和其余模型一样 6 倍 */
export function platformUltrafastMultiplier(model: string | null | undefined, now = Date.now()): number {
  const id = (model ?? '').trim().toLowerCase().split('/').at(-1) ?? ''
  return id.startsWith('gpt-6.2-') && now < Date.UTC(2027, 2, 1, 8) ? 3 : 6
}
/**
 * 这个会话能不能开 Ultrafast：平台线路按模型名单；自定义接口不给；自己登录按官方规则（ultrafastEligible）。
 * Codex 的界面、引擎、宿主共用
 */
export function codexUltrafastAllowed(
  source: Pick<SessionSettings, 'platform' | 'provider'>,
  catalog: EngineCatalog | null | undefined,
  model: string | null,
): boolean {
  if (source.platform) return platformUltrafastModel(model)
  if (source.provider) return false
  return ultrafastEligible(catalog, model)
}
/** 退回 Fast 时留在会话里的提示（界面按 codex.ultrafastDropped 翻译） */
export const ULTRAFAST_DROPPED = 'This model or route has no Ultrafast, so it was changed to Fast'
