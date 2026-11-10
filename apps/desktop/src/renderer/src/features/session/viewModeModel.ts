// 查看模式的纯函数（docs/ui/view-mode.md）：不碰 window、store，测试直接导入
import type { Item } from '@pixelsky/protocol'

export type ViewMode = 'normal' | 'thinking' | 'detailed'
export const VIEW_MODES: readonly ViewMode[] = ['normal', 'thinking', 'detailed']

export const parseViewMode = (v: unknown): ViewMode => (VIEW_MODES.includes(v as ViewMode) ? (v as ViewMode) : 'normal')
export const nextViewMode = (m: ViewMode): ViewMode => VIEW_MODES[(VIEW_MODES.indexOf(m) + 1) % VIEW_MODES.length]!

/** 详细模式的输出限高：数到 13 行就停，不把大输出整段切开（§5） */
export const OUTPUT_CLAMP_LINES = 12
export function overClamp(text: string): boolean {
  let n = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) if (++n >= OUTPUT_CLAMP_LINES) return true
  return false
}

const failed = (i: Item): boolean =>
  (i.kind === 'command' || i.kind === 'tool' || i.kind === 'file_change') &&
  i.status === 'failed' &&
  i.review?.status !== 'denied' &&
  i.review?.status !== 'timedOut'

/** 收起的「执行」也露出来的失败项（所有模式一样，§3 例外） */
export const failedItems = (items: readonly Item[]): Item[] => items.filter(failed)

export type ThinkingSegment = { type: 'text'; item: Item } | { type: 'tools'; key: string; items: Item[] }

/**
 * 思考模式的分段（§3）：有文字的思考、过渡话单独一段；两段之间的工具、待办、没文字的思考合成一组。
 * 失败项从组里拿出来单独一段，收起时也看得到
 */
export function thinkingSegments(items: readonly Item[]): ThinkingSegment[] {
  const out: ThinkingSegment[] = []
  for (const item of items) {
    const text =
      (item.kind === 'reasoning' && !!item.text.trim()) ||
      item.kind === 'assistant' ||
      failed(item) ||
      item.kind === 'notice'
    if (text) {
      out.push({ type: 'text', item })
      continue
    }
    const last = out[out.length - 1]
    if (last?.type === 'tools') last.items.push(item)
    else out.push({ type: 'tools', key: `seg-${item.id}`, items: [item] })
  }
  return out
}
