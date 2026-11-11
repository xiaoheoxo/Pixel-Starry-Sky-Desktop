import { useState } from 'react'
import { CHAT_PROJECT_ID, type SessionSummary } from '@pixelsky/protocol'
import { History, RotateCw } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { isDemo } from '@/data'
import { Button, Spinner } from '@/ui'
import { useEngineState } from '@/features/engine'
import { relativeTime } from '@/features/engine/labels'
import { useMachines } from '@/features/machines/store'
import { readCodexSessions, useCodexImport } from '@/features/resume/codexImport'
import { isSettingsWindowView, runMainAction } from '../windowBridge'

export function CodexImportCard({ onOpened }: { onOpened: () => void }) {
  useI18n()
  const local = useMachines().currentId === 'local'
  const projects = useEngineState(s => s.projects)
  const sessions = useEngineState(s => s.sessions)
  // 不在进页面时自动读（docs/ui/codex-import-all.md §3）：读取会往项目列表里加一批项目，点了按钮才做
  const state = useCodexImport()
  // 这次运行里还没读过：卡片里先说明，按钮放在说明旁边
  const fresh = !state.running && !state.result && !state.error

  const open = (sessionId: string): void => {
    runMainAction({ kind: 'openSession', sessionId })
    if (!isSettingsWindowView) onOpened()
  }
  const result = state.result
  const byId = new Map(sessions.map(s => [s.record.id, s]))
  return (
    <div data-codex-import className="mb-6 rounded-lg border border-line p-3.5">
      <div className="flex items-center gap-2.5">
        <History size={16} className="text-fg-muted" />
        <span className="flex-1 text-ui font-medium text-fg">{tr('codexImport.title')}</span>
        {!(fresh && local && !isDemo) && (
          <Button
            icon={RotateCw}
            className="h-7 px-2.5 text-meta"
            disabled={!local || isDemo || state.running}
            onClick={() => void readCodexSessions()}
          >
            {tr(state.running ? 'codexImport.reading' : 'codexImport.refresh')}
          </Button>
        )}
      </div>
      <p className="mt-2 text-meta text-fg-muted">{tr('codexImport.intro')}</p>
      <p className="mt-1 text-label text-fg-faint">{tr('codexImport.sourcePolicy')}</p>
      {!local ? (
        <div className="mt-3 flex items-center gap-3 text-meta text-fg-muted">
          <span className="flex-1">{tr('codexImport.local')}</span>
          <Button onClick={() => runMainAction({ kind: 'selectLocalMachine' })}>{tr('resume.scan.switchLocal')}</Button>
        </div>
      ) : isDemo ? (
        <p className="mt-3 text-meta text-fg-muted">{tr('codexImport.demo')}</p>
      ) : (
        <>
          {fresh && (
            <div data-codex-import-start className="mt-3 flex items-center gap-3 rounded-md bg-subtle px-3 py-2.5">
              <span className="min-w-0 flex-1 text-meta text-fg-secondary">{tr('codexImport.startHint')}</span>
              <Button variant="primary" className="shrink-0" onClick={() => void readCodexSessions()}>
                {tr('codexImport.start')}
              </Button>
            </div>
          )}
          {state.running && (
            <div role="status" className="mt-3 flex items-center gap-2 text-meta text-fg-muted">
              <Spinner />
              {tr('codexImport.readingAll')}
            </div>
          )}
          {state.error && (
            <p role="alert" className="mt-3 text-meta text-danger">
              {translateMessage(state.error)}
            </p>
          )}
          {result && (
            <>
              <p role="status" className="mt-3 text-meta text-fg-secondary">
                {tr('codexImport.summary', {
                  projects: result.addedProjects,
                  imported: result.groups.reduce((n, g) => n + g.imported, 0),
                  existing: result.groups.reduce((n, g) => n + g.existing, 0),
                  updated: result.groups.reduce((n, g) => n + g.updated, 0),
                })}
                <span className="text-fg-faint"> · {tr('codexImport.window')}</span>
              </p>
              <div className="mt-2 max-h-[420px] space-y-2 overflow-y-auto">
                {result.groups.map(group => (
                  <details
                    key={group.projectId}
                    open={group.projectId === CHAT_PROJECT_ID || result.groups.length === 1}
                    className="rounded-md border border-line-subtle"
                  >
                    <summary className="cursor-pointer px-3 py-2 text-meta text-fg">
                      {group.projectId === CHAT_PROJECT_ID
                        ? tr('codexImport.outside')
                        : (projects.find(p => p.id === group.projectId)?.name ?? group.projectId)}
                      <span className="ml-2 text-fg-muted">
                        {tr('codexImport.count', { n: group.sessionIds.length, total: group.total })}
                      </span>
                    </summary>
                    <SessionRows
                      sessions={group.sessionIds.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []))}
                      onOpen={open}
                    />
                  </details>
                ))}
              </div>
              {!result.groups.length && !state.running && (
                <p className="mt-2 text-meta text-fg-muted">{tr('codexImport.empty')}</p>
              )}
              {!!(result.warnings.length || result.failed.length) && (
                <div data-codex-import-problems className="mt-3 rounded-md bg-warn/10 px-3 py-2 text-meta text-warn-fg">
                  <p className="font-medium">
                    {/* 只列有的那一种：没有失败时不写「0 个会话读取失败」 */}
                    {[
                      result.failed.length && tr('codexImport.failures', { n: result.failed.length }),
                      result.warnings.length && tr('codexImport.notices', { n: result.warnings.length }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <ul className="mt-1 max-h-32 list-disc overflow-auto pl-4 break-all">
                    {result.warnings.map((warning, i) => (
                      <li key={i}>{translateMessage(warning)}</li>
                    ))}
                    {result.failed.map(f => (
                      <li key={f.id}>
                        {f.title}：{translateMessage(f.error)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function SessionRows({ sessions, onOpen }: { sessions: SessionSummary[]; onOpen: (id: string) => void }) {
  const [limit, setLimit] = useState(50)
  return (
    <div className="max-h-64 overflow-auto border-t border-line-subtle">
      {sessions.slice(0, limit).map(({ record }) => (
        <button
          type="button"
          key={record.id}
          data-codex-import-session={record.id}
          onClick={() => onOpen(record.id)}
          className="flex w-full items-center gap-3 px-3 py-2 text-left text-meta hover:bg-subtle"
        >
          <span className="min-w-0 flex-1 truncate text-fg">{record.title}</span>
          {record.archivedAt !== null && <span className="text-label text-fg-faint">{tr('codexImport.archived')}</span>}
          <span className="shrink-0 text-label text-fg-faint">{relativeTime(record.updatedAt)}</span>
          <span className="shrink-0 text-accent-fg">{tr('codexImport.open')}</span>
        </button>
      ))}
      {sessions.length > limit && (
        <Button variant="ghost" onClick={() => setLimit(n => n + 50)}>
          {tr('codexImport.more')}
        </Button>
      )}
    </div>
  )
}
