// 内置浏览器的控制台抽屉（docs/ui/browser-v2.md §3.2）：网页下面拉出来，错误 / 失败请求（可开警告），每条能发给 AI
import { useEffect, useState } from 'react'
import { ArrowLeftRight, ChevronDown, CircleX, Send, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react'
import { IconButton, ResizeHandle, Switch, cn } from '@/ui'
import { notifyOverlayChange } from '@/ui/overlayEvents'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '@/i18n/core'
import type { BrowserIssueEntry } from '../../../../shared/types/project-browser'
import {
  CONSOLE_HEIGHT,
  clockTime,
  filterCounts,
  visibleEntries,
  type ConsoleFilter,
  type ConsolePrefs,
} from './browserTools'

const KIND: Record<BrowserIssueEntry['kind'], { icon: LucideIcon; tone: string; label: TranslationKey }> = {
  error: { icon: CircleX, tone: 'text-danger', label: 'projectTools.consoleErrors' },
  request: { icon: ArrowLeftRight, tone: 'text-danger', label: 'projectTools.consoleRequests' },
  warning: { icon: TriangleAlert, tone: 'text-warn', label: 'projectTools.consoleWarning' },
}
const FILTERS: { id: ConsoleFilter; label: TranslationKey }[] = [
  { id: 'all', label: 'projectTools.consoleAll' },
  { id: 'error', label: 'projectTools.consoleErrors' },
  { id: 'request', label: 'projectTools.consoleRequests' },
]

export function BrowserConsole({
  entries,
  prefs,
  busy,
  onPrefs,
  onClose,
  onClear,
  onQuote,
}: {
  /** 明细，旧的在前；还没取到时 null */
  entries: BrowserIssueEntry[] | null
  prefs: ConsolePrefs
  busy: boolean
  /** save=false：拖动途中只改界面 */
  onPrefs: (patch: Partial<ConsolePrefs>, save?: boolean) => void
  onClose: () => void
  onClear: () => void
  /** 放进输入框（list 旧的在前） */
  onQuote: (list: BrowserIssueEntry[]) => void
}) {
  useI18n()
  const [filter, setFilter] = useState<ConsoleFilter>('all')
  // 拖高时盖一层透明浮层：鼠标拖进网页（原生视图）就收不到事件了，有浮层时 BrowserTab 换成截图
  const [dragging, setDragging] = useState(false)
  useEffect(() => notifyOverlayChange(), [dragging])
  const list = entries ?? []
  const counts = filterCounts(list, prefs.warnings)
  const shown = visibleEntries(list, filter, prefs.warnings)
  return (
    <section
      data-browser-console
      aria-label={tr('projectTools.console')}
      // 最高到网页区留出最小高度（min-h-24 + 间距）为止：拖到 480 时窗口矮也不会把网页、批注栏挤出面板
      className="relative flex max-h-[calc(100%-6.5rem)] shrink-0 flex-col rounded-lg border border-line-card bg-surface shadow-sm"
      style={{ height: prefs.height }}
    >
      <ResizeHandle
        label={tr('projectTools.consoleResize')}
        axis="y"
        className="inset-x-0 -top-1.5"
        value={prefs.height}
        min={CONSOLE_HEIGHT.min}
        max={CONSOLE_HEIGHT.max}
        scale={-1}
        onChange={v => {
          setDragging(true)
          onPrefs({ height: v }, false)
        }}
        onCommit={v => {
          setDragging(false)
          onPrefs({ height: v })
        }}
        onReset={() => onPrefs({ height: CONSOLE_HEIGHT.initial })}
      />
      {dragging && <div data-floating className="fixed inset-0 z-10" />}
      <div className="flex shrink-0 flex-wrap items-center gap-1 px-2.5 pt-1.5">
        <h3 className="mr-1 text-list font-semibold whitespace-nowrap text-fg">{tr('projectTools.console')}</h3>
        {FILTERS.map(f => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full px-2 text-label whitespace-nowrap',
              filter === f.id ? 'bg-selected font-medium text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
            )}
          >
            {tr(f.label)}
            <span className="tabular-nums">{counts[f.id]}</span>
          </button>
        ))}
        <span className="flex-1" />
        <IconButton
          icon={Trash2}
          size={24}
          iconSize={14}
          label={tr('projectTools.consoleClear')}
          disabled={busy || !list.length}
          onClick={onClear}
        />
        <IconButton
          icon={ChevronDown}
          size={24}
          iconSize={15}
          label={tr('projectTools.consoleCollapse')}
          onClick={onClose}
        />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-line-subtle px-2.5 py-1.5">
        <label className="flex items-center gap-1.5 text-label whitespace-nowrap text-fg-muted">
          <Switch
            size="sm"
            checked={prefs.warnings}
            label={tr('projectTools.consoleWarnings')}
            onChange={on => onPrefs({ warnings: on })}
          />
          {tr('projectTools.consoleWarnings')}
        </label>
        <span className="flex-1" />
        <button
          type="button"
          data-console-send-all
          className="press inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-primary px-2.5 text-label font-medium whitespace-nowrap text-primary-fg hover:opacity-90 disabled:pointer-events-none disabled:opacity-45"
          disabled={!shown.length}
          onClick={() => onQuote([...shown].reverse())}
        >
          <Send size={12} />
          {tr('projectTools.consoleSendAll')}
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto">
        {entries && !shown.length && (
          <li className="flex h-full items-center justify-center p-3 text-meta text-fg-faint">
            {tr('projectTools.consoleEmpty')}
          </li>
        )}
        {shown.map((e, i) => {
          const kind = KIND[e.kind]
          return (
            <li
              key={`${e.at}:${i}`}
              data-console-entry={e.kind}
              className="group grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-2 border-b border-line-subtle px-2.5 py-1.5 last:border-b-0 hover:bg-hover"
            >
              <span className={cn('pt-0.5', kind.tone)} title={tr(kind.label)}>
                <kind.icon size={13} strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <p className="font-mono text-label leading-snug [overflow-wrap:anywhere] text-fg">{e.text}</p>
                <p className="mt-0.5 flex min-w-0 gap-2 text-label text-fg-faint">
                  <span className="shrink-0 tabular-nums">{clockTime(e.at)}</span>
                  {e.source && (
                    <span className="truncate" title={e.source}>
                      {e.source}
                    </span>
                  )}
                </p>
              </div>
              <button
                type="button"
                className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-label whitespace-nowrap text-fg-muted opacity-0 group-hover:opacity-100 hover:bg-selected hover:text-fg focus-visible:opacity-100"
                onClick={() => onQuote([e])}
              >
                <Send size={12} />
                {tr('projectTools.consoleSend')}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
