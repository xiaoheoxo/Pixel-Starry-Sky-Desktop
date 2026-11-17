// 审查结果卡片（docs/ui/review-pr-actions.md §2.2）：挂在那一轮的改动卡片下面。每条：严重程度（形状 + 颜色）、一句话、文件:行和细节；
// 悬停或键盘选中出「看位置 / 修这条 / 忽略」；底部「全部修复」「换个模型复审」
import { useState } from 'react'
import { ChevronDown, CircleAlert, Info, ScanSearch, TriangleAlert, X } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '@/i18n/core'
import { cn, Spinner, useToast } from '@/ui'
import type { ChangedFiles } from '@/data'
import { openFile } from '@/features/files/store'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import type { ReviewSeverity } from '../../../../../shared/types/ai'
import { reviewCounts, type ReviewItem } from './reviewModel'
import { clearReview, updateReview, useTurnReview } from './reviewStore'
import type { ReviewRunner } from './useReviewRunner'

const SEVERITY: Record<ReviewSeverity, { icon: typeof Info; tone: string; label: TranslationKey }> = {
  high: { icon: TriangleAlert, tone: 'text-danger', label: 'aiReview.severityHigh' },
  medium: { icon: CircleAlert, tone: 'text-warn', label: 'aiReview.severityMedium' },
  low: { icon: Info, tone: 'text-fg-muted', label: 'aiReview.severityLow' },
}

const BUTTON =
  'rounded-full border border-line px-2 py-0.5 text-meta text-fg-secondary hover:bg-hover hover:text-fg disabled:opacity-50'
const PRIMARY =
  'rounded-full bg-accent px-2.5 py-0.5 text-meta text-on-accent hover:bg-accent-hover disabled:opacity-50'

function Row({
  item,
  onLocate,
  onFix,
  onIgnore,
}: {
  item: ReviewItem
  onLocate: (() => void) | null
  onFix: () => void
  onIgnore: () => void
}) {
  const look = SEVERITY[item.severity]
  const Icon = look.icon
  const done = item.status === 'fixed'
  const where = item.file ? item.file + (item.line ? `:${item.line}` : '') : ''
  return (
    <li
      data-ai-review-item={item.status}
      className="group/review flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-hover focus-within:bg-hover"
    >
      <Icon
        size={14}
        strokeWidth={1.75}
        className={cn('mt-0.5 shrink-0', done ? 'text-fg-faint' : look.tone)}
        aria-label={tr(look.label)}
      />
      <div className="min-w-0 flex-1">
        <div className={cn('text-ui', done ? 'text-fg-faint line-through' : 'text-fg')}>
          {item.title}
          {item.status === 'sent' && (
            <span className="ml-1.5 rounded-full bg-ov-chip px-1.5 text-label text-fg-muted">
              {tr('aiReview.sent')}
            </span>
          )}
          {done && (
            <span className="ml-1.5 rounded-full bg-success/14 px-1.5 text-label text-success no-underline">
              {tr('aiReview.fixed')}
            </span>
          )}
          {item.recheck && !done && (
            <span className="ml-1.5 rounded-full bg-accent-soft px-1.5 text-label text-accent-fg">
              {tr('aiReview.recheckFound')}
            </span>
          )}
        </div>
        <div className="text-meta text-fg-faint">
          {where && <span className="font-mono">{where}</span>}
          {where && item.detail && ' · '}
          {item.detail}
        </div>
      </div>
      {!done && (
        <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover/review:opacity-100 group-focus-within/review:opacity-100">
          {onLocate && (
            <button type="button" className={BUTTON} onClick={onLocate}>
              {tr('aiReview.locate')}
            </button>
          )}
          {item.status === 'open' && (
            <button type="button" className={PRIMARY} onClick={onFix}>
              {tr('aiReview.fix')}
            </button>
          )}
          <button type="button" className={BUTTON} onClick={onIgnore}>
            {tr('aiReview.ignore')}
          </button>
        </div>
      )}
    </li>
  )
}

