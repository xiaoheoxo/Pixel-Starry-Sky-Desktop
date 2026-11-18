// 机器页 SSH 机器卡片上的「执行机」一行（docs/multica-learn.md §11.7）：设为执行机 / 状态 / 停用。
// 只在 Linux 机器、或已经装过执行机的机器上显示；状态打开时读一次，之后每 15 秒读一次
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { translateMessage } from '@/i18n/core'
import { isDemo } from '@/data'
import { cleanIpcError } from '@/features/account/useStore'
import type { MachineInfo } from '../../../../shared/types/machines'
import type { RunnerView } from '../../../../shared/types/runner'

const REFRESH_MS = 15_000

/** 所有机器的执行机状态；revision 变了（机器连上 / 断开）也重读 */
export function useRunners(revision: string | null): { list: RunnerView[]; reload: () => Promise<void> } {
  const [list, setList] = useState<RunnerView[]>([])
  const reload = useCallback(async () => {
    const api = window.pixelsky?.channels
    if (isDemo || !api?.runners) return
    try {
      setList(await api.runners())
    } catch {
      // 读不到（团队功能没开、没登录）：不显示
    }
  }, [])
  useEffect(() => {
    // null：机器页没打开，不读
    if (revision === null) return
    void reload()
    const timer = window.setInterval(() => void reload(), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [reload, revision])
  return { list, reload }
}

export function RunnerRow({
  machine,
  view,
  reload,
}: {
  machine: MachineInfo
  view: RunnerView | undefined
  reload: () => Promise<void>
}) {
  const { t, locale } = useI18n()
  const [busy, setBusy] = useState<'install' | 'remove' | null>(null)
  const [error, setError] = useState('')
  const [linger, setLinger] = useState<boolean | null>(null)
  const [confirm, setConfirm] = useState(false)
  if (!view) return null
  const run = async (kind: 'install' | 'remove', action: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(translateMessage(cleanIpcError(e, String(e)), locale))
    } finally {
      setBusy(null)
      await reload()
    }
  }
  const install = (): void =>
    void run('install', async () => {
      const result = await window.pixelsky!.channels.runnerInstall(machine.id)
      setLinger(result.linger)
    })
  const local = view.local
  const noLinger = linger === false || (local?.installed && !local.linger)
  const auth = local?.auth
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-meta text-fg">{t('runner.title')}</strong>
        {view.runnerId && (
          <span className={'text-meta ' + (view.online ? 'text-success' : 'text-fg-muted')}>
            {t(view.online ? 'runner.online' : 'runner.offline')}
            {view.version ? ` · ${view.version}` : ''}
          </span>
        )}
        {local?.installed && view.runnerId && (
          <span className="text-meta text-fg-muted">
            {t('runner.load', { running: String(local.running), queued: String(local.queued) })}
          </span>
        )}
        <span className="flex-1" />
        {view.installable && (
          <Button disabled={!!busy} onClick={install}>
            {busy === 'install' ? t('runner.installing') : t(view.runnerId ? 'runner.reinstall' : 'runner.install')}
          </Button>
        )}
        {view.runnerId && (
          <Button disabled={!!busy} onClick={() => setConfirm(true)}>
            {t('runner.remove')}
          </Button>
        )}
      </div>
      {!view.runnerId && <p className="mt-1 text-meta text-fg-muted">{t('runner.intro')}</p>}
      {view.runnerId && (
        <p className="mt-1 text-meta text-fg-muted">
          {view.members.length ? t('runner.members', { count: String(view.members.length) }) : t('runner.noMembers')}
        </p>
      )}
      {!view.installable && !view.runnerId && (
        <p className="mt-1 text-meta text-fg-muted">
          {t(machine.status === 'connected' ? 'runner.needLinux' : 'runner.needConnect')}
        </p>
      )}
      {local && !local.mine && <p className="mt-1 text-meta text-warn">{t('runner.notMine')}</p>}
      {auth === 'revoked' && <p className="mt-1 text-meta text-warn">{t('runner.revoked')}</p>}
      {auth === 'seats' && <p className="mt-1 text-meta text-warn">{t('runner.seats')}</p>}
      {noLinger && (
        <p className="mt-1 break-words text-meta text-warn">{t('runner.linger', { user: machine.username })}</p>
      )}
      {(error || view.error) && (
        <p role="alert" className="mt-1 break-words text-meta text-danger">
          {t('runner.failed', { error: error || translateMessage(view.error, locale) })}
        </p>
      )}
      {confirm && (
        <ConfirmDialog
          title={t('runner.removeTitle')}
          description={t('runner.removeBody')}
          confirmLabel={t('runner.remove')}
          cancelLabel={t('wakeup.dialog.cancel')}
          danger
          busy={busy === 'remove'}
          onConfirm={() => {
            setConfirm(false)
            void run('remove', () => window.pixelsky!.channels.runnerRemove(machine.id))
          }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </div>
  )
}
