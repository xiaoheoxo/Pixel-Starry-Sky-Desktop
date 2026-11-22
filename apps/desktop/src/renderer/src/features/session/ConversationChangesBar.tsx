import { useMemo, useState } from 'react'
import type { Item } from '@pixelsky/protocol'
import { ChevronDown } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { DiffStat } from '@/ui/DiffStat'
import { ChangedFilesCard } from './ChangedFilesCard'
import { conversationChanges } from './conversationChangesModel'

export function ConversationChangesBar({
  items,
  cwd,
  sessionId,
}: {
  items: readonly Item[]
  cwd: string | null
  sessionId: string
}) {
  useI18n()
  const [expanded, setExpanded] = useState(false)
  const data = useMemo(() => conversationChanges(items, cwd), [items, cwd])
  if (!data) return null

  return (
    <details
      className="group relative mb-1"
      data-conversation-changes
      onToggle={event => setExpanded(event.currentTarget.open)}
    >
      <summary className="mx-auto flex w-fit max-w-full cursor-pointer list-none items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-meta outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <span>
          {tr(
            data.files.length === 1 ? 'session.ConversationChangesBar.file' : 'session.ConversationChangesBar.files',
            { n: data.files.length },
          )}
        </span>
        {(data.added !== 0 || data.removed !== 0) && <DiffStat added={data.added} removed={data.removed} />}
        <ChevronDown aria-hidden className="size-3.5 shrink-0 group-open:rotate-180" />
      </summary>
      {expanded && (
        <div className="absolute bottom-full left-1/2 z-20 mb-2 max-h-[40vh] w-full max-w-[30rem] -translate-x-1/2 overflow-y-auto overscroll-contain rounded-xl border border-line-card bg-popover p-2 shadow-menu">
          <p className="px-2 pb-2 text-meta text-fg-muted">{tr('session.ConversationChangesBar.scope')}</p>
          <ChangedFilesCard data={data} target={{ sessionId }} inlineHistory />
        </div>
      )}
    </details>
  )
}
