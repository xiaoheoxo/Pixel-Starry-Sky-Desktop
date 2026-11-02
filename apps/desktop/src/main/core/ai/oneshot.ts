// 一次性模型调用（docs/ui/ai-commit-codex-warnings-history.md §2.5）：不流式、不开会话，发一次拿回一段文字。
// 只管请求体和读回复：Anthropic Messages、OpenAI Responses 两种格式；地址、认证头由调用方给（云端和自定义 API 不同）
import type { AiUsage } from '../../../shared/types/ai'

export type OneShotProtocol = 'anthropic' | 'responses' | 'chat'

export interface OneShotRequest {
  protocol: OneShotProtocol
  model: string
  system: string
  prompt: string
  maxTokens: number
}

export interface OneShotReply {
  text: string
  usage: AiUsage | null
  /** 写到输出上限被截断（stop_reason max_tokens / finish_reason length / status incomplete） */
  truncated: boolean
}

export function oneShotBody(r: OneShotRequest): Record<string, unknown> {
  if (r.protocol === 'chat')
    return {
      model: r.model,
      max_tokens: r.maxTokens,
      stream: false,
      messages: [
        { role: 'system', content: r.system },
        { role: 'user', content: r.prompt },
      ],
    }
  return r.protocol === 'anthropic'
    ? { model: r.model, max_tokens: r.maxTokens, system: r.system, messages: [{ role: 'user', content: r.prompt }] }
    : { model: r.model, instructions: r.system, input: r.prompt, max_output_tokens: r.maxTokens, store: false }
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** 读回复：文字拼起来，用量换成统一的四项；格式不对时文字为空 */
export function parseReply(protocol: OneShotProtocol, body: unknown): OneShotReply {
  const json = record(body)
  const u = record(json.usage)
  if (protocol === 'anthropic') {
    const text = list(json.content)
      .map(record)
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text as string)
      .join('')
    return {
      text,
      truncated: json.stop_reason === 'max_tokens',
      usage: json.usage
        ? {
            input: count(u.input_tokens),
            output: count(u.output_tokens),
            cacheRead: count(u.cache_read_input_tokens),
            cacheWrite: count(u.cache_creation_input_tokens),
          }
        : null,
    }
  }
  if (protocol === 'chat') {
    const choice = record(list(json.choices)[0])
    const message = record(choice.message)
    const cached = count(record(u.prompt_tokens_details).cached_tokens)
    return {
      text: typeof message.content === 'string' ? message.content : '',
      truncated: choice.finish_reason === 'length',
      usage: json.usage
        ? {
            input: Math.max(0, count(u.prompt_tokens) - cached),
            output: count(u.completion_tokens),
            cacheRead: cached,
            cacheWrite: 0,
          }
        : null,
    }
  }
  const text =
    typeof json.output_text === 'string'
      ? json.output_text
      : list(json.output)
          .map(record)
          .filter(o => o.type === 'message')
          .flatMap(o => list(o.content).map(record))
          .filter(c => c.type === 'output_text' && typeof c.text === 'string')
          .map(c => c.text as string)
          .join('')
  const cached = count(record(u.input_tokens_details).cached_tokens)
  return {
    text,
    truncated: json.status === 'incomplete',
    usage: json.usage
      ? {
          input: Math.max(0, count(u.input_tokens) - cached),
          output: count(u.output_tokens),
          cacheRead: cached,
          cacheWrite: 0,
        }
      : null,
  }
}
