// 编辑器内行内改写（docs/ui/coding-tier2.md §6）：选区 + 前后几十行 + 要求 → 让模型只回改写后的那段代码。
// 通道和 AI 写提交信息共用（askModel）；带了 markdown 围栏就剥掉
import type { AiCommitResult, AiInlineEditRequest } from '../../../shared/types/ai'
import { askModel, type ModelDeps } from './commit-message'

/** 和优化提示词一样 8192：不少自定义 API 的输出上限就是 8K，再大直接 400；写不完走 truncated → tooLong */
const MAX_TOKENS = 8192
// shortcut: 只管 HTTP 通道；Claude / Codex 引擎的一次性调用固定 90 秒（packages/engine ONE_SHOT_TIMEOUT），要等 OneShotRequest 能带超时
const TIMEOUT = 180_000

const SYSTEM = [
  'You rewrite one selected region of a source file in a code editor, following the user’s instruction.',
  'You are given the file path, the language, some code before and after the selection (context only), the selected code and the instruction.',
  'Change only what the instruction asks for; keep the existing indentation, style and line endings of the selection; do not touch code outside the selection.',
  'Output only the code that replaces the selection: no explanations, no markdown code fences, no surrounding text.',
].join('\n')

export function inlineEditPrompt(
  req: Pick<AiInlineEditRequest, 'path' | 'language' | 'before' | 'code' | 'after' | 'instruction'>,
): string {
  return [
    `File: ${req.path}${req.language ? ` (${req.language})` : ''}`,
    '',
    '<before_selection>',
    req.before,
    '</before_selection>',
    '<selection>',
    req.code,
    '</selection>',
    '<after_selection>',
    req.after,
    '</after_selection>',
    '',
    'Instruction:',
    req.instruction.trim(),
  ].join('\n')
}

const FENCE = /^```[^\n`]*\n([\s\S]*?)\n?```[ \t]*$/gm

/**
 * 模型回的代码：整段包在围栏里取里面；前后还夹了说明时取最长的那个围栏块。原文自己就带围栏（改 Markdown）时不剥。
 * 首行缩进要保留，只去掉开头的空行和结尾的空白
 */
export function cleanCode(raw: string, original: string): string {
  let text = raw.replace(/\r\n/g, '\n')
  const blocks = original.includes('```') ? [] : [...text.matchAll(FENCE)].map(m => m[1])
  if (blocks.length) text = blocks.reduce((a, b) => (b.length > a.length ? b : a))
  return text.replace(/^(?:[ \t]*\n)+/, '').trimEnd()
}

export async function inlineEdit(
  deps: ModelDeps,
  req: AiInlineEditRequest,
  cancel: AbortSignal,
): Promise<AiCommitResult & { chargeId?: string }> {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(TIMEOUT)])
  const asked = await askModel(
    deps,
    req,
    { system: SYSTEM, prompt: inlineEditPrompt(req), maxTokens: MAX_TOKENS },
    cancel,
    signal,
  )
  if (!asked.ok) return asked
  const { text, truncated, ...rest } = asked
  // 写到一半的代码不换进编辑器
  if (truncated) return { ok: false, problem: 'tooLong', detail: '' }
  const message = cleanCode(text, req.code)
  return message ? { ...rest, message, partial: 0 } : { ok: false, problem: 'empty', detail: '' }
}
