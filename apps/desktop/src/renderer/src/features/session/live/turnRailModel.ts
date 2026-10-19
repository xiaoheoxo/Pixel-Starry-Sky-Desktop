// 对话区的滚动条和轮次刻度（docs/ui/turn-rail.md §8）：轮次列表、刻度位置、滑块位置、当前轮。纯函数
import type { Item } from '@pixelsky/protocol'

export interface Turn {
  id: string
  /** 第几轮，从 1 开始 */
  n: number
  /** 我方消息的第一行，最多 60 字；纯图片消息为空 */
  preview: string
}

/** 每条正常发出的我方消息算一轮（运行中插话的引导消息、断线后自动发的「继续」不算） */
export function turnsOf(items: readonly Item[]): Turn[] {
  const turns: Turn[] = []
  for (const item of items) {
    if (item.kind !== 'user' || item.mode === 'guidance' || item.reconnect) continue
    const line = item.text.trim().split('\n')[0]?.trim() ?? ''
    turns.push({ id: item.id, n: turns.length + 1, preview: line.length > 60 ? `${line.slice(0, 60)}…` : line })
  }
  return turns
}

export interface Tick {
  /** 这个刻度代表的第一轮（下标）；挨得太近合并时点它跳到这一轮 */
  index: number
  /** 合并了几轮 */
  count: number
  /** 在滑轨里的位置（px，从滑轨顶部算） */
  y: number
  /** 当前轮在这个刻度里 */
  current: boolean
}

/**
 * 刻度画在每一轮在整段对话里的实际位置上，和滑块用同一把尺子（内容位置 / 内容总高 × 滑轨高）：
 * 滑块盖住的刻度就是屏幕上正在看的那几轮。挨得比 minGap 近的合成一个，当前轮所在的那个高亮
 */
export function placeTicks(
  tops: readonly number[],
  contentHeight: number,
  trackHeight: number,
  current: number,
  minGap = 3,
): Tick[] {
  if (contentHeight <= 0 || trackHeight <= 0) return []
  const ticks: Tick[] = []
  tops.forEach((top, index) => {
    if (!Number.isFinite(top)) return
    const y = Math.min(trackHeight, Math.max(0, (top / contentHeight) * trackHeight))
    const last = ticks.at(-1)
    if (last && y - last.y < minGap) {
      last.count++
      if (index === current) last.current = true
    } else ticks.push({ index, count: 1, y, current: index === current })
  })
  return ticks
}

/** 滑块：按看得到的比例，最矮 minHeight；被最矮高度撑长时贴住滑轨底部，不出界 */
export function thumbOf(
  scrollTop: number,
  viewHeight: number,
  contentHeight: number,
  trackHeight: number,
  minHeight = 24,
): { top: number; height: number } | null {
  if (contentHeight <= viewHeight + 1 || trackHeight <= 0) return null
  const height = Math.min(trackHeight, Math.max(minHeight, (viewHeight / contentHeight) * trackHeight))
  const top = Math.min(trackHeight - height, Math.max(0, (scrollTop / contentHeight) * trackHeight))
  return { top, height }
}

/** 点在滑轨上：离某个刻度 slop 以内就跳到那一轮，否则返回 null（按位置滚） */
export function tickAt(ticks: readonly Tick[], y: number, slop = 6): Tick | null {
  let best: Tick | null = null
  for (const tick of ticks)
    if (Math.abs(tick.y - y) <= slop && (!best || Math.abs(tick.y - y) < Math.abs(best.y - y))) best = tick
  return best
}

/** 当前轮：顶部已经滚过（或接近）视口顶部的最后一轮；都还在下面时是第一轮 */
export function currentTurn(tops: readonly number[], viewTop: number, slack = 48): number {
  let current = 0
  for (let i = 0; i < tops.length; i++) if (tops[i] <= viewTop + slack) current = i
  return current
}

/** 把下标夹进 [0, length-1]；没有轮时是 0 */
export function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0
  return Math.max(0, Math.min(Math.trunc(index), length - 1, Math.max(0, length - 1)))
}

/**
 * 量到的位置按轮的 id 对回当前的轮：回退后 turns 变短 / 换了一批 id 时，上一次量的结果（比 turns 长、
 * 或属于别的轮）不能直接用。返回和 turns 等长的数组，对不上的是 Infinity（画刻度时跳过）
 */
export function topsFor(
  turns: readonly { id: string }[],
  measured: { ids: readonly string[]; tops: readonly number[] },
): number[] {
  const byId = new Map<string, number>()
  measured.ids.forEach((id, i) => byId.set(id, measured.tops[i] ?? Number.POSITIVE_INFINITY))
  return turns.map(t => byId.get(t.id) ?? Number.POSITIVE_INFINITY)
}

/**
 * 轮次只取决于用户消息，流式输出时每个快照都会重新算一份：(id, n, preview) 逐项都没变就沿用上一份，
 * 引用不变，TurnRail 里依赖 turns 的 effect 才不会每帧重跑（重建观察器、重新量每一轮的位置）
 */
export function reuseTurns(prev: readonly Turn[], next: Turn[]): Turn[] {
  if (prev.length !== next.length) return next
  for (let i = 0; i < next.length; i++) {
    const a = prev[i],
      b = next[i]
    if (a.id !== b.id || a.n !== b.n || a.preview !== b.preview) return next
  }
  return prev as Turn[]
}

/** 两次量到的每一轮位置一样吗（ids、tops 逐项比，Infinity 等于 Infinity）：一样就不 set，免得 TurnRail 白渲染一次 */
export function sameMeasured(
  a: { ids: readonly string[]; tops: readonly number[] },
  b: { ids: readonly string[]; tops: readonly number[] },
): boolean {
  return (
    a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i]) && a.tops.every((t, i) => t === b.tops[i])
  )
}
