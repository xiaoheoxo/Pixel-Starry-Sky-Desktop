// 规则 B、C（docs/ui/auto-fold.md §4、§5）：收起的旧轮次、压缩前的对话。收起时里面的内容不渲染；搜索、跳转到里面时自动展开
import { useEffect, useMemo, type ReactNode } from 'react'
import { ChevronRight, History } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { cn } from '@/ui'
import { REQUEST_MS, useExpandAny } from '@/features/search/expand'
import { formatDuration } from './agentTrace'
import type { FoldEntry } from './autoFold'
import { summaryText } from './TurnProcess'
import { summarize } from './turnFold'

export function AutoFoldRow({
  fold,
  foldKey,
  open,
  onToggle,
  children,
}: {
  fold: Extract<FoldEntry, { type: 'fold' }>
  foldKey: string
  open: boolean
  onToggle: (key: string, open: boolean) => void
  children: () => ReactNode
}) {
  useI18n()
  const ids = useMemo(() => fold.items.map(item => item.id), [fold.items])
  const requested = useExpandAny(ids)
  useEffect(() => {
    if (requested && Date.now() - requested < REQUEST_MS) onToggle(foldKey, true)
  }, [requested, onToggle, foldKey])
  const compacted = fold.kind === 'compacted'
  // 压缩之后接着的半轮（前半轮在线上面）里没有用户消息，也算一轮
  const n = Math.max(1, fold.turns.length)
  // 没有工具调用的几轮不写「N 步」：里面算上了用户消息和回复，数字没有意义
  const summary = summarize(fold.items)
  const detail = compacted
    ? tr('session.fold.compactedHint')
    : Object.values(summary).some(count => count > 0)
      ? summaryText(summary, 0)
      : ''
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-3"
      data-auto-fold={fold.kind}
      data-fold={open ? 'open' : 'closed'}
      data-fold-items={open ? undefined : ids.join(' ')}
    >
      <button
        type="button"
        aria-expanded={open}
        title={tr(open ? 'session.fold.collapse' : 'session.fold.expand')}
        onClick={() => onToggle(foldKey, !open)}
        className="conversation-message flex h-[30px] max-w-full min-w-0 items-center gap-1.5 self-start rounded-md px-2 text-list text-fg-muted hover:bg-hover hover:text-fg-secondary"
        style={{ width: 'fit-content' }}
      >
        <History size={15} strokeWidth={1.5} className="mr-0.5 shrink-0" />
        <span className="shrink-0 text-fg-secondary">
          {tr(compacted ? 'session.fold.compacted' : 'session.fold.older', { n })}
        </span>
        {detail && (
          <>
            <span aria-hidden className="shrink-0 text-fg-faint">
              ·
            </span>
            <span className="min-w-0 truncate">{detail}</span>
          </>
        )}
        {fold.durationMs > 0 && (
          <span className="shrink-0 text-fg-faint tabular-nums">
            <span aria-hidden className="mr-1.5">
              ·
            </span>
            {formatDuration(fold.durationMs)}
          </span>
        )}
        <ChevronRight
          size={15}
          strokeWidth={1.5}
          className={cn('shrink-0 transition-transform duration-(--dur-fast)', open && 'rotate-90')}
        />
      </button>
      {open && children()}
    </div>
  )
}
