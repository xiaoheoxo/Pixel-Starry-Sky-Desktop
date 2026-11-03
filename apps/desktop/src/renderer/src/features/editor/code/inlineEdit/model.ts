// 行内改写（docs/ui/coding-tier2.md §6）的纯逻辑：改哪一段、前后文、和原文比出的改动块。不 import 界面和 store
import type { Text } from '@codemirror/state'
import {
  INLINE_EDIT_CONTEXT_LINES,
  INLINE_EDIT_MAX_CHARS,
  INLINE_EDIT_MAX_LINES,
} from '../../../../../../shared/types/ai'
import { quoteRange } from '@/features/session/quote'
import { enclosingSymbol } from '@/features/coding/editor/extras/symbolsModel'
import { reviewHunks, type ReviewHunk } from '@/features/coding/review/hunksModel'

/** 要改的那几整行：from 是首行行首，to 是末行行尾（不含换行） */
export interface InlineTarget {
  from: number
  to: number
}

/** 有选区改选区（整行）；没有就改光标所在的声明；再没有就改光标所在行 */
export function inlineTarget(doc: Text, from: number, to: number, path: string): InlineTarget {
  let range = quoteRange(doc, from, to)
  if (from === to) {
    const symbol = enclosingSymbol(doc.toString(), doc.lineAt(from).number, path)
    // 声明的 to 是块结束（不含）：落在下一行行首时 quoteRange 会退回上一行
    if (symbol) range = quoteRange(doc, symbol.from, Math.max(symbol.from, Math.min(symbol.to, doc.length)))
  }
  return { from: doc.line(range.startLine).from, to: doc.line(range.endLine).to }
}

/** 选的太多（超过约 400 行 / 40 KB） */
export const inlineTooLarge = (code: string): boolean =>
  code.length > INLINE_EDIT_MAX_CHARS || code.split('\n').length > INLINE_EDIT_MAX_LINES

/** 选区前后各最多 60 行做上下文（字数也按上限截，长行的压缩文件不至于整个发出去） */
export function contextAround(doc: Text, target: InlineTarget): { before: string; after: string } {
  const first = doc.lineAt(target.from).number,
    last = doc.lineAt(target.to).number
  const before =
    first > 1 ? doc.sliceString(doc.line(Math.max(1, first - INLINE_EDIT_CONTEXT_LINES)).from, target.from - 1) : ''
  const after =
    last < doc.lines
      ? doc.sliceString(target.to + 1, doc.line(Math.min(doc.lines, last + INLINE_EDIT_CONTEXT_LINES)).to)
      : ''
  return { before: before.slice(-INLINE_EDIT_MAX_CHARS), after: after.slice(0, INLINE_EDIT_MAX_CHARS) }
}

/**
 * 这一段（当前内容）和原文比出的改动块，坐标换成全文的；kept 里的块已保留、不再显示。
 * key 按内容算，两块一模一样时会重复：加上第几次出现，「保留 / 撤销」才不会点到另一块
 */
export function segmentHunks(original: string, current: string, offset: number, kept: readonly string[]): ReviewHunk[] {
  if (original === current) return []
  const seen = new Map<string, number>()
  return reviewHunks(original, current)
    .map(h => {
      const n = seen.get(h.key) ?? 0
      seen.set(h.key, n + 1)
      return n ? { ...h, key: `${h.key}#${n}` } : h
    })
    .filter(h => !kept.includes(h.key))
    .map(h => ({
      ...h,
      fromB: h.fromB + offset,
      toB: h.toB + offset,
      undoFrom: h.undoFrom + offset,
      undoTo: h.undoTo + offset,
    }))
}

/** 改了几处、删了几行、加了几行 */
export function changeSummary(hunks: readonly ReviewHunk[]): { count: number; removed: number; added: number } {
  const lines = (text: string, has: boolean): number => (has ? text.split('\n').length : 0)
  return {
    count: hunks.length,
    removed: hunks.reduce((n, h) => n + lines(h.baselineText, h.hasBaseline), 0),
    added: hunks.reduce((n, h) => n + lines(h.currentText, h.hasCurrent), 0),
  }
}

/** 演示模式的固定结果：不调模型，在这段上面加一行注释（缩进跟首行走） */
export function demoResult(code: string, note: string): string {
  const indent = /^[ \t]*/.exec(code)?.[0] ?? ''
  return `${indent}// ${note}\n${code.trimEnd()}`
}
