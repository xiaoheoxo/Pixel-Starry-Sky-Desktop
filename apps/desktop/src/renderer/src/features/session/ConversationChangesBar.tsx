import { useId, useMemo } from 'react'
import type { Item } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { DiffStat } from '@/ui/DiffStat'
import { reviewTurn, reviewTurnFile } from '@/features/panel/artifacts/focus'
import { activeConversationChanges } from './conversationChangesModel'

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
  const turnId = data.turnKey === 'start' ? null : data.turnKey

  return (
    <div className="relative mb-1" data-conversation-changes>
      <button
        type="button"
        aria-controls={previewId}
        onClick={() => reviewTurn(sessionId, turnId)}
        className="peer press mx-auto flex max-w-full items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-meta outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span>
          {tr(
            data.files.length === 1 ? 'session.ConversationChangesBar.file' : 'session.ConversationChangesBar.files',
            { n: data.files.length },
          )}
        </span>
        <DiffStat added={data.added} removed={data.removed} animate />
      </button>
      <div
        id={previewId}
        role="group"
        aria-label={tr('session.ConversationChangesBar.files', { n: data.files.length })}
        className="invisible absolute bottom-full left-1/2 z-20 w-full max-w-96 -translate-x-1/2 pb-1.5 hover:visible peer-hover:visible peer-focus-visible:visible focus-within:visible"
      >
        <ul className="max-h-[min(40vh,20rem)] overflow-y-auto overscroll-contain rounded-xl border border-line-card bg-popover p-2 text-list shadow-menu">
          {data.files.map(file => (
            <li key={file.path}>
              <button
                type="button"
                title={file.path}
                aria-label={file.path}
                onClick={() => reviewTurnFile(sessionId, turnId, file.path, cwd)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className="min-w-0 flex flex-1 items-baseline gap-1.5">
                  <span className={file.dir ? 'max-w-[70%] min-w-0 truncate' : 'min-w-0 truncate'}>{file.name}</span>
                  {file.dir && <span className="min-w-0 truncate text-meta text-fg-muted">{file.dir}</span>}
                </span>
                <DiffStat added={file.added} removed={file.removed} className="shrink-0 text-meta" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
