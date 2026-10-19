import { translateMessage } from '../../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { useEffect, useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { QueuedMessage } from '@pixelsky/protocol'
import { Button, cn } from '@/ui'
import { bridge } from '@/features/engine'
import { isReconnecting, reconnectPhase } from '../queueView'

/** 断线后宿主正在自动重连（Codex 的 Reconnecting n/m）：倒计时、立即重连、停止；样子和 RetryStatus 一样。
 *  队列暂停时（比如重启后恢复出来的）不会自己重连：不转圈、没有进度条，给「继续重连」/「停止」 */
export function ReconnectStatus({
  sessionId,
  queue,
  paused,
}: {
  sessionId: string
  queue: QueuedMessage[] | undefined
  paused: boolean
}) {
  useI18n()
  const item = queue?.find(isReconnecting)
  const reconnect = item?.reconnect
  const [now, setNow] = useState(Date.now)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setBusy(false)
    setError(null)
  }, [sessionId, item?.id, reconnect?.attempt])
  useEffect(() => {
    setNow(Date.now())
    if (!reconnect) return
    const tick = (): void => setNow(Date.now())
    const timer = window.setInterval(tick, 200)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [reconnect])
  if (!item || !reconnect) return null
  const phase = reconnectPhase(item, paused, now)
  const connecting = phase === 'connecting'
  // 到点却没动静（stalled）：回到等待的样子，不再装作正在连接，但仍可以点「立即重连」
  const showBar = phase !== 'paused'
  const seconds = Math.max(1, Math.ceil((reconnect.at - now) / 1000))
  const total = Math.max(1, reconnect.at - reconnect.since)
  const progress = phase !== 'waiting' ? 100 : Math.min(100, Math.max(0, ((now - reconnect.since) / total) * 100))
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    if (!bridge || busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      role="status"
      data-reconnect-status
      aria-label={tr('session.reconnect.label')}
      className="mb-2 rounded-lg border border-line-card bg-popover px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <RotateCw
            size={14}
            strokeWidth={1.5}
            className={cn('shrink-0 text-warn', connecting && 'animate-spin [animation-duration:1.1s]')}
          />
          <span className="text-meta text-fg-secondary tabular-nums">
            {tr(paused ? 'session.reconnect.paused' : 'session.reconnect.reconnecting', {
              p0: reconnect.attempt,
              p1: reconnect.max,
            })}
            <span className="mx-1 inline-flex gap-[3px] align-middle" aria-hidden>
              {Array.from({ length: reconnect.max }, (_, i) => (
                <i
                  key={i}
                  className={cn(
                    'size-1.5 rounded-full border',
                    i < reconnect.attempt ? 'border-warn bg-warn' : 'border-line-card bg-subtle',
                  )}
                />
              ))}
            </span>
            {phase === 'connecting' && tr('session.reconnect.connecting')}
            {phase === 'waiting' && tr('session.reconnect.inSeconds', { p0: seconds })}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="subtle"
            data-reconnect-now
            className="h-7 px-2 text-meta"
            disabled={busy || item.status === 'dispatching'}
            onClick={() => void act(() => bridge!.runQueuedNow(sessionId, item.id))}
          >
            {tr(paused ? 'session.reconnect.resume' : 'session.reconnect.now')}
          </Button>
          <Button
            variant="ghost"
            data-reconnect-stop
            className="h-7 px-2 text-meta"
            disabled={busy}
            onClick={() => void act(() => bridge!.interrupt(sessionId))}
          >
            {tr('session.Composer.stop')}
          </Button>
        </div>
      </div>
      <p className="mt-0.5 truncate pl-[22px] text-label text-fg-faint" title={translateMessage(reconnect.reason)}>
        {reconnect.reason && `${translateMessage(reconnect.reason)} · `}
        {reconnect.resend ? tr('session.reconnect.resendHint') : tr('session.reconnect.resumeHint')}
      </p>
      {showBar && (
        <div className="mt-2 ml-[22px] h-0.5 overflow-hidden rounded-full bg-subtle">
          <i
            className="block h-full bg-warn transition-[width] duration-200 ease-linear"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      {error && <p className="mt-1 text-meta text-danger">{translateMessage(error)}</p>}
    </div>
  )
}
