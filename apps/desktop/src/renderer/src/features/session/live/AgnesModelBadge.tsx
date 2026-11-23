import type { AgentRun } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'

export function AgnesModelBadge({ source }: { source: AgentRun['modelSource'] }) {
  useI18n()
  if (source !== 'agnes' && source !== 'agnes-match') return null
  const confirmed = source === 'agnes'
  return (
    <span
      data-agent-source={source}
      title={confirmed ? undefined : tr('subagent.box.agnesMatchHint')}
      className={cn(
        'shrink-0 rounded px-1.5 text-label font-medium text-accent-fg',
        confirmed ? 'bg-accent-soft' : 'border border-dashed border-accent/55 bg-transparent',
      )}
    >
      {tr(confirmed ? 'subagent.box.agnes' : 'subagent.box.agnesMatch')}
    </span>
  )
}
