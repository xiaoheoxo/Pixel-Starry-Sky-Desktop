import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
// 穿插显示时两段回复之间的一组过程（docs/ui/codex-flow-slash-feedback.md A，D276）：收成一行动作摘要，点开看明细。
// 正在做的那一组标题写这一步在做什么（Codex 思考摘要的标题，没有时用状态行的说法），露出最近 2 条；失败的那条收起时也露出
import { useEffect, useMemo, type ReactNode } from 'react'
import { ChevronRight, FilePen, FileText, Globe, Layers, Search, SquareTerminal, type LucideIcon } from 'lucide-react'
import type { Item } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { REQUEST_MS, useExpandAny } from '@/features/search/expand'
import { formatDuration } from './agentTrace'
import { liveStatus, stepTitle } from './currentStep'
import { StatusDot } from './StatusDot'
import { summarize, type ProcessSummary } from './turnFold'
import { summaryText } from './TurnProcess'
import { failedItems } from '../viewMode'

/** 运行中收起时露出的最近几条（同 TurnProcess） */
const TAIL = 2

const ROWS = 'mt-1 ml-[15px] flex flex-col gap-3 border-l border-line-subtle pl-3'

/** 行首图标按这一组主要做了什么：改了文件 > 命令 > 读 > 搜索 > 网页 */
function groupIcon(s: ProcessSummary): LucideIcon {
  if (s.edits) return FilePen
  if (s.commands) return SquareTerminal
  if (s.reads) return FileText
  if (s.searches) return Search
  if (s.web) return Globe
  return Layers
}

export function ProcessGroup({
  items,
  running,
  durationMs,
  toggled,
  onToggle,
  render,
}: {
  items: Item[]
  running: boolean
  durationMs: number | null
  /** null：没点过，默认收起（有被拦下的展开，同 processOpenByDefault 的普通模式） */
  toggled: boolean | null
  onToggle: (open: boolean) => void
  render: (items: Item[]) => ReactNode
}) {
  useI18n()
  const summary = useMemo(() => summarize(items), [items])
  const open = toggled ?? summary.blocked > 0
  const ids = useMemo(() => items.map(i => i.id), [items])
  const requested = useExpandAny(ids)
  useEffect(() => {
    if (requested && Date.now() - requested < REQUEST_MS) onToggle(true)
  }, [requested, onToggle])
  // 隐藏了内容的思考不算步数，也不占露出的那几条（同 TurnProcess）
  const shown = useMemo(
    () => items.filter(i => !(i.kind === 'reasoning' && i.status !== 'running' && !i.text.trim())),
    [items],
  )
  const tail = useMemo(() => {
    if (open) return []
    const keep = new Set([...(running ? shown.slice(-TAIL) : []), ...failedItems(items)])
    return items.filter(i => keep.has(i))
  }, [open, running, shown, items])
  const title = useMemo(() => (running ? (stepTitle(items) ?? liveStatus(items).verb) : null), [running, items])
  const Icon = groupIcon(summary)
  const hidden = open ? [] : ids.filter(id => !tail.some(i => i.id === id))
  return (
    <div data-fold={open ? 'open' : 'closed'} data-fold-items={hidden.join(' ') || undefined} data-turn-process>
      <button
        type="button"
        aria-expanded={open}
        title={tr(open ? 'session.process.collapse' : 'session.process.expand')}
        onClick={() => onToggle(!open)}
        className="flex h-[30px] max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-list text-fg-muted hover:bg-hover hover:text-fg-secondary"
      >
        {running ? (
          <StatusDot status="running" still className="mr-0.5" />
        ) : (
          <Icon size={15} strokeWidth={1.5} className="mr-0.5 shrink-0" />
        )}
        {title && (
          <>
            <span className="min-w-0 shrink truncate text-fg">{title}</span>
            <span aria-hidden className="shrink-0 text-fg-faint">
              ·
            </span>
          </>
        )}
        <span className="min-w-0 truncate">{summaryText(summary, shown.length)}</span>
        {summary.failed > 0 && (
          <span className="shrink-0 text-danger">
            <span aria-hidden className="mr-1.5 text-fg-faint">
              ·
            </span>
            {tr('session.process.failed', { n: summary.failed })}
          </span>
        )}
        {summary.blocked > 0 && (
          <span className="shrink-0 text-danger">
            <span aria-hidden className="mr-1.5 text-fg-faint">
              ·
            </span>
            {tr('codex.review.blockedCount', { n: summary.blocked })}
          </span>
        )}
        {!running && durationMs !== null && (
          <span className="shrink-0 text-fg-faint tabular-nums">
            <span aria-hidden className="mr-1.5">
              ·
            </span>
            {formatDuration(durationMs)}
          </span>
        )}
        <ChevronRight
          size={15}
          strokeWidth={1.5}
          className={cn('shrink-0 transition-transform duration-(--dur-fast)', open && 'rotate-90')}
        />
      </button>
      {(open || tail.length > 0) && (
        <div data-process-rows className={ROWS}>
          {render(open ? items : tail)}
        </div>
      )}
    </div>
  )
}
