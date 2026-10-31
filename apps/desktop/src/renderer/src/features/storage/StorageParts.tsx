// 设置 › 存储里几块共用的小部件：卡片和行、会话行、勾选删除的逻辑、选择栏、失败列表。
import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { idleLabel } from '../sidebar/archiveOld'
import type { StorageSession } from '../../../../shared/types/storage'
import { formatBytes } from './storageView'

/** 删掉了几个会话：ids 是删成功的，freed 是释放的字节数，failed 是没删掉的个数 */
export type OnDeleted = (ids: string[], freed: number, failed: number) => void

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-lg border border-line-card bg-surface', className)}>{children}</div>
}

export function Row({
  title,
  badge,
  description,
  action,
  children,
}: {
  title: string
  badge?: string | null
  description: string
  action: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="border-t border-line-subtle px-4 py-3 first:border-t-0">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-ui font-medium text-fg">
            {title}
            {badge && (
              <span className="rounded-full bg-subtle px-2 py-px text-meta font-normal text-fg-muted">{badge}</span>
            )}
          </div>
          <p className="mt-0.5 text-meta text-fg-muted">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

/** 名字为空的会话显示「未命名会话」 */
export function useTitle(): (s: StorageSession) => string {
  const { t } = useI18n()
  return s => s.title.trim() || t('storage.untitled')
}

/** 一行会话：勾选框、标题和项目、多久没动、大小；extra 放在大小后面（恢复按钮） */
export function SessionRow({
  session,
  checked,
  disabled,
  now,
  onToggle,
  extra,
}: {
  session: StorageSession
  checked: boolean
  disabled: boolean
  now: number
  onToggle: (on: boolean) => void
  extra?: ReactNode
}) {
  const { t } = useI18n()
  const title = useTitle()(session)
  const ago = idleLabel(session.updatedAt, now)
  return (
    <div className="flex items-center gap-2.5 rounded-md px-1.5 py-1 hover:bg-hover">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={t('storage.pick', { title })}
        onChange={e => onToggle(e.target.checked)}
      />
      <label className="min-w-0 flex-1 cursor-pointer" onClick={() => !disabled && onToggle(!checked)}>
        <div className="truncate text-fg">{title}</div>
        <div className="truncate text-meta text-fg-faint">{session.projectName ?? t('storage.noProject')}</div>
      </label>
      <span className="w-16 shrink-0 text-right text-meta text-fg-faint">{t(ago.key, { n: ago.n })}</span>
      <span className="w-16 shrink-0 text-right text-meta text-fg-muted tabular-nums">
        {formatBytes(session.bytes)}
      </span>
      {extra}
    </div>
  )
}

/** 勾选、删除一批会话：两个对话框共用 */
export function useDeletion(list: readonly StorageSession[], onDeleted: OnDeleted, onClose: () => void) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<Array<{ title: string; message: string }>>([])
  const title = useTitle()
  // 列表变了（换了天数、删掉了几个）：只留还在列表里的勾选
  const visible = useMemo(() => new Set(list.map(s => s.id)), [list])
  const selected = list.filter(s => picked.has(s.id) && visible.has(s.id))
  const bytes = selected.reduce((sum, s) => sum + s.bytes, 0)
  const toggle = (id: string, on: boolean): void =>
    setPicked(prev => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const toggleAll = (on: boolean): void => setPicked(on ? new Set(list.map(s => s.id)) : new Set())
  const run = async (): Promise<void> => {
    const bridge = window.pixelsky?.storage
    if (!bridge || !selected.length) return
    setBusy(true)
    setFailed([])
    try {
      const result = await bridge.deleteSessions(selected.map(s => s.id))
      const done = new Set(result.done)
      const freed = selected.filter(s => done.has(s.id)).reduce((sum, s) => sum + s.bytes, 0)
      onDeleted(result.done, freed, result.failed.length)
      if (result.failed.length) {
        const byId = new Map(selected.map(s => [s.id, s]))
        setFailed(
          result.failed.map(f => ({ title: byId.has(f.id) ? title(byId.get(f.id)!) : f.id, message: f.message })),
        )
        setPicked(new Set(result.failed.map(f => f.id)))
      } else onClose()
    } catch (e) {
      setFailed([{ title: '', message: String((e as Error)?.message ?? e) }])
    } finally {
      setBusy(false)
    }
  }
  return { picked, selected, bytes, busy, failed, toggle, toggleAll, run }
}

export function SelectionBar({
  total,
  selected,
  bytes,
  disabled,
  onToggleAll,
  children,
}: {
  total: number
  selected: number
  bytes: number
  disabled: boolean
  onToggleAll: (on: boolean) => void
  children?: ReactNode
}) {
  const { t } = useI18n()
  return (
    <div className="mt-3 flex items-center gap-2.5 border-y border-line-subtle bg-subtle px-1.5 py-1.5 text-meta text-fg-muted">
      <input
        type="checkbox"
        disabled={disabled || total === 0}
        aria-label={t('storage.selectAll')}
        checked={total > 0 && selected === total}
        onChange={e => onToggleAll(e.target.checked)}
      />
      <span className="flex-1">
        {selected ? t('storage.selected', { n: selected, size: formatBytes(bytes) }) : t('storage.noneSelected')}
      </span>
      {children}
    </div>
  )
}

export function FailedList({ failed }: { failed: Array<{ title: string; message: string }> }) {
  if (!failed.length) return null
  return (
    <ul className="mt-3 flex flex-col gap-0.5 text-meta text-danger">
      {failed.map((f, i) => (
        <li key={i} className="break-words">
          {f.title ? `${f.title}: ${f.message}` : f.message}
        </li>
      ))}
    </ul>
  )
}
