// AI 审查一轮改动（docs/ui/review-pr-actions.md §2）：一次性问模型，只看这一轮的差异，按固定 JSON 回问题列表。
// 通道和 AI 写提交信息共用（askModel）；没按格式回时提醒一次重来，再不行把原文交给界面当「审查意见」
import {
  REVIEW_FINDINGS_MAX,
  type AiReviewRequest,
  type AiReviewResult,
  type ReviewFinding,
  type ReviewSeverity,
} from '../../../shared/types/ai'
import { jsonObjects } from '../json-reply'
import { askModel, TIMEOUT, type ModelDeps } from './commit-message'

const MAX_TOKENS = 8192
const SEVERITIES: readonly ReviewSeverity[] = ['high', 'medium', 'low']

const SYSTEM = [
  'You review one round of code changes that an AI coding agent just made in a user’s project.',
  'You only see the diff below, not the whole repository: report only problems you can see in the diff. Do not guess about code you cannot see, and do not report style nitpicks.',
  'Focus on real defects: wrong behaviour, crashes, security problems, data loss, broken edge cases, and changes that do not do what the user asked. At most 20 findings, most important first; an empty list is fine.',
  'Output exactly one JSON object and nothing else:',
  '{"findings":[{"severity":"high"|"medium"|"low","file":"path/as/in/diff","line":123,"title":"one sentence","detail":"why it is wrong and how to fix it, at most 3 sentences"}]}',
  'severity: high = will break or is unsafe; medium = likely bug or missing case; low = minor but worth fixing. line is a line number in the new file, or null when it does not apply.',
].join('\n')

const RECHECK = [
  'This is a re-review after a fix: "Previous findings" lists problems found before, numbered by n.',
  'Also include "resolved": an array of the n of previous findings that the diff now fixes. Report in "findings" only problems that are new or still present.',
].join('\n')

export function reviewPrompt(req: Pick<AiReviewRequest, 'diff' | 'ask' | 'previous' | 'uiLanguage'>): string {
  return [
    `Write "title" and "detail" in ${req.uiLanguage === 'zh' ? 'Simplified Chinese' : 'English'}.`,
    ...(req.previous.length
      ? [
          RECHECK,
          'Previous findings:',
          ...req.previous.map(p => `${p.n}. ${p.file}${p.line ? ':' + p.line : ''} ${p.title}`),
        ]
      : []),
    '',
    ...(req.ask.trim() ? ['What the user asked for in this round:', req.ask.trim(), ''] : []),
    'Diff:',
    req.diff,
  ].join('\n')
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** 回复里的审查结果；没有 findings 数组时返回 null（格式不对） */
export function parseReview(
  reply: string,
  previous: number[],
): { findings: ReviewFinding[]; resolved: number[] } | null {
  for (const raw of jsonObjects(reply)) {
    if (!Array.isArray(raw.findings)) continue
    const findings = raw.findings
      .map((f): ReviewFinding | null => {
        const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>
        const title = text(o.title, 200)
        if (!title) return null
        const line = typeof o.line === 'number' && Number.isInteger(o.line) && o.line > 0 ? o.line : null
        return {
          severity: SEVERITIES.includes(o.severity as ReviewSeverity) ? (o.severity as ReviewSeverity) : 'medium',
          file: text(o.file, 500),
          line,
          title,
          detail: text(o.detail, 1000),
        }
      })
      .filter((f): f is ReviewFinding => !!f)
      .slice(0, REVIEW_FINDINGS_MAX)
    const resolved = Array.isArray(raw.resolved)
      ? [...new Set(raw.resolved.filter((n): n is number => typeof n === 'number' && previous.includes(n)))]
      : []
    return { findings, resolved }
  }
  return null
}

export async function reviewChanges(
  deps: ModelDeps,
  req: AiReviewRequest,
  cancel: AbortSignal,
): Promise<AiReviewResult & { chargeId?: string }> {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(TIMEOUT)])
  const previous = req.previous.map(p => p.n)
  const prompt = reviewPrompt(req)
  const first = await askModel(deps, req, { system: SYSTEM, prompt, maxTokens: MAX_TOKENS }, cancel, signal)
  if (!first.ok) return first
  const parsed = first.truncated ? null : parseReview(first.text, previous)
  if (parsed) {
    const { text: _text, truncated: _cut, ...rest } = first
    return { ...rest, ...parsed }
  }
  // 没按格式回：提醒一次。第二次的计费 ID 盖掉第一次的（ai:commitCharge 只查最后一次）
  const again = await askModel(
    deps,
    req,
    {
      system: SYSTEM,
      prompt: prompt + '\n\nYour previous reply was not the required JSON object. Reply with only the JSON object.',
      maxTokens: MAX_TOKENS,
    },
    cancel,
    signal,
  )
  if (!again.ok) return again
  const retry = again.truncated ? null : parseReview(again.text, previous)
  const { text: reply, truncated, ...rest } = again
  if (retry) return { ...rest, ...retry }
  if (truncated || !reply.trim()) return { ok: false, problem: truncated ? 'tooLong' : 'empty', detail: '' }
  return { ...rest, findings: [], resolved: [], raw: reply.trim().slice(0, 8000) }
}
