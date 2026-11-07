// 悬停卡里的 PR 部分（docs/ui/sidebar-pr-v2-mockup.html）：这个对话的 PR 最多列 3 个、其余折叠，每行有打开 / 复制 / 隐藏；
// 只是提到的 PR 折叠在下面；底部「已隐藏 N 个 · 恢复」和「显示选项」（只在这里改，不进设置页）。
// 图标藏了、过了显示期也照样列在这里，所以恢复的入口一直在
import { useState } from 'react'
import { Copy, Eye, EyeOff, ExternalLink, GitPullRequest, RefreshCw, type LucideIcon } from 'lucide-react'
import { tr } from '@/i18n/core'
import { cn, useToast } from '@/ui'
import { relativeTime } from '@/features/engine/labels'
import type { SessionPr } from '../../../../shared/types/session-status'
import { DONE_DAYS, prDisplay, usePrDisplay, type OpenMode } from './prDisplay'
import { prIcon } from './SessionMarks'
import { PR_STATE, prIconHidden } from './sessionStatusModel'

/** 一次列几个 PR，其余点「还有 N 个」展开 */
export const PR_CARD_LIMIT = 3

const CI_TONE = { pass: 'text-success', fail: 'text-danger', pending: 'text-fg-muted' } as const

const HIDDEN_TAG = {
  hidden: 'sidebar.status.pr.hiddenTag',
  expired: 'sidebar.status.pr.expiredTag',
  quiet: 'sidebar.status.pr.quietTag',
} as const

export function openUrl(url: string, toast: (message: string) => void): Promise<void> {
  return Promise.resolve(window.pixelsky?.projectTools.openExternal(url)).then(
    () => undefined,
    (e: unknown) => toast(e instanceof Error ? e.message : String(e)),
  )
}

export function copyPrLink(url: string, toast: (message: string) => void): void {
  void navigator.clipboard.writeText(url).then(
    () => toast(tr('sidebar.status.copied')),
    (e: unknown) => toast(e instanceof Error ? e.message : String(e)),
  )
}

/** 一个 PR 的状态、增删、检查、冲突；查不到状态时写原因（悬停卡和概况共用） */
export function PrFacts({ pr, gh }: { pr: SessionPr; gh: string }) {
  if (pr.unknown)
    return (
      <span className="text-fg-muted">
        {tr(
          gh === 'signed-out'
            ? 'sidebar.status.pr.unknownSignedOut'
            : gh === 'missing'
              ? 'sidebar.status.pr.unknownMissing'
              : 'sidebar.status.pr.unknownReady',
        )}
      </span>
    )
  const closedAt = pr.closedAt ? Date.parse(pr.closedAt) : NaN
  return (
    <>
      <span className="text-fg-secondary">
        {tr(PR_STATE[pr.state])}
        {(pr.state === 'merged' || pr.state === 'closed') && !Number.isNaN(closedAt) && (
          <> · {tr('sidebar.status.pr.ago', { time: relativeTime(closedAt, Date.now()) })}</>
        )}
      </span>
      <span className="tabular-nums">
        <span className="text-success">+{pr.additions}</span> <span className="text-danger">−{pr.deletions}</span>
      </span>
      {pr.ci && (
        <span className={CI_TONE[pr.ci]}>
          {pr.ci === 'pass'
            ? tr('sidebar.status.pr.ciPass')
            : pr.ci === 'pending'
              ? tr('sidebar.status.pr.ciPending')
              : pr.ciFailed > 0
                ? tr('sidebar.status.pr.ciFail', { count: pr.ciFailed })
                : tr('sidebar.status.pr.ciFailAny')}
        </span>
      )}
      {pr.conflict && <span className="text-warn">{tr('sidebar.status.pr.conflict')}</span>}
    </>
  )
}

function IconButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
    >
      <Icon size={13} strokeWidth={1.5} />
    </button>
  )
}

