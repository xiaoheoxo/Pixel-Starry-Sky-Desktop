import type { AiCommitRequest, AiCommitResult, AiMemberDraftResult, AiPromptRequest } from '../shared/types/ai'
import type { AiInlineEditRequest, AiReviewRequest, AiReviewResult } from '../shared/types/ai'
import type { ReviewsChange, SessionReviews, TurnReview } from '../shared/types/ai'

/** AI 审查结果存在主进程（docs/mobile-app.md §15.5）：窗口和手机共用 */
export interface ReviewsBridge {
  /** 全部结果；legacy 是 localStorage 里的旧结果，主进程没有的会话迁过去 */
  load(legacy: unknown): Promise<Record<string, SessionReviews>>
  /** 写一轮的结果；null 是删掉 */
  set(sessionId: string, turnKey: string, review: TurnReview | null): Promise<void>
  /** 别处（手机、另一个窗口）改了 */
  onChange(callback: (change: ReviewsChange) => void): () => void
}

/** AI 写提交信息（docs/ui/ai-commit-codex-warnings-history.md §2） */
export interface AiBridge {
  commitMessage(request: AiCommitRequest): Promise<AiCommitResult>
  /** 优化提示词（docs/ui/prompt-optimize.md）：结果的 message 是改写后的全文 */
  optimizePrompt(request: AiPromptRequest): Promise<AiCommitResult>
  /** 行内改写（docs/ui/coding-tier2.md §6）：结果的 message 是替换选区的代码 */
  inlineEdit(request: AiInlineEditRequest): Promise<AiCommitResult>
  /** 一句话建成员（docs/ui/channels-member-quickstart-memory.md §A）：text 是那句话，context 是可选项 */
  memberDraft(request: AiPromptRequest): Promise<AiMemberDraftResult>
  /** AI 审查一轮改动（docs/ui/review-pr-actions.md §2）；previous 不为空时是修完后的复审 */
  review(request: AiReviewRequest): Promise<AiReviewResult>
  /** 停止这次生成 */
  cancel(requestId: string): Promise<void>
  /** 云端这次实际扣了多少（美元）；还查不到时为 null */
  commitCharge(requestId: string): Promise<number | null>
}
