import type { AgentRun } from '@pixelsky/protocol'
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
      className="shrink-0 rounded bg-accent-soft px-1.5 text-label font-medium text-accent-fg"
    >
      {tr(confirmed ? 'subagent.box.agnes' : 'subagent.box.agnesMatch')}
    </span>
  )
}
