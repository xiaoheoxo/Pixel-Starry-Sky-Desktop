import { translateMessage } from '../../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { RequestRetryState } from '@pixelsky/protocol'
import { Button } from '@/ui'
import { bridge } from '@/features/engine'

export function RetryStatus({ sessionId, retry }: { sessionId: string; retry: RequestRetryState | null | undefined }) {
  useI18n()
  const [now, setNow] = useState(Date.now)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stopping = useRef(false)
  useEffect(() => {
    setBusy(false)
    setError(null)
    stopping.current = false
  }, [sessionId, retry?.turnId])
  useEffect(() => {
    setNow(Date.now())
    if (!retry?.retryAt) return
    const tick = (): void => setNow(Date.now())
    const timer = window.setInterval(tick, 200)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [retry?.retryAt])
  if (!retry) return null
  const seconds = retry.retryAt === null ? null : Math.max(0, Math.ceil((retry.retryAt - now) / 1000))
  const attempt =
    retry.attempt === null ? '' : ` ${retry.attempt}${retry.maxRetries === null ? '' : `/${retry.maxRetries}`}`
  const stop = async (): Promise<void> => {
    if (!bridge || stopping.current) return
    stopping.current = true
    setBusy(true)
    setError(null)
    try {
      await bridge.interruptTurn(sessionId, retry.turnId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      stopping.current = false
      setBusy(false)
    }
  }
  return (
    <div
      role="status"
      aria-label={tr('session.live.RetryStatus.requestRetryProgress')}
      className="mb-2 rounded-lg border border-line-card bg-popover px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <RotateCw size={14} strokeWidth={1.5} className="shrink-0 text-warn" />
          <span className="text-meta text-fg-secondary tabular-nums">
            {translateMessage(retry.reason)}
            {tr('session.live.RetryStatus.retrying')}
            {attempt}
            {seconds !== null
              ? seconds > 0
                ? tr('session.live.RetryStatus.resumingInAboutS', { p0: seconds })
                : tr('session.live.RetryStatus.retryingRequest')
              : ''}
          </span>
        </div>
        <Button variant="ghost" className="h-7 px-2 text-meta" disabled={busy} onClick={() => void stop()}>
          {busy ? tr('session.CacheMissAlerts.stopping') : tr('session.Composer.stop')}
        </Button>
      </div>
      {error && <p className="mt-1 text-meta text-danger">{translateMessage(error)}</p>}
    </div>
  )
}
