import { useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { Toast } from '@/ui/Toast'
import { useI18n } from '@/i18n/I18nProvider'
import { useSettings } from '@/features/settings/SettingsProvider'
import { getMachines, machineOf } from '@/features/machines/store'
import { pendingIds } from './archivedDelete'
import {
  archivedNow,
  chatFolders,
  closeArchivedDelete,
  deleteArchived,
  useArchivedDeleteRequest,
  type ArchivedDeleteRequest,
} from './archivedDeleteData'

/**
 * 侧栏「已归档 N 个」› 删除全部已归档对话（docs/ui/archived-bulk-delete.md）。
 * 确认框关掉后还留着「已删除 N 个」的提示，所以挂在应用根上
 */
export function ArchivedDeleteHost() {
  const { t } = useI18n()
  const request = useArchivedDeleteRequest()
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])
  return (
    <>
      {request && (
        <ArchivedDeleteDialog
          request={request}
          onFinished={count => {
            closeArchivedDelete()
            if (count) setToast(t('archivedDelete.toast', { count }))
          }}
        />
      )}
      {toast && (
        <Toast data-archived-delete-toast className="py-2.5 text-list">
          <span className="min-w-0 break-words">{toast}</span>
          <button
            aria-label={t('session.dismiss')}
            onClick={() => setToast(null)}
            className="shrink-0 rounded-sm p-1 text-fg-muted hover:bg-hover"
          >
            <X size={14} />
          </button>
        </Toast>
      )}
    </>
  )
}

type Phase = 'ask' | 'run' | 'partial'

function ArchivedDeleteDialog({
  request,
  onFinished,
}: {
  request: ArchivedDeleteRequest
  onFinished: (deleted: number) => void
}) {
  const { t } = useI18n()
  const settings = useSettings()
  const { scope, sessions } = request
  const [phase, setPhase] = useState<Phase>('ask')
  const [done, setDone] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map())
  const [progress, setProgress] = useState({ n: 0, total: 0 })
  const [files, setFiles] = useState<{ folders: number; items: string } | null>(null)
  // 连点两下确认：状态还没变成「删除中」前不再开第二轮
  const working = useRef(false)
  const machine = machineOf(sessions[0]?.id),
    remote = machine !== 'local',
    machineName = getMachines().machines.find(m => m.id === machine)?.name || machine
  const chat = scope.kind === 'chat'

  useEffect(() => {
    if (!chat) return
    let alive = true
    void chatFolders(sessions.map(s => s.id)).then(summary => alive && setFiles(summary))
    return () => {
      alive = false
    }
  }, [chat, sessions])

  const run = async (): Promise<void> => {
    if (working.current) return
    working.current = true
    const ids = pendingIds(sessions, done, archivedNow)
    const nextDone = new Set(done),
      nextFailed = new Map<string, string>()
    setFailed(nextFailed)
    setPhase('run')
    setProgress({ n: 0, total: ids.length })
    for (const [i, id] of ids.entries()) {
      setProgress({ n: i + 1, total: ids.length })
      try {
        await deleteArchived(id)
        nextDone.add(id)
      } catch (error) {
        nextFailed.set(id, (error as Error).message)
      }
      setDone(new Set(nextDone))
      setFailed(new Map(nextFailed))
    }
    working.current = false
    if (nextFailed.size) setPhase('partial')
    else onFinished(nextDone.size)
  }

  const openSettings = (): void => {
    closeArchivedDelete()
    settings.openSettings('storage')
  }

  const running = phase === 'run',
    partial = phase === 'partial',
    left = failed.size
  const title = partial
    ? t('archivedDelete.partialTitle', { done: done.size, left })
    : scope.kind === 'project'
      ? t('archivedDelete.titleProject', { name: scope.name, count: sessions.length })
      : t('archivedDelete.titleChat', { count: sessions.length })
  const desc = chat
    ? remote
      ? 'archivedDelete.descChatRemote'
      : 'archivedDelete.descChat'
    : remote
      ? 'archivedDelete.descRemote'
      : 'archivedDelete.desc'

  return (
    <ConfirmDialog
      danger
      title={title}
      description={
        <div data-archived-delete>
          {partial ? (
            <p>{t('archivedDelete.partialDesc')}</p>
          ) : (
            <>
              <p>{t(desc)}</p>
              {chat && files && (
                <p className="mt-2">{t(remote ? 'archivedDelete.filesRemote' : 'archivedDelete.files', files)}</p>
              )}
              {remote && <p className="mt-2">{t('archivedDelete.remote', { name: machineName })}</p>}
            </>
          )}
          <ul className="mt-3 max-h-44 overflow-y-auto rounded-lg border border-line-subtle py-1 [scrollbar-width:thin]">
            {sessions.map(s => {
              const ok = done.has(s.id),
                why = failed.get(s.id)
              return (
                <li
                  key={s.id}
                  data-archived-delete-item={ok ? 'done' : why ? 'failed' : undefined}
                  className="flex min-w-0 items-center gap-2 px-2.5 py-0.5 text-meta"
                >
                  {phase !== 'ask' && (
                    <span className="flex w-3.5 shrink-0 justify-center">
                      {ok ? (
                        <Check size={13} strokeWidth={2} className="text-success" />
                      ) : why ? (
                        <X size={13} strokeWidth={2} className="text-danger" />
                      ) : null}
                    </span>
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      ok ? 'text-fg-faint line-through' : why ? 'text-danger' : 'text-fg',
                    )}
                  >
                    {s.title}
                  </span>
                  {why ? (
                    <span title={why} className="max-w-[45%] shrink-0 truncate text-danger">
                      {why}
                    </span>
                  ) : (
                    s.time && <span className="shrink-0 text-fg-faint">{s.time}</span>
                  )}
                </li>
              )
            })}
          </ul>
          {phase === 'ask' && !remote && (
            <p className="mt-2 text-meta text-fg-muted">
              {t('archivedDelete.pickHint')}
              <button type="button" onClick={openSettings} className="text-accent-fg underline">
                {t('archivedDelete.pickLink')}
              </button>
            </p>
          )}
        </div>
      }
      confirmLabel={
        running
          ? t('archivedDelete.running', progress)
          : partial
            ? t('archivedDelete.retry', { count: left })
            : t('archivedDelete.confirm', { count: sessions.length })
      }
      cancelLabel={t(partial ? 'archivedDelete.close' : 'session.cancel')}
      busy={running}
      onConfirm={() => void run()}
      onCancel={() => onFinished(done.size)}
    />
  )
}
