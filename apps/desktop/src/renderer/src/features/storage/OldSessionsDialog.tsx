// 设置 › 存储 › 清理旧会话：按多久没动筛出会话，勾选后永久删除。
import { useMemo, useState } from 'react'
import { Segmented } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { Select } from '@/ui/Select'
import { useI18n } from '@/i18n/I18nProvider'
import type { StorageUsage } from '../../../../shared/types/storage'
import { FailedList, SelectionBar, SessionRow, useDeletion, type OnDeleted } from './StorageParts'
import { oldSessions } from './storageView'

const DAY_PRESETS = ['7', '30', '90'] as const
type DayPreset = (typeof DAY_PRESETS)[number]
/** 打开对话框时默认选的天数；存储页上的「有几个」也按这个数 */
export const DEFAULT_DAYS = 30

export function OldSessionsDialog({
  usage,
  onClose,
  onDeleted,
}: {
  usage: StorageUsage
  onClose: () => void
  onDeleted: OnDeleted
}) {
  const { t } = useI18n()
  const [days, setDays] = useState<DayPreset>(`${DEFAULT_DAYS}`)
  const [sort, setSort] = useState<'size' | 'time'>('size')
  const [includeArchived, setIncludeArchived] = useState(false)
  const now = usage.scannedAt
  const list = useMemo(
    () => oldSessions(usage.sessions, { days: Number(days), includeArchived, sort, now }),
    [usage.sessions, days, includeArchived, sort, now],
  )
  const del = useDeletion(list, onDeleted, onClose)
  return (
    <ConfirmDialog
      wide
      danger
      title={t('storage.oldTitle')}
      description={
        <div data-storage-old>
          <p>{t('storage.oldDialogDesc')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-fg-secondary">
            <span>{t('storage.over')}</span>
            <Segmented
              label={t('storage.daysLabel')}
              disabled={del.busy}
              value={days}
              onChange={setDays}
              options={DAY_PRESETS.map(d => ({ value: d, label: d }))}
            />
            <span>{t('storage.daysIdle')}</span>
            <Select
              label={t('storage.sortLabel')}
              className="ml-auto w-28!"
              disabled={del.busy}
              value={sort}
              onChange={setSort}
              options={[
                { value: 'size', label: t('storage.sortSize') },
                { value: 'time', label: t('storage.sortTime') },
              ]}
            />
          </div>
          <SelectionBar
            total={list.length}
            selected={del.selected.length}
            bytes={del.bytes}
            disabled={del.busy}
            onToggleAll={del.toggleAll}
          >
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={includeArchived}
                disabled={del.busy}
                onChange={e => setIncludeArchived(e.target.checked)}
              />
              {t('storage.includeArchived')}
            </label>
          </SelectionBar>
          {list.length === 0 ? (
            <p className="py-6 text-center text-fg-faint">{t('storage.emptyOld', { days })}</p>
          ) : (
            <div className="max-h-72 overflow-y-auto py-1 [scrollbar-width:thin]">
              {list.map(s => (
                <SessionRow
                  key={s.id}
                  session={s}
                  now={now}
                  checked={del.picked.has(s.id)}
                  disabled={del.busy}
                  onToggle={on => del.toggle(s.id, on)}
                />
              ))}
            </div>
          )}
          <FailedList failed={del.failed} />
        </div>
      }
      busy={del.busy}
      confirmDisabled={del.selected.length === 0}
      confirmLabel={
        del.busy
          ? t('storage.deleting')
          : del.selected.length
            ? t('storage.deleteN', { n: del.selected.length })
            : t('storage.delete')
      }
      cancelLabel={t('session.cancel')}
      onConfirm={() => void del.run()}
      onCancel={onClose}
    />
  )
}
