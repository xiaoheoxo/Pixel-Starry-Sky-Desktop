// 设置 › 存储：本机数据目录的占用（分类色条）和清理入口——清理旧会话、已归档的会话、项目副本、界面缓存。
// 数据由主进程统计（main/storage），这里只显示和发起操作；删掉、恢复之后在本地更新统计结果，不重新扫一遍。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, RefreshCw, X } from 'lucide-react'
import { Button, cn } from '@/ui'
import { Toast } from '@/ui/Toast'
import { useI18n } from '@/i18n/I18nProvider'
import { SectionTitle } from '../settings/SettingRow'
import type { StoragePartKey, StorageUsage } from '../../../../shared/types/storage'
import { ArchivedDialog } from './ArchivedDialog'
import { CopiesList } from './CopiesList'
import { DEFAULT_DAYS, OldSessionsDialog } from './OldSessionsDialog'
import { Card, Row } from './StorageParts'
import {
  archivedSessions,
  formatBytes,
  oldSessions,
  percentLabel,
  segments,
  totalBytes,
  withRestored,
  withoutSessions,
} from './storageView'

/** 每类的颜色：沿用用量图表的配色变量，深浅色和各套配色都自带 */
const PART_COLOR: Record<StoragePartKey, string> = {
  sessions: 'var(--chart-cache)',
  archived: 'var(--chart-bar-output)',
  copies: 'var(--chart-input)',
  cache: 'var(--chart-output)',
  logs: 'var(--warn)',
  other: 'var(--text-faint)',
}