/** 小号分段选择（卡里放不下 Segmented 的大小） */
function MiniSegment<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <span role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-md bg-subtle p-0.5">
      {options.map(o => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-5 whitespace-nowrap rounded px-1.5 text-meta',
            o.value === value ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}

const shortPr = (url: string): string => url.replace(/^https:\/\/github\.com\//i, '').replace('/pull/', '#')

export function PrPanel({
  sessionId,
  title,
  prs,
  mentioned,
  gh,
  busy,
  onRefresh,
  onBack,
}: {
  sessionId: string
  title: string
  /** 这个对话的 PR（含图标藏了的） */
  prs: SessionPr[]
  /** 只是提到的 PR 链接 */
  mentioned: string[]
  gh: string
  busy: boolean
  onRefresh: () => void
  /** 从问题卡切过来的：返回 */
  onBack?: () => void
}) {
  const toast = useToast()
  const display = usePrDisplay()
  const [all, setAll] = useState(false)
  const [showMentioned, setShowMentioned] = useState(false)
  const [options, setOptions] = useState(false)
  const now = Date.now()
  const sessionOff = display.hiddenSessions.includes(sessionId)
  const hidden = prs.filter(pr => display.hiddenPrs.includes(pr.url.toLowerCase()))
  const shown = all ? prs : prs.slice(0, PR_CARD_LIMIT)

  const copy = (url: string): void => copyPrLink(url, toast)
  const hide = (pr: SessionPr): void => {
    prDisplay.hide([pr.url])
    toast(tr('sidebar.status.pr.hiddenToast', { number: pr.number }), {
      action: { label: tr('sidebar.status.pr.undo'), run: () => prDisplay.show([pr.url]) },
    })
  }

  return (
    <div data-status-prs className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-1">
        {onBack && (
          <button type="button" onClick={onBack} className="shrink-0 text-meta text-fg-muted hover:text-fg">
            {tr('sidebar.status.pr.back')}
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-meta text-fg-muted" title={title}>
          {prs.length ? tr('sidebar.status.pr.head', { title }) : tr('sidebar.status.pr.none')}
        </span>
        <span className={cn(busy && 'animate-spin')}>
          <IconButton icon={RefreshCw} label={tr('sidebar.status.refresh')} onClick={onRefresh} />
        </span>
      </div>

      {shown.map(pr => {
        const { icon: Icon, tone } = prIcon(pr)
        const why = sessionOff ? null : prIconHidden(pr, display, now)
        const isHidden = why === 'hidden'
        return (
          <div key={pr.url} data-status-pr={pr.number} className="flex min-w-0 items-start gap-2">
            <Icon size={16} strokeWidth={1.5} className={cn('mt-0.5 shrink-0', tone, isHidden && 'opacity-50')} />
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => void openUrl(pr.url, toast)}
                title={pr.title}
                className="block w-full min-w-0 break-words text-left font-medium hover:underline"
              >
                #{pr.number} {pr.title}
              </button>
              <p className="mt-0.5 truncate text-meta text-fg-muted" title={`${pr.repo} · ${pr.head} → ${pr.base}`}>
                {pr.repo} · {pr.head} → {pr.base}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-meta">
                <PrFacts pr={pr} gh={gh} />
                {why && (
                  <span data-pr-icon-hidden={why} className="text-fg-faint">
                    {tr(HIDDEN_TAG[why])}
                  </span>
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center">
              <IconButton
                icon={ExternalLink}
                label={tr('sidebar.status.openPr')}
                onClick={() => void openUrl(pr.url, toast)}
              />
              <IconButton icon={Copy} label={tr('sidebar.status.copyLink')} onClick={() => copy(pr.url)} />
              {isHidden ? (
                <IconButton
                  icon={Eye}
                  label={tr('sidebar.status.pr.unhide')}
                  onClick={() => prDisplay.show([pr.url])}
                />
              ) : (
                <IconButton icon={EyeOff} label={tr('sidebar.status.pr.hide')} onClick={() => hide(pr)} />
              )}
            </div>
          </div>
        )
      })}
      {prs.length > PR_CARD_LIMIT && (
        <button
          type="button"
          onClick={() => setAll(v => !v)}
          className="self-start pl-6 text-meta text-fg-muted hover:text-fg"
        >
          {all ? tr('sidebar.status.pr.fewer') : tr('sidebar.status.pr.more', { count: prs.length - PR_CARD_LIMIT })}
        </button>
      )}

      {mentioned.length > 0 && (
        <div data-status-mentioned className="border-t border-line-subtle pt-2 text-meta">
          <button
            type="button"
            onClick={() => setShowMentioned(v => !v)}
            className="flex w-full min-w-0 items-start gap-1 text-left text-fg-muted hover:text-fg"
          >
            <span className="min-w-0 flex-1">
              <b className="font-medium text-fg-secondary">
                {tr('sidebar.status.pr.mentioned', { count: mentioned.length })}
              </b>
              {tr('sidebar.status.pr.mentionedNote')}
            </span>
            <span className="shrink-0">
              {showMentioned ? tr('sidebar.status.pr.fewer') : tr('sidebar.status.pr.expand')}
            </span>
          </button>
          {showMentioned && (
            <div className="mt-1 flex max-h-40 flex-col overflow-y-auto">
              {mentioned.map(url => (
                <div key={url} className="flex min-w-0 items-center gap-1.5">
                  <GitPullRequest size={12} strokeWidth={1.5} className="shrink-0 text-fg-faint" />
                  <button
                    type="button"
                    title={url}
                    onClick={() => void openUrl(url, toast)}
                    className="min-w-0 flex-1 truncate text-left font-mono text-fg-secondary hover:underline"
                  >
                    {shortPr(url)}
                  </button>
                  <IconButton icon={Copy} label={tr('sidebar.status.copyLink')} onClick={() => copy(url)} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-line-subtle pt-2 text-meta">
        <button
          type="button"
          aria-expanded={options}
          onClick={() => setOptions(v => !v)}
          className="text-fg-muted hover:text-fg"
        >
          {tr('sidebar.status.pr.options')} {options ? '▴' : '▾'}
        </button>
        {hidden.length > 0 && (
          <span data-status-hidden className="ml-auto text-fg-muted">
            {tr('sidebar.status.pr.hiddenCount', { count: hidden.length })} ·{' '}
            <button
              type="button"
              onClick={() => prDisplay.show(hidden.map(pr => pr.url))}
              className="text-accent-fg hover:underline"
            >
              {tr('sidebar.status.pr.restore')}
            </button>
          </span>
        )}
      </div>
      {options && (
        <div data-status-pr-options className="flex flex-col gap-2 rounded-md bg-subtle/60 p-2 text-meta">
          <label className="flex items-center gap-1.5 text-fg-secondary">
            <input
              type="checkbox"
              checked={sessionOff}
              onChange={e => prDisplay.setSessionHidden(sessionId, e.target.checked)}
            />
            {tr('sidebar.status.pr.sessionOff')}
          </label>
          <div className="flex flex-wrap items-center justify-between gap-1.5 text-fg-secondary">
            {tr('sidebar.status.pr.doneDays')}
            <MiniSegment
              label={tr('sidebar.status.pr.doneDays')}
              value={display.doneDays}
              options={DONE_DAYS.map(d => ({ value: d, label: tr(`sidebar.status.pr.done.${d}`) }))}
              onChange={prDisplay.setDoneDays}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-1.5 text-fg-secondary">
            {tr('sidebar.status.pr.openMode')}
            <MiniSegment<OpenMode>
              label={tr('sidebar.status.pr.openMode')}
              value={display.openMode}
              options={[
                { value: 'all', label: tr('sidebar.status.pr.openAll') },
                { value: 'attention', label: tr('sidebar.status.pr.openAttention') },
              ]}
              onChange={prDisplay.setOpenMode}
            />
          </div>
          <p className="text-fg-faint">{tr('sidebar.status.pr.optionsNote')}</p>
        </div>
      )}
    </div>
  )
}
