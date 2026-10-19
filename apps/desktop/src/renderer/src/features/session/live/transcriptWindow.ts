// 长对话只显示最近几轮（docs/ui/turn-rail.md §9，D121）：纯函数。
// 窗口用「从头隐藏了几轮」(hidden) 表示：新的轮次往后加时 hidden 不变，已经显示的不会被再藏回去；
// 点「显示更早的」、搜索跳转只会让它变小，变大（收回）只发生在新一轮开始、用户停在底部时（reclaimHidden，A7）
import type { Item } from '@pixelsky/protocol'

/** 不到「设置的轮数 + 这个数」轮的对话不折叠（只藏几轮没意义） */
export const FOLD_MARGIN = 10

/** 每一轮（一条正常发出的我方消息，引导消息不算）在 items 里的下标；和 turnRailModel.turnsOf 同一个定义 */
export function turnStarts(items: readonly Item[]): number[] {
  const starts: number[] = []
  items.forEach((item, i) => {
    if (item.kind === 'user' && item.mode !== 'guidance') starts.push(i)
  })
  return starts
}

/** 打开对话时先隐藏几轮：size 为 null（设置里选「全部」）或不到 size + FOLD_MARGIN 轮时不折叠 */
export function initialHidden(turnCount: number, size: number | null): number {
  if (size === null || size <= 0) return 0
  return turnCount >= size + FOLD_MARGIN ? turnCount - size : 0
}

/** 从哪条开始渲染：隐藏 hidden 轮后第一轮的用户消息；hidden 不超过总轮数 - 1，至少留一轮 */
export function startIndex(starts: readonly number[], hidden: number): number {
  if (hidden <= 0 || starts.length === 0) return 0
  return starts[Math.min(hidden, starts.length - 1)]
}

/** 实际隐藏的轮数（hidden 超出时按最多隐藏到只剩一轮算） */
export function hiddenCount(turnCount: number, hidden: number): number {
  return Math.max(0, Math.min(hidden, turnCount - 1))
}

/** 显示更早的 step 轮；step 为 null：全部显示 */
export function revealEarlier(hidden: number, step: number | null): number {
  return step === null ? 0 : Math.max(0, hidden - step)
}

/**
 * 要显示条目 itemId：它在隐藏部分时，从它所在那一轮的开头显示（在第一条用户消息之前的条目则全部显示）；
 * 已经显示、或 items 里没有这一条时原样返回
 */
export function revealFor(items: readonly Item[], starts: readonly number[], hidden: number, itemId: string): number {
  if (hidden <= 0) return hidden
  const at = items.findIndex(item => item.id === itemId)
  if (at < 0 || at >= startIndex(starts, hidden)) return hidden
  let turn = -1
  for (const start of starts) {
    if (start > at) break
    turn++
  }
  return Math.max(0, Math.min(hidden, turn))
}

/**
 * 新一轮开始、用户停在底部时收回窗口（D121 的后半，A7）：显示的轮数攒到 size + FOLD_MARGIN 以上（和 initialHidden
 * 同一个门槛，免得每来一轮就藏一轮）时，回到打开时那样只显示最近 size 轮。
 * 返回新的 hidden；不用收（不折叠、还没攒够、已经不比现在藏得少）返回 null。
 * 该不该收（贴底、没往上翻、没在搜索 / 跳转）由调用方判断，这里只算数
 */
export function reclaimHidden(turnCount: number, hidden: number, size: number | null): number | null {
  if (size === null || size <= 0) return null
  if (turnCount - hiddenCount(turnCount, hidden) < size + FOLD_MARGIN) return null
  const next = initialHidden(turnCount, size)
  return next > hidden ? next : null
}
