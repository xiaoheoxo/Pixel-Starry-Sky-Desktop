import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
// 设置 › 日志（docs/ui/logging.md §3.1）：读最近的条目、实时追加、筛选；打开文件夹、复制错误、导出诊断文件、详细日志
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, ClipboardCopy, FileDown, FolderOpen, MessageSquareText, Search, X } from 'lucide-react'
import { formatLogLine, type LogEntry, type LogLevel, type LogQuery, type LogSettings } from '@pixelsky/protocol'
import { Button, CopyButton, Segmented, Select, Spinner, cn } from '@/ui'
import { SectionTitle, SettingRow, Toggle } from '../settings/SettingRow'
import { MAX_ENTRIES, appendLive, entryKey, recentProblems, remaining, scopesOf, shortTime } from './logView'
import { onLogFocus, takeLogFocus, type LogFocus } from './focus'
import { requestFeedback } from '../feedback/focus'
import { useSettings } from '../settings/SettingsProvider'

type LevelFilter = 'all' | 'warn' | 'error'

const LEVEL_TONE: Record<LogLevel, string> = {
  debug: 'text-fg-faint',
  info: 'text-fg-muted',
  warn: 'text-warn',
  error: 'text-danger',
}

export function LogsSection() {
  useI18n()
  const bridge = window.pixelsky?.log
  const appSettings = useSettings()
  const [settings, setSettings] = useState<LogSettings | null>(null)
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [level, setLevel] = useState<LevelFilter>('all')
  const [scope, setScope] = useState('')
  const [input, setInput] = useState('')
  const [text, setText] = useState('')
  const [focus, setFocus] = useState<LogFocus | null>(() => takeLogFocus())
  const [now, setNow] = useState(() => Date.now())

  // 搜索框停下 250ms 再查
  useEffect(() => {
    const t = setTimeout(() => setText(input.trim()), 250)
    return () => clearTimeout(t)
  }, [input])

  // 日志页已经打开时，又从别的报错跳过来
  useEffect(() => onLogFocus(() => setFocus(takeLogFocus())), [])

  // 剩余时间、列表里的「今天」每分钟刷新
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!bridge) return
    bridge.settings().then(setSettings, (e: unknown) => setError(String((e as Error)?.message ?? e)))
  }, [bridge])

  const query = useMemo<LogQuery>(
    () => ({
      ...(level === 'all' ? {} : { minLevel: level }),
      ...(scope ? { scope } : {}),
      ...(text ? { text } : {}),
      ...(focus ? { sessionId: focus.sessionId, since: focus.since } : {}),
      limit: MAX_ENTRIES,
    }),
    [level, scope, text, focus],
  )

  // 条件变了重新读；读的同时先收实时条目，读完再拼上（避免中间漏掉）
  useEffect(() => {
    if (!bridge) {
      setLoading(false)
      setError(tr('logs.unavailable'))
      return
    }
    let cancelled = false
    let live: LogEntry[] = []
    let loaded = false
    setLoading(true)
    // 实时条目攒 100ms 一起加：日志来得密的时候（会话在跑、详细日志）不至于每条都重画一次列表
    let batch: LogEntry[] = []
    let timer = 0
    const flush = () => {
      timer = 0
      const add = batch
      batch = []
      if (!cancelled && add.length) setEntries(list => add.reduce((acc, e) => appendLive(acc, e, query), list))
    }
    const off = bridge.onEntry(entry => {
      if (cancelled) return
      if (!loaded) live.push(entry)
      else {
        batch.push(entry)
        if (!timer) timer = window.setTimeout(flush, 100)
      }
    })
    bridge.read(query).then(
      list => {
        if (cancelled) return
        loaded = true
        const last = list.at(-1)?.ts ?? 0
        let merged = list
        for (const entry of live) if (entry.ts > last) merged = appendLive(merged, entry, query)
        live = []
        setEntries(merged)
        setLoading(false)
        setError(null)
      },
      (e: unknown) => {
        if (cancelled) return
        setLoading(false)
        setError(String((e as Error)?.message ?? e))
      },
    )
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      off()
    }
  }, [bridge, query])

  // 滚到底部时跟随新条目
  const listRef = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [entries])

  const [open, setOpen] = useState<Set<LogEntry>>(() => new Set())
  const toggleOpen = useCallback((entry: LogEntry) => {
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(entry)) next.delete(entry)
      else next.add(entry)
      return next
    })
  }, [])

  // 每次操作都换掉上一次的结果：之前失败的红字不能一直盖住这次的提示
  const run = (action: () => Promise<void>) => {
    setNotice(null)
    setError(null)
    action().catch((e: unknown) => setError(String((e as Error)?.message ?? e)))
  }

  const copyProblems = () =>
    run(async () => {
      const lines = recentProblems(entries)
      if (!lines.length) {
        setNotice(tr('logs.noErrors'))
        return
      }
      await navigator.clipboard.writeText(lines.join('\n'))
      setNotice(tr('logs.copiedErrors', { p0: lines.length }))
    })

  const exportFile = () =>
    run(async () => {
      const path = await bridge?.exportDiagnostics()
      if (path) setNotice(tr('logs.exported', { p0: path }))
    })

  const setVerbose = (on: boolean) =>
    run(async () => {
      setSettings((await bridge?.setVerbose(on)) ?? null)
      setNow(Date.now())
    })

  const left = remaining(settings?.verboseUntil ?? null, now)
  const scopes = scopesOf(entries, scope)

  return (
    <section className="flex min-h-0 flex-col">
      <SectionTitle>{tr('logs.title')}</SectionTitle>
      <p className="mb-1 text-meta text-fg-muted">{tr('logs.intro')}</p>
      {settings && (
        <p className="selectable mb-4 truncate font-mono text-meta text-fg-faint" title={settings.dir}>
          {tr('logs.folder', { p0: settings.dir })}
        </p>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <Button icon={FolderOpen} onClick={() => run(async () => bridge?.openFolder())} disabled={!bridge}>
          {tr('logs.openFolder')}
        </Button>
        <Button icon={ClipboardCopy} onClick={copyProblems} disabled={!entries.length}>
          {tr('logs.copyErrors')}
        </Button>
        <Button icon={FileDown} onClick={exportFile} disabled={!bridge}>
          {tr('logs.export')}
        </Button>
        <Button
          icon={MessageSquareText}
          onClick={() => {
            requestFeedback({ type: 'bug', logs: true })
            appSettings.openSettings('feedback')
          }}
        >
          {tr('feedback.logsSubmit')}
        </Button>
      </div>

      {(error || notice) && (
        <p
          className={cn(
            'selectable mb-4 rounded-md bg-subtle px-3 py-2 text-meta break-all',
            error ? 'text-danger' : 'text-fg-secondary',
          )}
        >
          {error ? translateMessage(error) : notice}
        </p>
      )}

      <SettingRow
        title={tr('logs.verbose')}
        description={tr('logs.verboseDesc')}
        hint={
          left
            ? tr('logs.verboseLeft', {
                p0: left[0]
                  ? tr('logs.hoursMinutes', { p0: left[0], p1: left[1] })
                  : tr('logs.minutes', { p0: left[1] }),
              })
            : undefined
        }
        control={<Toggle label={tr('logs.verbose')} checked={!!left} onChange={setVerbose} />}
      />

      <div className="mt-2 mb-2 flex flex-wrap items-center gap-2">
        <Segmented<LevelFilter>
          label={tr('logs.level')}
          value={level}
          onChange={setLevel}
          options={[
            { value: 'all', label: tr('logs.levelAll') },
            { value: 'warn', label: tr('logs.levelWarn') },
            { value: 'error', label: tr('logs.levelError') },
          ]}
        />
        <Select
          label={tr('logs.scope')}
          value={scope}
          onChange={setScope}
          fitContent
          mono
          options={[{ value: '', label: tr('logs.scopeAll') }, ...scopes.map(s => ({ value: s, label: s }))]}
        />
        <label className="flex h-8 min-w-40 flex-1 items-center gap-1.5 rounded-md border border-line bg-surface px-2 focus-within:border-accent">
          <Search size={14} strokeWidth={1.75} className="shrink-0 text-fg-faint" />
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={tr('logs.search')}
            aria-label={tr('logs.search')}
            className="min-w-0 flex-1 bg-transparent text-list text-fg outline-none placeholder:text-fg-faint"
          />
          {input && (
            <button
              type="button"
              aria-label={tr('logs.clearFilter')}
              onClick={() => setInput('')}
              className="text-fg-faint hover:text-fg"
            >
              <X size={13} />
            </button>
          )}
        </label>
      </div>

      {focus && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-accent-soft px-3 py-1.5 text-meta text-fg-secondary">
          <span className="min-w-0 flex-1 truncate">{tr('logs.sessionFilter')}</span>
          <button type="button" onClick={() => setFocus(null)} className="shrink-0 text-accent hover:underline">
            {tr('logs.clearFilter')}
          </button>
        </div>
      )}

      <div
        ref={listRef}
        onScroll={e => {
          const el = e.currentTarget
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="selectable h-[420px] overflow-auto rounded-md border border-line bg-surface font-mono text-meta"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-fg-muted">
            <Spinner size={13} />
            {tr('logs.loading')}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-fg-muted">{tr('logs.empty')}</div>
        ) : (
          entries.map(entry => (
            <LogRow key={entryKey(entry)} entry={entry} now={now} open={open.has(entry)} onToggle={toggleOpen} />
          ))
        )}
      </div>
      {!loading && entries.length > 0 && (
        <p className="mt-1.5 text-meta text-fg-faint">{tr('logs.shown', { p0: entries.length })}</p>
      )}
    </section>
  )
}

