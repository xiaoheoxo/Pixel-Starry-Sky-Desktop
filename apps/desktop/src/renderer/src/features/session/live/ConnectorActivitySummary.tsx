import { Plug } from 'lucide-react'
import type { Item } from '@pixelsky/protocol'
import { useMemo } from 'react'
import { tr } from '@/i18n/core'
import { connectorUsage } from './connectorActivity'

/** An inline label inside the existing process disclosure; no extra row or tool call. */
export function ConnectorActivitySummary({ items }: { items: readonly Item[] }) {
  const usage = useMemo(() => connectorUsage(items), [items])
  if (usage.length === 0) return null
  const names = usage
    .slice(0, 2)
    .map(({ provider, calls }) => (calls === 1 ? provider : `${provider} ×${calls}`))
    .join(' · ')
  const text = usage.length > 2 ? tr('session.connectorActivity.more', { names, n: usage.length - 2 }) : names
  const title = usage
    .map(({ provider, calls }) => tr('session.connectorActivity.calls', { provider, n: calls }))
    .join('\n')
  return (
    <span className="inline-flex min-w-0 shrink items-center gap-1 text-fg-secondary" title={title}>
      <Plug size={13} className="shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  )
}