export function StorageSection({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const { t } = useI18n()
  const bridge = window.pixelsky?.storage
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'old' | 'archived' | null>(null)
  const [copiesOpen, setCopiesOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [hover, setHover] = useState<StoragePartKey | null>(null)

  const load = useCallback(
    async (force: boolean) => {
      if (!bridge) return
      setScanning(true)
      setError(null)
      try {
        setUsage(await bridge.usage(force))
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
      } finally {
        setScanning(false)
      }
    },
    [bridge],
  )
  useEffect(() => {
    void load(false)
  }, [load])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  const now = usage?.scannedAt ?? 0
  const oldCount = useMemo(
    () =>
      usage ? oldSessions(usage.sessions, { days: DEFAULT_DAYS, includeArchived: false, sort: 'time', now }).length : 0,
    [usage, now],
  )
  const archivedCount = useMemo(() => (usage ? archivedSessions(usage.sessions).length : 0), [usage])

  if (!bridge)
    return (
      <section>
        <SectionTitle>{t('storage.title')}</SectionTitle>
        <p className="text-meta text-fg-muted">{t('storage.unavailable')}</p>
      </section>
    )

  const segs = usage ? segments(usage) : []
  const onDeleted = (ids: string[], freed: number, failed: number): void => {
    if (ids.length) setUsage(u => (u ? withoutSessions(u, ids) : u))
    const parts = [ids.length ? t('storage.deleted', { n: ids.length, size: formatBytes(freed) }) : null]
    if (failed) parts.push(t('storage.deleteFailed', { n: failed }))
    setToast(parts.filter(Boolean).join(' · '))
  }
  const clearCache = async (): Promise<void> => {
    setClearing(true)
    try {
      const freed = await bridge.clearCache()
      setToast(t('storage.cacheCleared', { size: formatBytes(freed) }))
      void load(true)
    } catch (e) {
      setToast(String((e as Error)?.message ?? e))
    } finally {
      setClearing(false)
    }
  }

  return (
    <section data-storage-section>
      <SectionTitle>{t('storage.title')}</SectionTitle>

      <h4 className="text-ui font-semibold text-fg">{t('storage.device')}</h4>
      <p className="mt-1 mb-4 text-meta text-fg-muted">{t('storage.deviceDesc')}</p>

      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-ui font-medium text-fg tabular-nums">
          {usage ? t('storage.total', { size: formatBytes(totalBytes(usage)) }) : t('storage.scanning')}
        </div>
        <Button variant="ghost" className="h-7 px-2 text-meta" disabled={scanning} onClick={() => void load(true)}>
          <RefreshCw size={13} strokeWidth={1.75} className={cn(scanning && 'animate-spin')} />
          {scanning ? t('storage.scanning') : t('storage.rescan')}
        </Button>
      </div>

      <div
        className="flex h-5 gap-0.5 overflow-hidden rounded-md bg-subtle"
        role="img"
        aria-label={segs.map(s => `${t(`storage.part.${s.key}`)} ${formatBytes(s.bytes)}`).join(', ')}
      >
        {segs.map(s => (
          <div
            key={s.key}
            title={`${t(`storage.part.${s.key}`)} · ${formatBytes(s.bytes)} · ${t('storage.percent', { n: percentLabel(s.percent) })}\n${t(`storage.partDesc.${s.key}`)}`}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
            className="h-full min-w-[3px] transition-[width,opacity] duration-500"
            style={{
              width: `${s.percent}%`,
              background: PART_COLOR[s.key],
              opacity: hover && hover !== s.key ? 0.35 : 1,
            }}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        {segs.map(s => (
          <div
            key={s.key}
            className="min-w-16 cursor-default"
            title={t(`storage.partDesc.${s.key}`)}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          >
            <div className="flex items-center gap-1.5 text-meta text-fg-secondary">
              <span className="size-2 shrink-0 rounded-full" style={{ background: PART_COLOR[s.key] }} />
              {t(`storage.part.${s.key}`)}
            </div>
            <div className="mt-0.5 pl-3.5 text-meta text-fg-muted tabular-nums">
              {scanning ? t('storage.scanning') : formatBytes(s.bytes)}
            </div>
          </div>
        ))}
      </div>

      {usage && (
        <div className="mt-3 flex min-w-0 items-center gap-2 text-meta text-fg-faint">
          <span className="min-w-0 truncate font-mono" title={usage.root}>
            {usage.root}
          </span>
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 text-accent-fg hover:underline"
            onClick={() => void bridge.open().catch((e: unknown) => setToast(String((e as Error)?.message ?? e)))}
          >
            <FolderOpen size={12} strokeWidth={1.75} />
            {t('storage.openFolder')}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-meta text-danger">{error}</p>}

      <Card className="mt-6">
        <Row
          title={t('storage.oldTitle')}
          badge={usage && oldCount > 0 ? t('storage.oldCount', { n: oldCount, days: DEFAULT_DAYS }) : null}
          description={t('storage.oldDesc')}
          action={
            <Button className="h-7 px-3 text-meta" disabled={!usage} onClick={() => setDialog('old')}>
              {t('storage.review')}
            </Button>
          }
        />
      </Card>

      <Card className="mt-4">
        <Row
          title={t('storage.archivedTitle')}
          badge={usage ? t('storage.archivedCount', { n: archivedCount }) : null}
          description={t('storage.archivedDesc')}
          action={
            <Button className="h-7 px-3 text-meta" disabled={!usage} onClick={() => setDialog('archived')}>
              {t('storage.manage')}
            </Button>
          }
        />
        <Row
          title={t('storage.copiesTitle')}
          badge={usage ? t('storage.copiesCount', { n: usage.copies.length }) : null}
          description={t('storage.copiesDesc')}
          action={
            <Button
              className="h-7 px-3 text-meta"
              disabled={!usage}
              aria-expanded={copiesOpen}
              onClick={() => setCopiesOpen(o => !o)}
            >
              {copiesOpen ? t('storage.collapse') : t('storage.review')}
            </Button>
          }
        >
          {copiesOpen && usage && <CopiesList copies={usage.copies} />}
        </Row>
        <Row
          title={t('storage.cacheTitle')}
          badge={usage ? formatBytes(usage.parts.cache) : null}
          description={t('storage.cacheDesc')}
          action={
            <Button className="h-7 px-3 text-meta" disabled={clearing} onClick={() => void clearCache()}>
              {t('storage.clearCache')}
            </Button>
          }
        />
      </Card>

      {dialog === 'old' && usage && (
        <OldSessionsDialog usage={usage} onClose={() => setDialog(null)} onDeleted={onDeleted} />
      )}
      {dialog === 'archived' && usage && (
        <ArchivedDialog
          usage={usage}
          onClose={() => setDialog(null)}
          onDeleted={onDeleted}
          onRestored={(id, title) => {
            setUsage(u => (u ? withRestored(u, id) : u))
            setToast(t('storage.restored', { title }))
          }}
          onOpen={id => {
            setDialog(null)
            onOpenSession(id)
          }}
        />
      )}
      {toast && (
        <Toast className="py-2.5 text-list">
          <span className="min-w-0 break-words">{toast}</span>
          <button
            aria-label={t('storage.close')}
            onClick={() => setToast(null)}
            className="shrink-0 rounded-sm p-1 text-fg-muted hover:bg-hover"
          >
            <X size={14} />
          </button>
        </Toast>
      )}
    </section>
  )
}
