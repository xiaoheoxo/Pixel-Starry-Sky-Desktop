// Pi 的会话条目（JSONL）→ 对话条目：子智能体追踪窗口（只读）、终端模式切回时补轮次（tui.ts）
import type { Item } from '@pixelsky/protocol'
import { entries } from './agents'
import { array, object, string, type Message } from './process'
import { resultImages, toolItem } from './translate'

/** 会话条目翻成的用户条目（终端里聊的 px-tui、导入的 px-imp）：id 里带着引擎的条目 id */
export const IMPORT_ID = /^px-(?:tui|imp)-(.+)-u$/

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return array(content)
    .map(b => (object(b).type === 'text' ? string(object(b).text) : ''))
    .join('')
}

/** 子智能体的会话文件 → 对话条目（只读，给追踪窗口看） */
export function transcriptItems(file: string, cwd: string): Item[] {
  return messageItems(entries(file), cwd, 'px-sub')
}

/** 会话条目 → 对话条目；条目 id 是 `<prefix>-<Pi 条目 id>-<序号>` */
export function messageItems(list: readonly Message[], cwd: string, prefix: string): Item[] {
  const items: Item[] = []
  const tools = new Map<string, number>()
  let n = 0
  for (const e of list) {
    if (e.type !== 'message') continue
    const m = object(e.message)
    const at = Date.parse(string(e.timestamp)) || 0
    const id = (suffix: string) => `${prefix}-${string(e.id) || ++n}-${suffix}`
    if (m.role === 'user') {
      const text = textOf(m.content)
      if (text) items.push({ kind: 'user', id: id('u'), text, createdAt: at })
    } else if (m.role === 'assistant') {
      array(m.content).forEach((raw, i) => {
        const b = object(raw)
        if (b.type === 'text' && string(b.text).trim())
          items.push({ kind: 'assistant', id: id(`a${i}`), text: string(b.text), status: 'completed' })
        else if (b.type === 'thinking' && string(b.thinking).trim())
          items.push({ kind: 'reasoning', id: id(`r${i}`), text: string(b.thinking), status: 'completed' })
        else if (b.type === 'toolCall') {
          const item = toolItem(id(`t${i}`), string(b.name), object(b.arguments), cwd)
          tools.set(string(b.id), items.length)
          items.push(item)
        }
      })
    } else if (m.role === 'toolResult') {
      const index = tools.get(string(m.toolCallId))
      if (index === undefined) continue
      const prior = items[index]
      const failed = m.isError === true
      const output = textOf(m.content)
      const status = failed ? (/denied|blocked/i.test(output) ? 'declined' : 'failed') : 'completed'
      if (prior.kind === 'command')
        items[index] = { ...prior, output, exitCode: failed ? (status === 'declined' ? null : 1) : 0, status }
      else if (prior.kind === 'tool') {
        const images = failed ? [] : resultImages(m, prior.id)
        items[index] = { ...prior, output: prior.output || output, status, ...(images.length ? { images } : {}) }
      } else if ('status' in prior) items[index] = { ...prior, status } as Item
    }
  }
  // 没等到结果的工具（子智能体被停掉）
  return items.map(i => ('status' in i && i.status === 'running' ? ({ ...i, status: 'interrupted' } as Item) : i))
}
