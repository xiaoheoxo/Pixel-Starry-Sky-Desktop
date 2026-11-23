// oh-my-pi 的上下文明细（docs/omp-engine.md §15）：它自带的 /context 的输出换成我们的。RPC 没有结构化的明细，只能解析文字
import type { ContextDiagnostic, ContextPart } from '@pixelsky/protocol'
import { ANSI } from './goal'

export const OMP_CONTEXT_COMMAND = '/context'

/** omp 的叫法 → 界面认识的（contextData.ts LABELS）；没列的照原样 */
const NAMES: Record<string, string> = { 'Auto-compact buf': 'Autocompact buffer', Free: 'Free space' }
const KINDS: Record<string, ContextPart['kind']> = { 'Auto-compact buf': 'buffer', Free: 'free' }

/** 没有明细可给（没选模型、它自己算不出来）：不是格式变了，下次再取 */
export const ompNoContext = (raw: string): boolean => /^Context usage is unavailable/.test(raw.replace(ANSI, '').trim())

/** 认不出格式返回 null。used 是 omp 报的占用，没有就按窗口减去预留和剩余 */
export function ompContext(
  raw: string,
  model: string,
  used: number | null,
  now = Date.now(),
): ContextDiagnostic | null {
  const lines = raw.replace(ANSI, '').split('\n')
  const window = Number(/^Context window: (\d+) tokens\b/.exec(lines[0]!.trim())?.[1])
  if (!(window > 0)) return null
  const categories: ContextPart[] = []
  for (const line of lines.slice(1)) {
    // 「  System tools     [█░░░] 2%  4353 tokens」
    const m = /^ {2}(\S.*?)\s*\[[^\]]*\]\s*\d+%\s+(\d+) tokens\s*$/.exec(line)
    if (m) categories.push({ name: NAMES[m[1]!] ?? m[1]!, tokens: Number(m[2]), kind: KINDS[m[1]!] ?? 'used' })
  }
  if (!categories.some(c => c.kind === 'used')) return null
  const rest = categories.reduce((n, c) => (c.kind === 'used' ? n : n + c.tokens), 0)
  return {
    model,
    used: used ?? Math.max(0, window - rest),
    window,
    categories,
    tools: [],
    memory: [],
    agents: [],
    skills: [],
    observedAt: now,
  }
}
