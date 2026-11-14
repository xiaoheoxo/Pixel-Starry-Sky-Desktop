import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { QuotaProvider } from '@pixelsky/protocol'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { isDemo } from '@/data/demo'
import { useAccount } from '@/features/account/useAccount'
import { useSettings } from '@/features/settings/SettingsProvider'
import { requestSettingsRow } from '@/features/settings/settingsJump'
import { translateMessage } from '@/i18n/core'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { notify } from '@/features/panes/store'
import { useEngineState } from '@/features/engine'
import { openRightTab } from '@/features/panel/workspaceStore'
import { QuotaPanel } from './QuotaPanel'
import { feeRatio, usePlanFee, useQuotaEstimate } from './useQuotaEstimate'
import { OPEN_MAX_AGE_MS, useResetCredit, type QuotaSource } from './quotaStore'

/** 「已刷新」对勾显示多久（同上下文弹窗） */
const REFRESHED_MS = 1500

/**
 * 弹窗外壳（docs/ui/account-quota.md §6.6）：portal 到 body，按钮右对齐、往上弹 8px；打开时聚焦、Esc 关闭并把焦点还给按钮、点外面关。
 * 打开时读取一次（快照比 1 分钟新就直接用），右上角刷新是手动读取（force）。写法照 ContextWindowButton。
 */
export function QuotaPopover({
  provider,
  source,
  anchor,
  now,
  onClose,
  onOpenChannels,
}: {
  provider: QuotaProvider
  source: QuotaSource
  anchor: RefObject<HTMLButtonElement | null>
  now: number
  onClose: () => void
  onOpenChannels: () => void
}) {
  useI18n()
  const popup = useRef<HTMLDivElement>(null)
  const settings = useSettings()
  const account = useAccount()
  const [refreshed, setRefreshed] = useState(false)
  // 重置卡（docs/ui/codex-reset-card.md §2）：确认框开着 / 正在用
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const resetAuto = useEngineState(s => s.config?.codex.resetCreditAuto?.threshold ?? null)
  const useOne = (): void => {
    setResetBusy(true)
    useResetCredit()
      .then(outcome => notify(tr(outcome === 'reset' ? 'resetCard.done' : `resetCard.outcome.${outcome}`)))
      .catch((err: unknown) => notify(tr('resetCard.failed', { error: translateMessage((err as Error).message) })))
      .finally(() => {
        setResetBusy(false)
        setConfirmReset(false)
      })
  }
  const { refresh } = source
  const estimate = useQuotaEstimate(provider, source.quota, now)
  const { fee } = usePlanFee(provider, source.quota?.plan ?? null)
  useEffect(() => {
    void refresh({ maxAgeMs: OPEN_MAX_AGE_MS })
  }, [refresh])
  useLayoutEffect(() => {
    if (!popup.current || !anchor.current) return
    const position = (): void => {
      const r = anchor.current!.getBoundingClientRect(),
        p = popup.current!
      const bounds = p.getBoundingClientRect()
      p.style.left = `${Math.max(8, Math.min(r.right - bounds.width, innerWidth - bounds.width - 8))}px`
      p.style.top = `${Math.max(8, r.top - bounds.height - 8)}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(popup.current)
    popup.current.focus()
    window.addEventListener('resize', position)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
    }
  }, [anchor])
  useEffect(() => {
    // 确认框开着时不关：它 portal 在弹层外面，点「使用」也算点外面，弹层一关确认框就跟着卸掉了
    if (confirmReset) return
    const down = (e: PointerEvent): void => {
      if (!popup.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', down)
    return () => window.removeEventListener('pointerdown', down)
  }, [anchor, onClose, confirmReset])
  useEffect(() => {
    if (!refreshed) return
    const t = setTimeout(() => setRefreshed(false), REFRESHED_MS)
    return () => clearTimeout(t)
  }, [refreshed])
  const close = (): void => {
    onClose()
    anchor.current?.focus()
  }
  return createPortal(
    <>
      <QuotaPanel
        onUseResetCredit={provider === 'chatgpt' && !isDemo ? () => setConfirmReset(true) : undefined}
        resetBusy={resetBusy}
        resetAuto={resetAuto}
        estimate={estimate}
        feeRatio={feeRatio(estimate?.month ?? null, fee)}
        onOpenDetail={() => {
          onClose()
          openRightTab('overview')
        }}
        provider={provider}
        quota={source.quota}
        loading={source.loading}
        refreshed={refreshed}
        now={now}
        balanceText={account.balanceText}
        planLimits={source.planLimits}
        demo={isDemo}
        panelRef={popup}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
          e.stopPropagation()
        }}
        onRefresh={() => {
          setRefreshed(false)
          void refresh({ force: true }).then(ok => ok && setRefreshed(true))
        }}
        onClose={close}
        onSwitchChannel={() => {
          onClose()
          onOpenChannels()
        }}
        onOpenSettings={() => {
          requestSettingsRow(tr('quota.settings.title'))
          onClose()
          settings.openSettings('chat')
        }}
        onOpenAccount={() => {
          onClose()
          settings.openSettings('account')
        }}
      />
      {confirmReset && (
        <ConfirmDialog
          title={tr('resetCard.confirmTitle')}
          description={tr('resetCard.confirmBody')}
          confirmLabel={tr('resetCard.use')}
          cancelLabel={tr('accounts.cancel')}
          busy={resetBusy}
          warn
          onConfirm={useOne}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </>,
    document.body,
  )
}
