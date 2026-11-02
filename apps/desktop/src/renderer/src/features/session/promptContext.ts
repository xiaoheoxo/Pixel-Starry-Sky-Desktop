// 优化提示词发给 AI 的背景（docs/ui/prompt-optimize.md）
import type { SessionSnapshot } from '@pixelsky/protocol'
import { PROMPT_CONTEXT_LIMIT } from '../../../../shared/types/ai'

const TURNS = 6
const TURN_CHARS = 1000

/** 发给 AI 的背景：项目文件夹、对话标题、最近几条对话（每条截短）；新对话为空 */
export function promptContext(snap: Pick<SessionSnapshot, 'record' | 'items'> | null | undefined): string {
  if (!snap) return ''
  const clip = (s: string) => (s.length > TURN_CHARS ? s.slice(0, TURN_CHARS) + '…' : s)
  const turns = snap.items
    .flatMap(i => ((i.kind === 'user' || i.kind === 'assistant') && i.text.trim() ? [i] : []))
    .slice(-TURNS)
  const folder = snap.record.cwd.split(/[\\/]/).filter(Boolean).pop()
  return [
    ...(folder ? [`Project folder: ${folder}`] : []),
    ...(snap.record.title ? [`Conversation title: ${snap.record.title}`] : []),
    ...(turns.length ? ['Recent conversation:'] : []),
    ...turns.map(i => `${i.kind === 'user' ? 'User' : 'Agent'}: ${clip(i.text.trim())}`),
  ]
    .join('\n')
    .slice(0, PROMPT_CONTEXT_LIMIT)
}
