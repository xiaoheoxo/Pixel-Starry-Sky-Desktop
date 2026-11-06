// 规则 B、C（docs/ui/auto-fold.md §4、§5）：旧的轮次、压缩前的对话收成一行。纯函数。
import type { Item } from '@pixelsky/protocol'
import type { Block } from './changeBlocks'
import { turnStarts } from './transcriptWindow'

/** 只留最近几轮（包括正在进行的这一轮） */
export const KEEP_TURNS = 2

/** 从哪里开始不收：before 是最近几轮里第一轮的用户消息，compaction 是最后一次压缩完成的那一行 */
export interface FoldPoint {
  before: string | null
  compaction: string | null
}

export function foldPoint(items: readonly Item[]): FoldPoint {
  const starts = turnStarts(items)
  const compaction = items.findLast(item => item.kind === 'compaction' && item.status === 'completed')
  return {
    before: starts.length > KEEP_TURNS ? items[starts[starts.length - KEEP_TURNS]].id : null,
    compaction: compaction?.id ?? null,
  }
}

export const samePoint = (a: FoldPoint, b: FoldPoint): boolean => a.before === b.before && a.compaction === b.compaction

export type FoldKind = 'compacted' | 'older'

export type FoldEntry =
  | { type: 'block'; block: Block; index: number }
  /** turns：里面有几轮；ids：里面全部条目，收起时不在页面上 */
  | { type: 'fold'; kind: FoldKind; blocks: Block[]; turns: Item[]; items: Item[]; durationMs: number }

const isTurnUser = (b: Block): boolean =>
  b.type === 'item' && b.item.kind === 'user' && b.item.mode !== 'guidance' && b.item.reconnect === undefined

function blockItems(b: Block): Item[] {
  if (b.type === 'item') return [b.item]
  return b.type === 'changes' ? [] : b.items
}

function group(kind: FoldKind, blocks: Block[]): FoldEntry[] {
  if (blocks.length === 0) return []
  let durationMs = 0
  for (const b of blocks)
    if (b.type === 'item' && b.item.kind === 'turn_stats') durationMs += b.item.usage.durationMs ?? 0
  return [
    {
      type: 'fold',
      kind,
      blocks,
      turns: blocks.filter(isTurnUser).map(b => (b as { item: Item }).item),
      items: blocks.flatMap(blockItems),
      durationMs,
    },
  ]
}

/**
 * 压缩完成的那一行留在外面。它在最近几轮里：只收这一轮之前的（这一轮的用户消息和前半段还要看）；
 * 比最近几轮还早：线之前的收成「压缩前」，线之后到最近几轮之前的收成「更早」（线下重新数）。
 * 记下的条目已经不在了（回退过）就当没有
 */
export function foldBlocks(blocks: readonly Block[], point: FoldPoint): FoldEntry[] {
  const at = (id: string | null): number =>
    id === null ? -1 : blocks.findIndex(b => b.type === 'item' && b.item.id === id)
  const recent = Math.max(0, at(point.before))
  const pill = at(point.compaction)
  const plain = (from: number, to: number): FoldEntry[] =>
    blocks.slice(from, to).map((block, i) => ({ type: 'block', block, index: from + i }))
  if (pill < 0) return [...group('older', blocks.slice(0, recent)), ...plain(recent, blocks.length)]
  if (pill < recent)
    return [
      ...group('compacted', blocks.slice(0, pill)),
      ...plain(pill, pill + 1),
      ...group('older', blocks.slice(pill + 1, recent)),
      ...plain(recent, blocks.length),
    ]
  let start = pill
  while (start > 0 && !isTurnUser(blocks[start])) start--
  return [...group('compacted', blocks.slice(0, start)), ...plain(start, blocks.length)]
}
