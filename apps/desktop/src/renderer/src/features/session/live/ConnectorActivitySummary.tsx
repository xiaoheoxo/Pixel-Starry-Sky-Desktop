import { Plug } from 'lucide-react'
import type { Item } from '@pixelsky/protocol'
import { useMemo } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { connectorUsage, type ConnectorUsage } from './connectorActivity'

/** 执行行内嵌的连接器摘要：窄宽时只省略连接器名，固定保留次数（×N）与其余项计数 */
export function ConnectorActivitySummary({
  items,
  usage: provided,
}: {
  items: readonly Item[]
  usage?: readonly ConnectorUsage[]
}) {
  useI18n()
  const computed = useMemo(() => (provided ? null : connectorUsage(items)), [items, provided])
  const usage = provided ?? computed ?? []
  if (usage.length === 0) return null
  const shown = usage.slice(0, 2)
  const extra = usage.length - shown.length
  const title = usage
    .map(({ provider, calls }) => tr('session.connectorActivity.calls', { provider, n: calls }))
    .join('\n')
  return (
    <span
      data-connector-summary
      className="inline-flex min-w-0 shrink items-center gap-1 text-fg-secondary"
      title={title}
    >
      <Plug size={13} className="shrink-0" aria-hidden />
      {shown.map(({ provider, calls }, index) => (
        <span key={provider} className="inline-flex min-w-0 shrink items-center gap-0.5">
          {index > 0 && (
            <span aria-hidden className="mr-0.5 shrink-0 text-fg-faint">
              ·
            </span>
          )}
          <span data-connector-name className="min-w-0 truncate">
            {provider}
          </span>
          {calls > 1 && (
            <span data-connector-count className="shrink-0 whitespace-nowrap tabular-nums">
              ×{calls}
            </span>
          )}
        </span>
      ))}
      {extra > 0 && (
        <span data-connector-extra className="shrink-0 whitespace-nowrap text-fg-muted">
          {tr('session.connectorActivity.moreSuffix', { n: extra })}
        </span>
      )}
    </span>
  )
}
