import type { AiCommitRequest, AiCommitResult, AiPromptRequest } from '../shared/types/ai'
import type { AiInlineEditRequest } from '../shared/types/ai'

/** AI 写提交信息（docs/ui/ai-commit-codex-warnings-history.md §2） */
export interface AiBridge {
  commitMessage(request: AiCommitRequest): Promise<AiCommitResult>
  /** 优化提示词（docs/ui/prompt-optimize.md）：结果的 message 是改写后的全文 */
  optimizePrompt(request: AiPromptRequest): Promise<AiCommitResult>
  /** 行内改写（docs/ui/coding-tier2.md §6）：结果的 message 是替换选区的代码 */
  inlineEdit(request: AiInlineEditRequest): Promise<AiCommitResult>
  /** 停止这次生成 */
  cancel(requestId: string): Promise<void>
  /** 云端这次实际扣了多少（美元）；还查不到时为 null */
  commitCharge(requestId: string): Promise<number | null>
}
