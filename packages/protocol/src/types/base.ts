// 统一协议的类型：引擎层（packages/engine）和界面（apps/desktop）共用。
// 不管底下跑的是 Claude Code 还是 Codex，界面只认这里的类型。规格见 docs/engines.md §4–§6、§8。

export type EngineId = 'claude' | 'codex' | 'pixel' | 'antigravity'

/** 权限模式：每次询问 / 自动编辑 / 计划模式 / 完全放行（docs/engines.md §6）；自动审核只有 Codex 有（docs/ui/codex-auto-review.md） */
export type PermissionMode = 'ask' | 'edits' | 'auto' | 'plan' | 'full'

/** 推理强度：低 / 中 / 高 / 超高 / 极限 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/** 「始终允许」的范围：本会话 / 本项目 / 所有项目 */
export type AlwaysScope = 'session' | 'project' | 'user'
