// 设置 › 存储 › 数据位置（docs/ui/data-location.md §5）：显示路径、打开、换位置（选 → 检查 → 确认 → 重启时搬）、
// 接回已有数据、取消排好的搬家、删旧数据
import { useCallback, useEffect, useState } from 'react'
import { FolderInput, FolderOpen } from 'lucide-react'
import { Button } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { SettingRow } from '../settings/SettingRow'
import type { DataLocationInfo } from '../../../../shared/types/data-location'
import { formatBytes } from './storageView'

type Pending = { kind: 'move'; path: string; bytes: number } | { kind: 'use'; path: string }

export function DataLocationRow() {
  const { t } = useI18n()
  const bridge = window.pixelsky?.dataLocation
  const [info, setInfo] = useState<DataLocationInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState<Pending | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!bridge) return
    setInfo(await bridge.info())
  }, [bridge])
  useEffect(() => {
    void load().catch(e => setError(String((e as Error)?.message ?? e)))
  }, [load])

  if (!bridge || !info) return null

  /** 返回 true 表示做成了；出错时报错显示在打开着的弹窗里或这一行下面 */
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const choose = (): Promise<boolean> =>
    run(async () => {
      const choice = await bridge.choose()
      if (choice.kind === 'problem') setError(t(`dataLocation.problem.${choice.problem}`))
      else if (choice.kind === 'ready') setReady({ kind: 'move', path: choice.path, bytes: choice.bytes })
      else if (choice.kind === 'existing') setReady({ kind: 'use', path: choice.path })
    })

  /** 弹窗里的确认：做完关掉弹窗、刷新（退出确认里点了取消时应用还开着，要看得到「重启后会搬到…」） */
  const confirm = async (): Promise<void> => {
    if (!ready) return
    const done = await run(() => (ready.kind === 'move' ? bridge.move(ready.path) : bridge.use(ready.path)))
    if (!done) return
    setReady(null)
    await load().catch(() => undefined)
  }

  const after = async (fn: () => Promise<void>): Promise<void> => {
    if (await run(fn)) await load().catch(() => undefined)
  }

  return (
    <SettingRow title={t('dataLocation.title')} description={t('dataLocation.description')}>
      <div data-data-location className="flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-meta text-fg-muted">{t('settingsStorage.dataPath')}</span>
        <code
          className="min-w-0 flex-1 truncate rounded-md bg-subtle px-2.5 py-1.5 text-meta text-fg"
          title={info.path}
        >
          {info.path}
        </code>
        <Button
          variant="ghost"
          icon={FolderOpen}
          disabled={busy}
          onClick={() => void run(() => window.pixelsky!.app.open('data-dir'))}
        >
          {t('dataLocation.open')}
        </Button>
        <Button variant="outline" icon={FolderInput} disabled={busy || !!info.pending} onClick={() => void choose()}>
          {t('dataLocation.change')}
        </Button>
      </div>
      {info.inAppData && !info.pending && <p className="mt-2 text-meta text-fg-faint">{t('dataLocation.inAppData')}</p>}
      {info.pending && (
        <div data-data-location-pending className="mt-2 flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-meta text-fg-muted">{t('dataLocation.pending', { path: info.pending })}</p>
          <Button
            variant="ghost"
            className="h-7 px-2 text-meta"
            disabled={busy}
            onClick={() => void after(() => bridge.cancelMove())}
          >
            {t('dataLocation.cancelMove')}
          </Button>
        </div>
      )}
      {info.error && (
        <div data-data-location-error className="mt-2 flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-meta text-warn">{t('dataLocation.moveFailed', { error: info.error })}</p>
          <Button
            variant="ghost"
            className="h-7 px-2 text-meta"
            disabled={busy}
            onClick={() => void after(() => bridge.dismiss())}
          >
            {t('dataLocation.dismissError')}
          </Button>
        </div>
      )}
      {info.previous && (
        <div
          data-data-location-previous
          className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-subtle px-3 py-2"
        >
          <span className="min-w-0 flex-1 truncate text-meta text-fg-muted" title={info.previous}>
            {t('dataLocation.previous', { path: info.previous })}
          </span>
          <Button
            variant="ghost"
            className="h-7 px-2 text-meta"
            disabled={busy}
            onClick={() => void after(() => bridge.dismiss())}
          >
            {t('dataLocation.keepOld')}
          </Button>
          <Button
            variant="outline"
            className="h-7 px-2 text-meta"
            disabled={busy}
            onClick={() => setConfirmRemove(true)}
          >
            {t('dataLocation.removeOld')}
          </Button>
        </div>
      )}
      {error && !ready && !confirmRemove && (
        <p role="alert" className="mt-2 text-meta text-danger">
          {error}
        </p>
      )}
      {ready && (
        <ConfirmDialog
          title={t(ready.kind === 'move' ? 'dataLocation.confirmTitle' : 'dataLocation.useTitle')}
          description={
            ready.kind === 'move'
              ? t('dataLocation.confirmBody', { size: formatBytes(ready.bytes), path: ready.path })
              : t('dataLocation.useBody', { path: ready.path })
          }
          confirmLabel={t(ready.kind === 'move' ? 'dataLocation.confirm' : 'dataLocation.useConfirm')}
          cancelLabel={t('dataLocation.cancel')}
          busy={busy}
          error={error}
          warn
          onConfirm={() => void confirm()}
          onCancel={() => {
            setReady(null)
            setError(null)
          }}
        />
      )}
      {confirmRemove && info.previous && (
        <ConfirmDialog
          title={t('dataLocation.removeOldTitle')}
          description={t('dataLocation.removeOldBody', { path: info.previous })}
          confirmLabel={t('dataLocation.removeOld')}
          cancelLabel={t('dataLocation.cancel')}
          busy={busy}
          error={error}
          danger
          onConfirm={() =>
            void (async () => {
              if (!(await run(() => bridge.removeOld()))) return
              setConfirmRemove(false)
              await load().catch(() => undefined)
            })()
          }
          onCancel={() => {
            setConfirmRemove(false)
            setError(null)
          }}
        />
      )}
    </SettingRow>
  )
}
