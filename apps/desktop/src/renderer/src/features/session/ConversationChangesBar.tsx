import { useId, useMemo } from 'react'
import type { Item } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { DiffStat } from '@/ui/DiffStat'
import { reviewTurn } from '@/features/panel/artifacts/focus'
import { activeConversationChanges } from './conversationChangesModel'

const PREVIEW_FILES = 8

export function ConversationChangesBar({
  items,
  cwd,
  sessionId,
  running,
}: {
  items: readonly Item[]
  cwd: string | null
  sessionId: string
  running: boolean
}) {
  useI18n()
  const previewId = useId()
  const data = useMemo(() => activeConversationChanges(items, cwd, running), [items, cwd, running])
  if (!data) return null

  return (
    <div className="relative mb-1" data-conversation-changes>
      <button
        type="button"
        aria-describedby={previewId}
        onClick={() => reviewTurn(sessionId, data.turnKey === 'start' ? null : data.turnKey)}
        className="peer press mx-auto flex max-w-full items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-meta outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span>
          {tr(
            data.files.length === 1 ? 'session.ConversationChangesBar.file' : 'session.ConversationChangesBar.files',
            { n: data.files.length },
          )}
        </span>
        <DiffStat added={data.added} removed={data.removed} />
      </button>
      <div
        id={previewId}
        role="tooltip"
        className="invisible absolute bottom-full left-1/2 z-20 w-full max-w-96 -translate-x-1/2 pb-1.5 hover:visible peer-hover:visible peer-focus-visible:visible"
      >
        <ul className="rounded-xl border border-line-card bg-popover p-2 text-list shadow-menu">
          {data.files.slice(0, PREVIEW_FILES).map(file => (
            <li key={file.path} className="flex items-center gap-3 px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate" title={file.path}>
                {file.name}
              </span>
              <DiffStat added={file.added} removed={file.removed} className="text-meta" />
            </li>
          ))}
          {data.files.length > PREVIEW_FILES && (
            <li className="px-2 py-1 text-meta text-fg-muted">
              {tr('artifacts.moreFiles', { count: data.files.length - PREVIEW_FILES })}
            </li>
          )}
        </ul>
      </div>
    </div>
  )
}
