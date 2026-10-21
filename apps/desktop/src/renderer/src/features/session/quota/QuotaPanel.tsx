import type { KeyboardEvent, ReactNode, Ref } from 'react'
import { Check, ExternalLink, RefreshCw, Settings, X } from 'lucide-react'
import type { AccountQuota, QuotaProvider } from '@pixelsky/protocol'
import { translateMessage, tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { cn, PlanBadge } from '@/ui'
import {
  QUOTA_LINKS,
  clockText,
  maskAccount,
  planBadge,
  providerTitle,
  quotaLayout,
  type PlanLimit,
  type QuotaCard,
  type QuotaLevel,
  type QuotaRow,
} from './quotaModel'

const TEXT: Record<QuotaLevel, string> = { normal: 'text-fg', warn: 'text-warn', full: 'text-danger' }
const FILL: Record<QuotaLevel, string> = { normal: 'bg-accent', warn: 'bg-warn', full: 'bg-danger' }

export interface QuotaPanelProps {
  provider: QuotaProvider
  quota: AccountQuota | null
  /** 正在读取（没有任何数据时显示占位卡片，有数据时刷新图标转） */
  loading?: boolean
  /** 刚刷新完：右上角图标短暂变成对勾 */
  refreshed?: boolean
  now: number
  /** 平台余额的显示文字 */
  balanceText?: string | null
  planLimits?: readonly PlanLimit[]
  demo?: boolean
  panelRef?: Ref<HTMLDivElement>
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  onRefresh?: () => void
  onClose?: () => void
  onSwitchChannel?: () => void
  /** 「额度按钮设置」 */
  onOpenSettings?: () => void
  /** 平台的「账号设置」 */
  onOpenAccount?: () => void
}

/**
 * 额度弹窗的内容（样稿 v3，docs/ui/account-quota.md §6.6）：纯展示，数据和回调都从 props 进来，便于静态渲染测试。
 * 不带 aria-modal：右侧内置浏览器只在弹层压到它时才藏（features/panel/browserOverlay.ts）。
 */
export function QuotaPanel({
  provider,
  quota,
  loading = false,
  refreshed = false,
  now,
  balanceText,
  planLimits,
  demo = false,
  panelRef,
  onKeyDown,
  onRefresh,
  onClose,
  onSwitchChannel,
  onOpenSettings,
  onOpenAccount,
}: QuotaPanelProps) {
  useI18n()
  const title = providerTitle(provider)
  const layout =
    quota && quota.status !== 'unsupported' ? quotaLayout(quota, { provider, now, balanceText, planLimits }) : null
  const hasData = !!layout && (layout.cards.length > 0 || layout.rows.length > 0)
  const failed = quota?.status === 'error'
  const waiting = !hasData && loading
  const plan = quota ? planBadge(provider, quota.plan) : null
  const notRefreshable = quota?.refreshable === false
  const refreshing = loading && hasData
  const updated = quota?.observedAt != null ? tr('quota.updatedAt', { p0: clockText(quota.observedAt) }) : ''
  const who = [maskAccount(quota?.account), updated].filter(Boolean).join(' · ')
  const reason = quota?.error ? translateMessage(quota.error.message) : ''
  // failed / timeout 的原因本身就是完整的一句（「读取额度失败：…」「读取额度超时」），不再套前缀；network / engine-unavailable 只是一个名词短语，要套
  const selfContained = quota?.error?.code === 'failed' || quota?.error?.code === 'timeout'
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      data-quota-popover
      onKeyDown={onKeyDown}
      className="pop-in no-drag fixed z-50 w-[344px] max-w-[calc(100vw-16px)] rounded-xl border border-line-card bg-popover p-3 pb-2.5 text-ui text-fg shadow-menu outline-none"
    >
      <div className="flex items-center gap-1.5 pl-0.5">
        <h2 className="text-ui font-medium">{title}</h2>
        {plan && <PlanBadge label={plan.label} tone={plan.tone} />}
        <span className="flex-1" />
        {!waiting && (
          <button
            type="button"
            aria-label={refreshed ? tr('quota.refresh.done') : tr('quota.refresh.label')}
            aria-disabled={notRefreshable || refreshing || undefined}
            title={
              notRefreshable
                ? tr('quota.refresh.unavailable')
                : refreshed
                  ? tr('quota.refresh.done')
                  : tr('quota.refresh.label')
            }
            onClick={notRefreshable || refreshing ? undefined : onRefresh}
            className={cn(
              'inline-flex size-6 items-center justify-center rounded-md hover:bg-hover',
              refreshed ? 'text-success' : 'text-fg-muted hover:text-fg',
              (notRefreshable || refreshing) && 'cursor-default opacity-50 hover:bg-transparent',
            )}
          >
            {refreshed ? (
              <Check size={14} aria-hidden />
            ) : (
              <RefreshCw
                size={14}
                aria-hidden
                className={cn(refreshing && 'animate-spin motion-reduce:animate-none')}
              />
            )}
          </button>
        )}
        <button
          type="button"
          aria-label={tr('quota.close')}
          onClick={onClose}
          className="inline-flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      {who && (
        <p title={quota?.account ?? undefined} className="mb-2.5 truncate pl-0.5 text-label text-fg-faint">
          {who}
        </p>
      )}
      <div aria-busy={loading || undefined} className={who ? undefined : 'mt-2.5'}>
        {waiting ? (
          <div aria-hidden className="grid grid-cols-2 gap-2">
            <div className="h-[78px] animate-pulse rounded-[10px] bg-subtle motion-reduce:animate-none" />
            <div className="h-[78px] animate-pulse rounded-[10px] bg-subtle motion-reduce:animate-none" />
          </div>
        ) : failed && !hasData ? (
          <div role="status">
            <p className="mx-0.5 mt-0.5 text-meta text-danger">
              {selfContained ? reason : tr('quota.error.noData', { p0: reason })}
            </p>
            <p className="mx-0.5 mt-0.5 text-meta text-fg-muted">{tr('quota.error.hint')}</p>
          </div>
        ) : !hasData ? (
          <p className="mx-0.5 mt-0.5 text-meta text-fg-muted">
            {tr(notRefreshable ? 'quota.empty.eventsOnly' : 'quota.empty.none')}
          </p>
        ) : (
          <>
            {layout.cards.length > 0 && (
              <div className={cn('grid gap-2', layout.cards.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}>
                {layout.cards.map(card => (
                  <Tile key={card.id} card={card} />
                ))}
              </div>
            )}
            {layout.rows.length > 0 && (
              <div className="mt-2.5 px-0.5">
                <div className="mb-0.5 text-label text-fg-faint">{tr('quota.rows.title')}</div>
                {layout.rows.map(row => (
                  <Row key={row.id} row={row} />
                ))}
              </div>
            )}
            {layout.alert && (
              <div
                role="status"
                className={cn(
                  'mt-2.5 flex items-start gap-2 rounded-lg px-2.5 py-2 text-meta text-fg-secondary',
                  layout.alert.kind === 'full' ? 'bg-danger/10' : 'bg-warn/10',
                )}
              >
                <span className="min-w-0 flex-1">
                  {layout.alert.strong && (
                    <b className={cn('font-semibold', layout.alert.kind === 'full' ? 'text-danger' : 'text-warn')}>
                      {layout.alert.strong}
                    </b>
                  )}
                  {layout.alert.rest}
                </span>
                {layout.alert.switchChannel && (
                  <button
                    type="button"
                    onClick={onSwitchChannel}
                    className="press shrink-0 self-center rounded-md border border-line-card bg-surface px-2 py-0.5 text-label font-medium text-fg hover:bg-hover"
                  >
                    {tr('quota.action.switchChannel')}
                  </button>
                )}
              </div>
            )}
            {failed && (
              <p role="status" className="mx-0.5 mt-2 text-meta text-danger">
                {selfContained ? reason : tr('quota.error.stale', { p0: reason })}
              </p>
            )}
          </>
        )}
      </div>
      <div className="mt-2.5 flex items-center gap-2.5 border-t border-line px-0.5 pt-2 text-label">
        {provider === 'platform' ? (
          <FootButton onClick={onOpenAccount} tone="accent">
            {tr('quota.link.platform')}
          </FootButton>
        ) : (
          <a
            href={QUOTA_LINKS[provider]}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-[3px] whitespace-nowrap text-accent-fg hover:underline"
          >
            {tr(provider === 'claude' ? 'quota.link.claude' : 'quota.link.chatgpt')}
            <ExternalLink size={12} aria-hidden />
          </a>
        )}
        <span className="flex-1">{demo && <span className="text-fg-faint">{tr('quota.demoData')}</span>}</span>
        <FootButton onClick={onOpenSettings} tone="quiet">
          <Settings size={12} aria-hidden />
          {tr('quota.action.settings')}
        </FootButton>
      </div>
    </div>
  )
}