export function ReviewCard({
  sessionId,
  turnKey,
  data,
  target,
  runner,
}: {
  sessionId: string
  turnKey: string
  data: ChangedFiles
  target: WorkspaceRef | undefined
  runner: ReviewRunner
}) {
  useI18n()
  const toast = useToast()
  const { review, running, error } = useTurnReview(sessionId, turnKey)
  const [showIgnored, setShowIgnored] = useState(false)
  const [picking, setPicking] = useState(false)
  if (!review && !running && !error) return null

  const setStatus = (id: string, status: ReviewItem['status']): void =>
    updateReview(sessionId, turnKey, r => ({ ...r, items: r.items.map(i => (i.id === id ? { ...i, status } : i)) }))
  const locate = (item: ReviewItem): (() => void) | null =>
    target && item.file
      ? () => void openFile(target, item.file, item.line ?? undefined).catch((e: Error) => toast(e.message))
      : null
  const counts = review ? reviewCounts(review) : { open: 0, high: 0, ignored: 0 }
  const shown = review?.items.filter(i => i.status !== 'ignored') ?? []
  const ignored = review?.items.filter(i => i.status === 'ignored') ?? []
  const fixable = review?.items.filter(i => i.status === 'open') ?? []
  return (
    <section
      data-ai-review
      aria-label={tr('aiReview.title')}
      className="conversation-message mt-2 rounded-xl border border-line bg-surface px-2 py-2"
    >
      <header className="flex min-w-0 items-center gap-2 px-2 pb-1">
        <ScanSearch size={15} strokeWidth={1.6} className="shrink-0 text-accent-fg" />
        <span className="shrink-0 text-ui font-semibold text-fg">
          {tr('aiReview.title')}
          {review && review.items.length > 0 && <span className="ml-1 text-fg-muted">{review.items.length}</span>}
        </span>
        {review && (
          <span className="min-w-0 truncate text-meta text-fg-faint">
            {[
              tr('aiReview.by', { model: review.model }),
              tr('aiReview.files', { n: review.files }),
              counts.high ? tr('aiReview.high', { n: counts.high }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        <button
          type="button"
          aria-label={tr('aiReview.dismiss')}
          title={tr('aiReview.dismiss')}
          onClick={() => clearReview(sessionId, turnKey)}
          disabled={!!running}
          className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          <X size={14} />
        </button>
      </header>
      {running === 'review' && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-meta text-fg-muted">
          <Spinner size={13} />
          {tr('aiReview.running')}
        </div>
      )}
      {error && <p className="px-2 py-1 text-meta text-danger">{tr('aiReview.failed', { text: error })}</p>}
      {review?.raw && (
        <div className="px-2 py-1">
          <div className="text-meta text-fg-muted">{tr('aiReview.rawTitle')}</div>
          <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-hover p-2 text-meta break-words whitespace-pre-wrap text-fg-secondary">
            {review.raw}
          </pre>
        </div>
      )}
      {review && !review.raw && review.items.length === 0 && running !== 'review' && (
        <p className="px-2 py-1 text-meta text-fg-muted">{tr('aiReview.none')}</p>
      )}
      {shown.length > 0 && (
        <ul className="space-y-0.5">
          {shown.map(item => (
            <Row
              key={item.id}
              item={item}
              onLocate={locate(item)}
              onFix={() => runner.fix(turnKey, [item])}
              onIgnore={() => setStatus(item.id, 'ignored')}
            />
          ))}
        </ul>
      )}
      {ignored.length > 0 && (
        <div className="px-2 pt-1">
          <button
            type="button"
            aria-expanded={showIgnored}
            onClick={() => setShowIgnored(v => !v)}
            className="inline-flex items-center gap-0.5 text-meta text-fg-muted hover:text-fg"
          >
            {tr('aiReview.ignored', { n: ignored.length })}
            <ChevronDown size={12} className={cn('transition-transform', showIgnored && 'rotate-180')} />
          </button>
          {showIgnored && (
            <ul className="mt-1 space-y-0.5">
              {ignored.map(item => (
                <li key={item.id} className="flex items-center gap-2 text-meta text-fg-faint">
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <button type="button" className={BUTTON} onClick={() => setStatus(item.id, 'open')}>
                    {tr('aiReview.unignore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {review && (
        <footer className="flex flex-wrap items-center gap-1.5 px-2 pt-2">
          <span className="min-w-0 flex-1 text-meta text-fg-faint">
            {running === 'recheck' ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size={12} />
                {tr('aiReview.rechecking')}
              </span>
            ) : review.fix && !review.rechecked ? (
              tr('aiReview.waiting')
            ) : null}
          </span>
          <div className="relative">
            <button
              type="button"
              aria-expanded={picking}
              disabled={!!running}
              onClick={() => setPicking(v => !v)}
              className={BUTTON}
            >
              {tr('aiReview.again')}
            </button>
            {picking && (
              <div
                role="menu"
                aria-label={tr('aiReview.again.title')}
                className="absolute right-0 bottom-full z-20 mb-1 w-64 rounded-lg border border-line-card bg-popover p-1 shadow-popover"
              >
                <div className="px-2 py-1 text-meta text-fg-faint">{tr('aiReview.again.title')}</div>
                {runner.sources.map(s => (
                  <button
                    key={s.source}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPicking(false)
                      runner.run(turnKey, data, s.source)
                    }}
                    className="block w-full truncate rounded-md px-2 py-1.5 text-left text-ui text-fg hover:bg-hover"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {fixable.length > 0 && (
            <button type="button" disabled={!!running} className={PRIMARY} onClick={() => runner.fix(turnKey, fixable)}>
              {tr('aiReview.fixAll')}
            </button>
          )}
        </footer>
      )}
    </section>
  )
}
