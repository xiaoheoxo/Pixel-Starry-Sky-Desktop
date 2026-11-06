// 规则 A（docs/ui/auto-fold.md §3）：一个执行块里的条目按计划的步骤分段。纯函数。
import type { Item } from '@pixelsky/protocol'

export type PlanSection =
  /** 不属于任何一步：写计划之前、全部做完之后 */
  | { type: 'loose'; key: string; items: Item[] }
  | {
      type: 'stage'
      key: string
      /** 第几步，从 1 开始；清单改过、这一步已经不在清单里时为 null */
      n: number | null
      step: string
      items: Item[]
      done: boolean
      /** 还在做这一步：这一轮在运行，它是最后一段且没完成 */
      active: boolean
    }

const blankThinking = (item: Item): boolean =>
  item.kind === 'reasoning' && item.status !== 'running' && !item.text.trim()

/**
 * 分不出至少两步时返回 null（照原来的样子显示）。清单不在这个执行块里（被引导、报错或子智能体小框打断成了几段）也是 null。
 * shortcut: 被打断后的后几段不分阶段，要跨段分就得把整轮的计划传进来，等有人反馈再做
 */
export function planSections(items: readonly Item[], running: boolean): PlanSection[] | null {
  const todo = items.findLast(item => item.kind === 'todo' && !!item.stepMarks?.length)
  if (todo?.kind !== 'todo' || !todo.stepMarks) return null
  const work = items.filter(item => item.kind !== 'todo')
  const ids = new Set(work.map(item => item.id))
  // 记在这个块之外的：排在块里第一笔之前的是块开始前就在做的那一步，之后的属于后面的块，不用管
  let current: string | null = null
  const marks = new Map<string, string | null>()
  for (const mark of todo.stepMarks) {
    if (mark.afterItemId && ids.has(mark.afterItemId)) marks.set(mark.afterItemId, mark.step)
    else if (marks.size === 0) current = mark.step
  }
  const groups: { step: string | null; items: Item[] }[] = []
  for (const item of work) {
    const last = groups.at(-1)
    if (last && last.step === current) last.items.push(item)
    else groups.push({ step: current, items: [item] })
    if (marks.has(item.id)) current = marks.get(item.id) ?? null
  }
  // 隐藏了内容的思考什么都不显示：只有它的一段不算一步
  const shown = groups.filter(g => g.items.some(item => !blankThinking(item)))
  if (shown.filter(g => g.step !== null).length < 2) return null
  return shown.map((g, i): PlanSection => {
    const key = `${g.step === null ? 'loose' : 'stage'}-${g.items[0].id}`
    if (g.step === null) return { type: 'loose', key, items: g.items }
    const at = todo.steps.findIndex(s => s.text === g.step)
    const done = todo.steps[at]?.status === 'completed'
    return {
      type: 'stage',
      key,
      n: at < 0 ? null : at + 1,
      step: g.step,
      items: g.items,
      done,
      active: running && i === shown.length - 1 && !done,
    }
  })
}