function FootButton({
  tone,
  onClick,
  children,
}: {
  tone: 'accent' | 'quiet'
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-[3px] whitespace-nowrap hover:underline',
        tone === 'accent' ? 'text-accent-fg' : 'text-fg-muted hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

/** 大数字卡片：名字、大百分比、进度条、恢复时间（平台是金额） */
function Tile({ card }: { card: QuotaCard }) {
  const full = card.level === 'full'
  return (
    <div
      title={card.hover || undefined}
      className={cn('min-w-0 rounded-[10px] px-[11px] pt-[9px] pb-2.5', full ? 'bg-danger/10' : 'bg-subtle')}
    >
      <div className="text-label text-fg-muted">{card.name}</div>
      <div
        className={cn(
          'mt-px leading-7 font-semibold tracking-[-0.01em] tabular-nums',
          card.type === 'plain' ? 'text-[19px]' : 'text-[21px]',
          TEXT[card.level],
        )}
      >
        {card.value}
        {card.unit && (
          <small className="ml-[3px] text-label font-normal tracking-normal text-fg-muted">{card.unit}</small>
        )}
      </div>
      {card.type === 'meter' && (
        <div
          role="progressbar"
          aria-label={card.name}
          aria-valuenow={Math.round(card.percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-selected"
        >
          <i
            className={cn('block h-full rounded-full', FILL[card.level])}
            style={{ width: `${Math.min(100, Math.max(card.percent, 2))}%` }}
          />
        </div>
      )}
      <div
        className={cn(
          'mt-1.5 text-label tabular-nums',
          card.type === 'meter' && 'truncate',
          full ? 'text-danger' : 'text-fg-faint',
        )}
      >
        {card.note}
      </div>
    </div>
  )
}

/** 「其它」小列表的一行：名字、小进度条、数值 */
function Row({ row }: { row: QuotaRow }) {
  return (
    <div className="flex h-[26px] items-center gap-2.5 text-meta">
      <span className="min-w-0 flex-1 truncate text-fg-secondary">{row.name}</span>
      {row.percent !== null && (
        <span
          role="progressbar"
          aria-label={row.name}
          aria-valuenow={Math.round(row.percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1 w-[84px] shrink-0 overflow-hidden rounded-full bg-subtle"
        >
          <i
            className={cn('block h-full rounded-full', FILL[row.level])}
            style={{ width: `${Math.min(100, Math.max(row.percent, 2))}%` }}
          />
        </span>
      )}
      <span
        className={cn('min-w-[76px] text-right tabular-nums', row.level === 'normal' ? 'text-fg' : TEXT[row.level])}
      >
        {row.value}
      </span>
    </div>
  )
}
