// 中栏空态「AI 这一轮改的」的纯逻辑：列表在左栏，这里只要个数和第一个
import type { TurnFile } from '../ai/turnChangesModel'
import { sortTurnFiles } from '../left/files/filesModel'

export interface EmptyTurnSummary {
  count: number
  /** 排序后的第一个（同左栏）；没有改动时 null */
  first: TurnFile | null
}

export function emptyTurnSummary(files: readonly TurnFile[] | undefined): EmptyTurnSummary {
  const sorted = sortTurnFiles(files ?? [])
  return { count: sorted.length, first: sorted[0] ?? null }
}
