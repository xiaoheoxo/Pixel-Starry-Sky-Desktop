// 优化提示词（docs/ui/prompt-optimize.md）：把输入框里的话改写得更清楚、更具体，通道和 AI 写提交信息共用（askModel）
import type { AiCommitResult, AiPromptRequest } from '../../../shared/types/ai'
import { askModel, cleanMessage, TIMEOUT, type ModelDeps } from './commit-message'

const MAX_TOKENS = 8192

const SYSTEM = [
  'You rewrite a message that a user is about to send to an AI coding agent, so the agent understands it better.',
  'Keep the user’s intent, facts, file names, code, commands and constraints exactly; do not invent requirements.',
  'Make it clear and specific: state the goal, the relevant context and what a good result looks like. Use short paragraphs or "- " bullets when that helps; stay concise.',
  'Write in the same language as the original message.',
  'Output only the rewritten message itself: no preamble, no explanations, no surrounding quotes or code fences.',
].join('\n')

export function optimizePromptText(req: Pick<AiPromptRequest, 'text' | 'context'>): string {
  return [
    ...(req.context.trim() ? ['Context (for reference only, do not repeat it):', req.context.trim(), ''] : []),
    'Message to rewrite:',
    req.text,
  ].join('\n')
}

export async function optimizePrompt(
  deps: ModelDeps,
  req: AiPromptRequest,
  cancel: AbortSignal,
): Promise<AiCommitResult & { chargeId?: string }> {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(TIMEOUT)])
  const asked = await askModel(
    deps,
    req,
    { system: SYSTEM, prompt: optimizePromptText(req), maxTokens: MAX_TOKENS },
    cancel,
    signal,
  )
  if (!asked.ok) return asked
  const { text, truncated, ...rest } = asked
  // 写到一半的不换进输入框：原文没动，提示太长
  if (truncated) return { ok: false, problem: 'tooLong', detail: '' }
  const message = cleanMessage(text)
  return message ? { ...rest, message, partial: 0 } : { ok: false, problem: 'empty', detail: '' }
}
