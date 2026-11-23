import { useId, useMemo } from 'react'
import type { AgentRun, Item } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { DiffStat } from '@/ui/DiffStat'
import { reviewTurn, reviewTurnFile } from '@/features/panel/artifacts/focus'
import { useOpenTrace } from './live/trace'
import { activeConversationChanges } from './conversationChangesModel'

export function ConversationChangesBar({
  items,
  cwd,
  sessionId,
  running,
  agents,
}: {
  items: readonly Item[]
  cwd: string | null
  sessionId: string
  running: boolean
  agents?: readonly AgentRun[]
}) {
  useI18n()
  const openTrace = useOpenTrace()
  const previewId = useId()
  const data = useMemo(() => activeConversationChanges(items, cwd, running, agents), [items, cwd, running, agents])
  if (!data) return null
  const turnId = data.turnKey === 'start' ? null : data.turnKey

  return (
    <div className="relative mb-1" data-conversation-changes>
      <button
        type="button"
        aria-controls={previewId}
        onClick={() => {
          if (openTrace && data.groups.every(group => group.agentId)) openTrace()
          else reviewTurn(sessionId, turnId)
        }}
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
        <div className="max-h-[min(40vh,20rem)] overflow-y-auto overscroll-contain rounded-xl border border-line-card bg-popover p-2 text-list shadow-menu">
          {data.groups.map(group => (
            <section key={group.key} className="border-t border-line-subtle py-1 first:border-t-0">
              {(group.label || data.groups.length > 1) && (
                <h3 className="truncate px-2 pt-1 pb-0.5 text-meta font-semibold text-fg-muted">
                  {group.label || tr('session.ConversationChangesBar.main')}
                </h3>
              )}
              <ul>
                {group.files.map(file => (
                  <li key={file.path}>
                    <button
                      type="button"
                      title={file.path}
                      aria-label={file.path}
                      onClick={() =>
                        group.agentId && openTrace
                          ? openTrace({ agentId: group.agentId, filePath: file.path })
                          : reviewTurnFile(sessionId, turnId, file.path, cwd)
                      }
                      className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate" data-change-filename>
                          {file.name}
                        </span>
                        {file.dir && (
                          <span className="truncate text-meta text-fg-muted" data-change-dir>
                            {file.dir}
                          </span>
                        )}
                      </span>
                      <DiffStat added={file.added} removed={file.removed} className="shrink-0 text-meta" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
