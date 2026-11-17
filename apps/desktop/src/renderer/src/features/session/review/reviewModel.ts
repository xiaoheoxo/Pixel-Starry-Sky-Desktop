// 审查结果卡片的纯函数（docs/ui/review-pr-actions.md §2）：拼差异、发给 AI 的修复消息、找修的那一轮、合并复审结果
import type { Item } from '@pixelsky/protocol'
import type { ChangedFiles } from '@/data'
import { isTurnUser } from '@/features/coding/ai/turnChangesModel'
import { roundChangedFiles } from '@/features/session/live/changeBlocks'
import {
  REVIEW_ASK_LIMIT,
  REVIEW_DIFF_LIMIT,
  REVIEW_PREVIOUS_MAX,
  reviewFixRequest,
  type ReviewFinding,
  type ReviewPrevious,
  type TurnReview,
} from '../../../../../shared/types/ai'

// 类型放在 shared（主进程存、手机网关也用）
export type { ReviewItem, ReviewStatus, TurnReview } from '../../../../../shared/types/ai'

/** 这一轮的差异，按文件拼；太长时截断并在末尾注明还有哪些文件没给 */
export function reviewDiff(data: ChangedFiles, limit = REVIEW_DIFF_LIMIT): string {
  const parts: string[] = []
  const skipped: string[] = []
  let size = 0
  for (const f of data.files) {
    const path = f.dir + f.name
    const body = (f.diffs ?? []).join('\n')
    const block = `=== ${path} (+${f.added} -${f.removed})\n${body || '(no diff available)'}\n`
    const room = limit - 400 - size
    if (block.length <= room) {
      parts.push(block)
      size += block.length
    } else if (room > 2000) {
      // 放不下整个文件：剩下的地方给它的前一段（一个大文件时不至于什么都没给），后面的文件不给
      parts.push(block.slice(0, room - 40) + '\n(rest of this file’s diff not shown)\n')
      size = limit - 400
    } else skipped.push(path)
  }
  if (skipped.length)
    parts.push(`(Diff truncated: ${skipped.length} more file(s) not shown: ${skipped.slice(0, 20).join(', ')})`)
  return parts.join('\n').slice(0, limit)
}

export const askText = (text: string): string => text.slice(0, REVIEW_ASK_LIMIT)

/** 「修这条」「全部修复」发给会话的话（文字在 shared/types/ai.ts，给 AI 看的不走界面词典） */
export const fixMessage = reviewFixRequest

/** 复审时带上的原条目：没忽略、没修好的，按顺序编号（n 从 1 开始） */
export function previousOf(review: TurnReview): { previous: ReviewPrevious[]; ids: string[] } {
  const open = review.items.filter(i => i.status === 'open' || i.status === 'sent').slice(0, REVIEW_PREVIOUS_MAX)
  return {
    previous: open.map((i, k) => ({ n: k + 1, title: i.title, file: i.file, line: i.line })),
    ids: open.map(i => i.id),
  }
}

let seq = 0
const newId = (): string => `r${Date.now().toString(36)}${(seq++).toString(36)}`

export function newReview(
  findings: readonly ReviewFinding[],
  meta: { at: number; model: string; files: number; raw?: string },
): TurnReview {
  return {
    ...meta,
    items: findings.map(f => ({ ...f, id: newId(), status: 'open' })),
    fix: null,
    rechecked: false,
  }
}

/** 复审结果并回去：resolved 的划掉，新问题追加（标「复审发现」）；这一轮不再自动复审 */
export function applyRecheck(
  review: TurnReview,
  ids: readonly string[],
  resolved: readonly number[],
  findings: readonly ReviewFinding[],
): TurnReview {
  const done = new Set(resolved.map(n => ids[n - 1]).filter(Boolean))
  return {
    ...review,
    items: [
      ...review.items.map(i => (done.has(i.id) ? { ...i, status: 'fixed' as const } : i)),
      ...findings.map(f => ({ ...f, id: newId(), status: 'open' as const, recheck: true })),
    ],
    fix: null,
    rechecked: true,
  }
}

/** 某一轮（turnKey 是开启它的 user 条目 id，第一条 user 之前为 'start'）已完成的文件改动 → 卡片数据 */
export function turnChangesOf(items: readonly Item[], turnKey: string): ChangedFiles | null {
  let key = 'start'
  const changes: Extract<Item, { kind: 'file_change' }>[] = []
  for (const item of items) {
    if (isTurnUser(item)) key = item.id
    else if (key === turnKey && item.kind === 'file_change' && item.status === 'completed') changes.push(item)
  }
  return roundChangedFiles(changes)
}

/**
 * 发去修之后，修的那一轮：在原来那一轮之后、原文和发去修的消息一样的 user 条目。
 * 那一轮结束了（后面又有新的一轮，或会话空闲）才返回；还没轮到（排队中）、还在跑时返回 null
 */
export function fixTurnOf(
  items: readonly Item[],
  turnKey: string,
  fixText: string,
  running: boolean,
): { turnKey: string } | null {
  let after = turnKey === 'start'
  let found: string | null = null
  let later = false
  for (const item of items) {
    if (!isTurnUser(item)) continue
    if (item.id === turnKey) after = true
    else if (found) later = true
    else if (after && item.kind === 'user' && item.text.trim() === fixText.trim()) found = item.id
  }
  return found && (later || !running) ? { turnKey: found } : null
}

export function reviewCounts(review: TurnReview): { open: number; high: number; ignored: number } {
  const live = review.items.filter(i => i.status === 'open' || i.status === 'sent')
  return {
    open: live.length,
    high: live.filter(i => i.severity === 'high').length,
    ignored: review.items.filter(i => i.status === 'ignored').length,
  }
}
