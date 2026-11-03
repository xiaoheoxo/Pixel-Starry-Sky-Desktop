// 一句话建成员（docs/ui/channels-member-quickstart-memory.md §A）：把一句描述交给模型，回一份添加成员表单的草稿。
// 通道和 AI 写提交信息共用（askModel）；这里只按格式收字段，能不能用由渲染层对着可选项再收窄
import { EFFORTS, type Effort, type EngineId } from '@pixelsky/protocol'
import type { AiMemberDraft, AiMemberDraftResult, AiPromptRequest, MemberDraftField } from '../../../shared/types/ai'
import { isReservedMentionName } from '../../../shared/channels/mentions'
import { jsonObjects } from '../json-reply'
import { askModel, TIMEOUT, type ModelDeps } from './commit-message'

const MAX_TOKENS = 8192
const ENGINES: readonly EngineId[] = ['claude', 'codex', 'pixel']
const FIELDS: readonly MemberDraftField[] = [
  'name',
  'engine',
  'source',
  'model',
  'permission',
  'effort',
  'fast',
  'ultracode',
  'instructions',
  'mode',
]

const SYSTEM = [
  'You fill in the "add AI member" form of a desktop app for AI coding agents, from a one-sentence description by the user.',
  'Output exactly one JSON object and nothing else. Leave out any field the description does not imply; never invent values outside the option lists you are given.',
  'Fields: name (short, at most 40 characters), engine, source ("self" | "platform" | "custom:<id>"), model (an id from the list for that engine and source; omit to use the engine default), permission ("ask" | "plan" | "edits"), effort, fast (boolean), ultracode (boolean), instructions (the member’s role: first line is a one-sentence summary other agents read, at most 80 characters; then concrete responsibilities and rules; at most 2000 characters), mode ("per-task": a fresh session for every task | "shared": one long session).',
  'Also include "reasons": an object mapping each field you filled to one short sentence explaining why.',
  'Write name, instructions and reasons in the same language as the description.',
].join('\n')

export function memberDraftPrompt(req: Pick<AiPromptRequest, 'text' | 'context'>): string {
  return ['Options:', req.context.trim(), '', 'Description:', req.text.trim()].join('\n')
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

/** 回复里的草稿：逐字段按格式收，不认识的、格式不对的丢掉；一项都没有返回 null */
export function parseMemberDraft(reply: string): AiMemberDraft | null {
  for (const raw of jsonObjects(reply)) {
    const draft: AiMemberDraft = { reasons: {} }
    const name = str(raw.name, 40)
    if (name && !isReservedMentionName(name)) draft.name = name
    if (ENGINES.includes(raw.engine as EngineId)) draft.engine = raw.engine as EngineId
    const source = str(raw.source, 80)
    if (source && (source === 'self' || source === 'platform' || /^custom:[A-Za-z0-9_-]{1,64}$/.test(source)))
      draft.source = source
    const model = str(raw.model, 200)
    if (model) draft.model = model
    // 全权限要用户自己选：AI 最多给到自动编辑
    if (raw.permission === 'full') draft.fullAsked = true
    if (raw.permission === 'full' || raw.permission === 'edits') draft.permission = 'edits'
    else if (raw.permission === 'ask' || raw.permission === 'plan') draft.permission = raw.permission
    if (EFFORTS.includes(raw.effort as Effort)) draft.effort = raw.effort as Effort
    if (typeof raw.fast === 'boolean') draft.fast = raw.fast
    if (typeof raw.ultracode === 'boolean') draft.ultracode = raw.ultracode
    const instructions = str(raw.instructions, 2000)
    if (instructions) draft.instructions = instructions
    if (raw.mode === 'per-task' || raw.mode === 'shared') draft.mode = raw.mode
    const reasons = raw.reasons && typeof raw.reasons === 'object' ? (raw.reasons as Record<string, unknown>) : {}
    for (const f of FIELDS) {
      const why = draft[f] !== undefined ? str(reasons[f], 200) : undefined
      if (why) draft.reasons[f] = why
    }
    if (FIELDS.some(f => draft[f] !== undefined)) return draft
  }
  return null
}

export async function memberDraft(
  deps: ModelDeps,
  req: AiPromptRequest,
  cancel: AbortSignal,
): Promise<AiMemberDraftResult & { chargeId?: string }> {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(TIMEOUT)])
  const asked = await askModel(
    deps,
    req,
    { system: SYSTEM, prompt: memberDraftPrompt(req), maxTokens: MAX_TOKENS },
    cancel,
    signal,
  )
  if (!asked.ok) return asked
  const { text, truncated, ...rest } = asked
  if (truncated) return { ok: false, problem: 'tooLong', detail: '' }
  const draft = parseMemberDraft(text)
  return draft ? { ...rest, draft } : { ok: false, problem: 'empty', detail: '' }
}
