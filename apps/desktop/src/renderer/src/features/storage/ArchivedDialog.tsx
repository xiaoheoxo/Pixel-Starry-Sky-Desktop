// 设置 › 存储 › 已归档的会话：逐个恢复、打开，或勾选后永久删除。
import { useMemo, useState } from 'react'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import type { StorageSession, StorageUsage } from '../../../../shared/types/storage'
import { FailedList, SelectionBar, SessionRow, useDeletion, useTitle, type OnDeleted } from './StorageParts'
import { archivedSessions } from './storageView'

export function ArchivedDialog({
  usage,
  onClose,
  onDeleted,
  onRestored,
  onOpen,
}: {
  usage: StorageUsage
  onClose: () => void
  onDeleted: OnDeleted
  onRestored: (id: string, title: string) => void
  onOpen: (id: string) => void
}) {
  const { t } = useI18n()
  const list = useMemo(() => archivedSessions(usage.sessions), [usage.sessions])
  const del = useDeletion(list, onDeleted, onClose)
  const title = useTitle()
  const [restoring, setRestoring] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const restore = async (s: StorageSession): Promise<void> => {
    setRestoring(s.id)
    setRestoreError(null)
    try {
      await window.pixelsky!.storage.restoreSession(s.id)
      del.toggle(s.id, false)
      onRestored(s.id, title(s))
    } catch (e) {
      setRestoreError(`${title(s)}: ${String((e as Error)?.message ?? e)}`)
    } finally {
      setRestoring(null)
    }
  }
  const busy = del.busy || restoring !== null
  return (
    <ConfirmDialog
      wide
      danger
      title={t('storage.archivedTitle')}
      description={
        <div data-storage-archived>
          <p>{t('storage.archivedDesc')}</p>
          <SelectionBar
            total={list.length}
            selected={del.selected.length}
            bytes={del.bytes}
            disabled={busy}
            onToggleAll={del.toggleAll}
          />
          {list.length === 0 ? (
            <p className="py-6 text-center text-fg-faint">{t('storage.emptyArchived')}</p>
          ) : (
            <div className="max-h-72 overflow-y-auto py-1 [scrollbar-width:thin]">
              {list.map(s => (
                <SessionRow
                  key={s.id}
                  session={s}
                  now={usage.scannedAt}
                  checked={del.picked.has(s.id)}
                  disabled={busy}
                  onToggle={on => del.toggle(s.id, on)}
                  extra={
                    <span className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onOpen(s.id)}
                        className="rounded-md px-2 py-0.5 text-meta text-fg-secondary hover:bg-selected disabled:opacity-50"
                      >
                        {t('storage.open')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void restore(s)}
                        className="rounded-md px-2 py-0.5 text-meta text-accent-fg hover:bg-selected disabled:opacity-50"
                      >
                        {t('storage.restore')}
                      </button>
                    </span>
                  }
                />
              ))}
            </div>
          )}
          {restoreError && <p className="mt-2 text-meta text-danger">{restoreError}</p>}
          <FailedList failed={del.failed} />
        </div>
      }
      busy={busy}
      confirmDisabled={del.selected.length === 0}
      confirmLabel={
        del.busy
          ? t('storage.deleting')
          : del.selected.length
            ? t('storage.deleteN', { n: del.selected.length })
            : t('storage.delete')
      }
      cancelLabel={t('storage.close')}
      onConfirm={() => void del.run()}
      onCancel={onClose}
    />
  )
}