/**
 * 一条日志。用 memo：新来一条只画新的这一行（原来每条都把 1000 行重画一遍，一次 70ms 左右，docs/ui/performance.md §4）。
 * 屏幕外的行 content-visibility: auto，浏览器不排版、不绘制。
 */
const LogRow = memo(function LogRow({
  entry,
  now,
  open,
  onToggle,
}: {
  entry: LogEntry
  now: number
  open: boolean
  onToggle: (entry: LogEntry) => void
}) {
  const hasFields = !!entry.fields
  const multiline = entry.message.includes('\n')
  const expandable = hasFields || multiline
  return (
    <div
      className={cn(
        'border-b border-line-subtle [contain-intrinsic-size:auto_26px] [content-visibility:auto] last:border-b-0',
        open && 'bg-subtle',
      )}
    >
      <button
        type="button"
        onClick={expandable ? () => onToggle(entry) : undefined}
        aria-expanded={expandable ? open : undefined}
        // 完整时间第一次悬停时再算：1000 行一起算本地化时间也要几十毫秒
        onPointerEnter={e => {
          if (!e.currentTarget.title) e.currentTarget.title = new Date(entry.ts).toLocaleString()
        }}
        className={cn(
          'flex w-full items-start gap-2 px-2 py-1 text-left',
          expandable ? 'cursor-pointer hover:bg-hover' : 'cursor-text',
        )}
      >
        <ChevronRight
          size={12}
          className={cn(
            'mt-0.5 shrink-0 text-fg-faint transition-transform',
            open && 'rotate-90',
            !expandable && 'invisible',
          )}
        />
        <span className="shrink-0 text-fg-faint tabular-nums">{shortTime(entry.ts, now)}</span>
        <span className={cn('w-11 shrink-0 font-medium uppercase', LEVEL_TONE[entry.level])}>{entry.level}</span>
        <span className="max-w-32 shrink-0 truncate text-fg-muted">{entry.scope}</span>
        <span className={cn('min-w-0 flex-1 text-fg', open ? 'break-all whitespace-pre-wrap' : 'truncate')}>
          {open ? entry.message : entry.message.split('\n')[0]}
        </span>
      </button>
      {open && (
        <div className="flex items-start gap-2 px-2 pb-2 pl-7">
          {hasFields && (
            <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-surface px-2 py-1.5 text-fg-secondary">
              {JSON.stringify(entry.fields, null, 2)}
            </pre>
          )}
          <div className="shrink-0">
            <CopyButton iconOnly label={tr('logs.copyEntry')} text={formatLogLine(entry)} />
          </div>
        </div>
      )}
    </div>
  )
})
