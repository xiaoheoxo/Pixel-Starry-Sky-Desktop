import type { AlwaysScope } from './base'
import type { CommandWrapper, FileChange } from './item'

export interface QuestionOption {
  label: string
  description: string
}

export interface Question {
  allowOther?: boolean
  secret?: boolean
  id?: string
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface ApprovalRequest {
  formSchema?: unknown
  /** 原生请求限制；省略时兼容既有 Claude 决策。 */
  canAllow?: boolean
  canDeny?: boolean
  /** 可切换为本会话完全放行；与只允许同类操作的 alwaysScopes 区分。 */
  canAllowAll?: boolean
  requestId: string
  /** 对应的工具条目（如果有） */
  itemId: string | null
  kind: 'command' | 'file_change' | 'tool' | 'question' | 'plan'
  /** 卡片标题，例如「运行命令」「修改文件」「使用 WebFetch」 */
  title: string
  command?: string
  /** Codex 命令显示时去掉了外层 shell：原始整行和外壳信息 */
  wrapper?: CommandWrapper
  /** 命令说明 */
  description?: string
  changes?: FileChange[]
  toolName?: string
  /** 其他工具的原始参数（JSON） */
  input?: unknown
  questions?: Question[]
  /** 计划模式下要用户确认的计划（Markdown） */
  plan?: string
  /** 「始终允许」能选的范围；空数组表示没有「始终允许」（问答、计划确认） */
  alwaysScopes: AlwaysScope[]
}

export type ApprovalDecision =
  | { type: 'form'; content: Record<string, unknown> }
  | { type: 'allow' }
  /** 允许当前请求，并将本会话切换为完全放行。 */
  | { type: 'allow_all' }
  /** 允许，并且以后同类操作都允许（范围见 AlwaysScope） */
  | { type: 'allow_always'; scope: AlwaysScope }
  | { type: 'deny'; message?: string }
  /** 回答问题：键是问题原文，值是选中的选项（多选用「, 」连接） */
  | { type: 'answer'; answers: Record<string, string> }
