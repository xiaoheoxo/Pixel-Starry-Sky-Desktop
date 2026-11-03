import type { DiffBase, EditorViewMode } from '../types'

export interface ViewInput {
  /** HEAD 里的内容；null 表示没有（未跟踪或不是仓库） */
  head: string | null
  draft: string
  /** 文本文件才能看差异 */
  text: boolean
  /** Markdown 文本文件才有「预览」 */
  markdown: boolean
  /** 这一轮开始前的内容；算不出来是 null */
  turnBaseline: string | null
  /** 中栏宽度 */
  width: number
  /** 并排至少需要的宽度 */
  splitMinWidth: number
}

export interface ViewAvailability {
  code: true
  preview: boolean
  diff: boolean
  split: boolean
  /** 能算出「只看这一轮」的基准 */
  turn: boolean
  /** 「变更」「并排」不可用的原因（给提示用） */
  reason: 'binary' | 'noHead' | 'noChange' | null
  /** 并排因为太窄不可用 */
  narrow: boolean
}

/** 「变更」「并排」能不能点 */
export function viewAvailability(input: ViewInput): ViewAvailability {
  const turn = input.turnBaseline !== null
  let reason: ViewAvailability['reason'] = null
  if (!input.text) reason = 'binary'
  else if (input.head === null) reason = 'noHead'
  else if (input.draft === input.head && !turn) reason = 'noChange'
  const diff = reason === null
  const narrow = input.width < input.splitMinWidth
  return { code: true, preview: input.text && input.markdown, diff, split: diff && !narrow, turn, reason, narrow }
}

/** 保存的视图在当前条件下不可用时退回「代码」 */
export function effectiveMode(mode: EditorViewMode, avail: ViewAvailability): EditorViewMode {
  if (mode === 'preview') return avail.preview ? 'preview' : 'code'
  if (mode === 'diff') return avail.diff ? 'diff' : 'code'
  if (mode === 'split') return avail.split ? 'split' : avail.diff ? 'diff' : 'code'
  return 'code'
}

/** 标签没选过视图时的默认：Markdown 文本文件看预览，其余看代码 */
export function defaultMode(avail: ViewAvailability): EditorViewMode {
  return avail.preview ? 'preview' : 'code'
}

/** 「只看这一轮」算不出基准时退回 HEAD */
export function effectiveBase(base: DiffBase, avail: ViewAvailability): DiffBase {
  return base === 'turn' && !avail.turn ? 'head' : base
}

/**
 * 只读副本跟上草稿时只换变了的那一段（去掉相同的头尾）：整篇替换会把滚动锚点映射到开头，副本每打一个字就跳回第 1 行
 */
export function changedRange(from: string, to: string): { from: number; to: number; insert: string } {
  const max = Math.min(from.length, to.length)
  let head = 0
  while (head < max && from[head] === to[head]) head++
  let tail = 0
  while (tail < max - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++
  return { from: head, to: from.length - tail, insert: to.slice(head, to.length - tail) }
}
