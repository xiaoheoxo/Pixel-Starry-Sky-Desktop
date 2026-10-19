// 提问卡片：推荐项（docs/ui/rewind-fork-sidechat.md §5，选项标签里带「（推荐）」「(推荐)」「(Recommended)」）
// 和每题的作答状态（选中的选项 + 「其他」自己输入的内容）
import type { Question } from '@pixelsky/protocol'

const MARK = /\s*[（(]\s*(?:推荐|recommended)\s*[)）]\s*/i

export function isRecommended(label: string): boolean {
  return MARK.test(label)
}

/** 显示用：去掉推荐记号（另外画一个「推荐」标签）；提交时仍用原文 */
export function displayLabel(label: string): string {
  return label.replace(MARK, ' ').trim() || label
}

/** 每个问题都有推荐项时，返回按推荐作答的答案；否则 null */
export function recommendedAnswers(questions: Question[]): Record<string, string> | null {
  if (questions.length === 0) return null
  const answers: Record<string, string> = {}
  for (const q of questions) {
    const picks = q.options.filter(o => isRecommended(o.label)).map(o => o.label)
    if (picks.length === 0) return null
    answers[q.question] = (q.multiSelect ? picks : picks.slice(0, 1)).join(', ')
  }
  return answers
}

/** 一题的作答状态：picks 是选中的选项原文，other 为 true 时 text 是自己输入的内容 */
export interface QuestionDraft {
  picks: string[]
  other: boolean
  text: string
}

export const EMPTY_DRAFT: QuestionDraft = { picks: [], other: false, text: '' }

/** 能不能自己输入：引擎允许，或者这题根本没有选项 */
export const canWriteIn = (q: Question): boolean => q.allowOther === true || q.options.length === 0

/** 点一个选项：单选时换成它并取消「其他」，多选时切换它 */
export function pickOption(q: Question, d: QuestionDraft, label: string): QuestionDraft {
  if (!q.multiSelect) return { ...d, picks: [label], other: false }
  return { ...d, picks: d.picks.includes(label) ? d.picks.filter(x => x !== label) : [...d.picks, label] }
}

/** 点「其他」：单选时清掉选中的选项，多选时和选项并存；再点一次收起（已输入的内容保留，提交时不算） */
export function toggleOther(q: Question, d: QuestionDraft): QuestionDraft {
  return q.multiSelect || d.other ? { ...d, other: !d.other } : { ...d, picks: [], other: true }
}

/** 这题的答案；没答完（什么都没选，或选了「其他」却没填）是 null。多选用「, 」连起来，和 Claude Code 一致 */
export function draftAnswer(q: Question, d: QuestionDraft): string | null {
  const text = d.text.trim()
  const writing = q.options.length === 0 || d.other
  if (writing && !text) return null
  const parts = [...d.picks, ...(writing ? [text] : [])]
  return parts.length ? parts.join(', ') : null
}

/** 全部答完时返回 问题 → 答案；有一题没答完就是 null */
export function collectAnswers(
  questions: Question[],
  drafts: Record<string, QuestionDraft>,
): Record<string, string> | null {
  const answers: Record<string, string> = {}
  for (const q of questions) {
    const value = draftAnswer(q, drafts[q.question] ?? EMPTY_DRAFT)
    if (value === null) return null
    answers[q.question] = value
  }
  return answers
}

/** 已经答完的题数（页脚的「已回答 n/m」） */
export function answeredCount(questions: Question[], drafts: Record<string, QuestionDraft>): number {
  return questions.filter(q => draftAnswer(q, drafts[q.question] ?? EMPTY_DRAFT) !== null).length
}
