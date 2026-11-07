import { tr } from '../../i18n/core'
import type { ContextDiagnostic, ContextWindow, SessionSnapshot } from '@pixelsky/protocol'

/** 现在为什么不能压缩，能压时为 null：运行中或有排队时 bridge.compact 会抛错。输入框弹窗和概况共用 */
export function compactBlock(
  s: Pick<SessionSnapshot, 'flags' | 'state' | 'queue'> | null | undefined,
): 'busy' | 'unsupported' | null {
  if (!s || s.state !== 'idle' || s.queue.length) return 'busy'
  return s.flags.compactAvailable ? null : 'unsupported'
}

/** 明细里每一行（分类、各分组的条目）→ Token 数：刷新前后对比，找出变了的行 */
export function diagnosticValues(d: ContextDiagnostic | null | undefined): Map<string, number> {
  const values = new Map<string, number>()
  if (!d) return values
  for (const c of d.categories) values.set(`category:${c.name}`, c.tokens)
  for (const group of ['tools', 'memory', 'agents', 'skills'] as const)
    for (const row of d[group]) values.set(`${group}:${row.name}`, row.tokens)
  return values
}

/** 刷新后变了的行：数字不一样的、新出现的 */
export function changedRows(before: Map<string, number>, after: Map<string, number>): Set<string> {
  const changed = new Set<string>()
  for (const [key, value] of after) if (before.get(key) !== value) changed.add(key)
  return changed
}

/** 刷新按钮的图标至少转完整的一圈：已经转了 elapsed 毫秒，还要转多久才停在一圈的末尾 */
export function spinRemaining(elapsed: number, period: number): number {
  return Math.ceil(Math.max(1, elapsed) / period) * period - elapsed
}

export function contextPercentage(context: ContextWindow | null | undefined): number | null {
  if (
    !context ||
    context.stale ||
    context.used === null ||
    context.window === null ||
    context.window <= 0 ||
    !Number.isFinite(context.used) ||
    !Number.isFinite(context.window)
  )
    return null
  return (context.used / context.window) * 100
}
export function contextNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value >= 1000000) return `${Number((value / 1000000).toFixed(2))}M`
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}k`
  return value.toLocaleString('zh-CN')
}
const LABELS: Record<string, string> = {
  get 'System prompt'() {
    return tr('session.contextData.systemPrompt')
  },
  get 'System tools'() {
    return tr('session.contextData.systemTools')
  },
  get 'System tools (deferred)'() {
    return tr('session.contextData.systemToolsDeferred')
  },
  get 'MCP tools (deferred)'() {
    return tr('session.contextData.mcpToolsDeferred')
  },
  get 'MCP tools'() {
    return tr('session.contextData.mcpTools')
  },
  get 'Memory files'() {
    return tr('session.contextData.memoryFiles')
  },
  get 'Custom agents'() {
    return tr('session.contextData.customAgents')
  },
  get Agents() {
    return tr('session.contextData.agents')
  },
  Skills: 'Skills',
  get Messages() {
    return tr('session.contextData.conversationMessages')
  },
  get Conversation() {
    return tr('session.contextData.conversationMessages')
  },
  get 'Autocompact buffer'() {
    return tr('session.contextData.autocompactReserve')
  },
  get 'Free space'() {
    return tr('session.contextData.availableSpace')
  },
}
export const contextLabel = (name: string): string => LABELS[name] ?? name
export interface ContextSegment {
  name: string
  tokens: number
  kind: 'used' | 'buffer' | 'free' | 'deferred'
  color: string
}
const COLORS = ['bg-chart-input', 'bg-chart-output', 'bg-chart-cache', 'bg-accent', 'bg-warn', 'bg-ultracode']
export function contextSegments(context: ContextWindow | null | undefined): ContextSegment[] {
  if (!context || context.stale || context.used === null || !context.window) return []
  if (context.diagnostic && !context.diagnosticStale)
    // 延迟加载的工具还没放进上下文，不画进占用条
    return context.diagnostic.categories
      .filter(c => c.kind !== 'deferred')
      .map((c, i) => ({
        ...c,
        name: contextLabel(c.name),
        color: c.kind === 'free' ? 'bg-fg-faint/30' : c.kind === 'buffer' ? 'bg-warn' : COLORS[i % COLORS.length],
      }))
  const data: ContextSegment[] = [
    {
      get name() {
        return tr('session.contextData.uncachedInput')
      },
      tokens: context.input ?? 0,
      kind: 'used',
      color: 'bg-chart-input',
    },
    {
      get name() {
        return tr('session.contextData.cacheRead')
      },
      tokens: context.cacheRead ?? 0,
      kind: 'used',
      color: 'bg-chart-cache',
    },
    {
      get name() {
        return tr('session.contextData.cacheWrite')
      },
      tokens: context.cacheWrite ?? 0,
      kind: 'used',
      color: 'bg-chart-output',
    },
    {
      get name() {
        return tr('session.contextData.remainingCapacity')
      },
      tokens: Math.max(0, context.window - context.used),
      kind: 'free',
      color: 'bg-fg-faint/30',
    },
  ]
  return data.filter(s => s.tokens > 0)
}
