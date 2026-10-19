import { translateMessage } from '../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useEffect, useRef, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import { Button } from '@/ui'
import { applyCacheAlertEvent, cacheAlertId, emptyCacheAlerts, expireCacheAlerts } from '@/features/engine/cacheAlerts'
import { useCacheMissAlert } from '@/features/settings/cacheMiss'
import { formatTokens } from '@/features/usage/format'
import type { CacheWarning } from '@pixelsky/protocol'

/** 窗口级监听所有会话，不依赖当前窗格，过期提醒不从历史快照恢复。 */
export function CacheMissAlerts() {
  useI18n()
  const enabled = useCacheMissAlert()
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const [state, setState] = useState(emptyCacheAlerts)
  const [now, setNow] = useState(Date.now)
  const stopping = useRef(new Set<string>())
  useEffect(() => {
    if (window.pixelsky?.demo) return
    return window.pixelsky?.engine.onEvent(e => {
      const time = Date.now()
      // 只有缓存提醒事件会产生卡片；已有卡片时倒计时由下面的定时器（1 s 一次）刷新，其余事件不触发重渲染
      if (e.kind === 'cache_warning') setNow(time)
      setState(s => applyCacheAlertEvent(s, e, time, enabledRef.current))
    })
  }, [])
  useEffect(() => {
    if (!enabled) setState(s => ({ ...s, cards: [] }))
  }, [enabled])
  const hasCards = state.cards.length > 0
  useEffect(() => {
    if (!hasCards) return
    const tick = (): void => {
      const time = Date.now()
      setNow(time)
      setState(s => expireCacheAlerts(s, time))
    }
    const timer = window.setInterval(tick, 1000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [hasCards])
  const dismiss = (id: string): void =>
    setState(s => ({ ...s, cards: s.cards.filter(c => cacheAlertId(c.warning) !== id) }))
  const stop = async (warning: CacheWarning): Promise<void> => {
    const id = cacheAlertId(warning),
      bridge = window.pixelsky?.engine
    if (stopping.current.has(id)) return
    if (!bridge || warning.expiresAt <= Date.now()) {
      dismiss(id)
      return
    }
    stopping.current.add(id)
    setState(s => ({
      ...s,
      cards: s.cards.map(c => (cacheAlertId(c.warning) === id ? { ...c, stopping: true, error: undefined } : c)),
    }))
    try {
      await bridge.interruptTurn(warning.sessionId, warning.turnId)
      dismiss(id)
    } catch (e) {
      setState(s => ({
        ...s,
        cards: s.cards.map(c =>
          cacheAlertId(c.warning) === id
            ? {
                ...c,
                stopping: false,
                error: tr('session.CacheMissAlerts.couldNotStop', { p0: (e as Error).message }),
                errorExpiresAt: Date.now() + 5_000,
              }
            : c,
        ),
      }))
    } finally {
      stopping.current.delete(id)
    }
  }
  if (!enabled || !hasCards) return null
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-h-[70vh] w-[min(380px,calc(100vw-32px))] flex-col gap-2 overflow-y-auto"
      aria-label={tr('session.CacheMissAlerts.cacheNotice')}
    >
      {state.cards.map(card => {
        const w = card.warning,
          id = cacheAlertId(w)
        const seconds = Math.max(0, Math.ceil((w.expiresAt - now) / 1000))
        return (
          <section
            key={id}
            className="pointer-events-auto rounded-xl border border-line-card bg-popover p-4 shadow-menu"
            role="status"
            aria-label={
              w.cached === 0 ? tr('session.CacheMissAlerts.cacheMiss') : tr('session.CacheMissAlerts.lowCacheHitRate')
            }
            data-session-id={w.sessionId}
          >
            <div className="flex items-center gap-2 text-ui font-medium text-fg">
              <CircleAlert size={16} strokeWidth={1.5} className="text-warn" />
              {w.cached === 0 ? tr('session.CacheMissAlerts.cacheMiss') : tr('session.CacheMissAlerts.lowCacheHitRate')}
            </div>
            <p className="mt-2 truncate text-meta text-fg-secondary" title={`${w.title} · ${w.model}`}>
              「{w.title}」· {w.model}
            </p>
            <p
              className="mt-1 text-meta text-fg-muted"
              title={tr('session.CacheMissAlerts.currentInputTokensCache', {
                p0: w.input.toLocaleString(),
                p1: w.cached.toLocaleString(),
                p2: w.previousInput.toLocaleString(),
              })}
            >
              {tr('session.CacheMissAlerts.currentInput')} {formatTokens(w.input)}
              {tr('session.CacheMissAlerts.cacheRead')} {formatTokens(w.cached)}
              {tr('session.CacheMissAlerts.previousInput')} {formatTokens(w.previousInput)}。
            </p>
            {card.error && (
              <p className="mt-2 text-meta text-danger">
                {translateMessage(card.error)}
                {tr('session.CacheMissAlerts.youCanAlsoStop')}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-label text-fg-faint tabular-nums" aria-live="off">
                {card.stopping
                  ? tr('session.CacheMissAlerts.stoppingThisTurn')
                  : card.error
                    ? tr('session.CacheMissAlerts.stopManuallyFromComposer')
                    : tr('session.CacheMissAlerts.taskIsRunningCloses', { p0: seconds })}
              </span>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" disabled={card.stopping} onClick={() => dismiss(id)}>
                  {tr('session.CacheMissAlerts.keepRunning')}
                </Button>
                <Button variant="outline" disabled={card.stopping || seconds === 0} onClick={() => void stop(w)}>
                  {card.stopping ? tr('session.CacheMissAlerts.stopping') : tr('session.CacheMissAlerts.stopThisTurn')}
                </Button>
              </div>
            </div>
          </section>
        )
      })}
    </div>
  )
}
