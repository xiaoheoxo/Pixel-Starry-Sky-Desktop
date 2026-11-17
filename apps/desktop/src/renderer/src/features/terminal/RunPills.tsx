// 运行胶囊（docs/ui/panel-pill.md）：手动开的终端不在眼前时，输入框状态栏显示它的状态
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Globe, TriangleAlert } from 'lucide-react'
import { useAppMode } from '@/features/coding/mode'
import { OPEN_BROWSER } from '@/features/panel/EnvironmentPanel'
import { openRightTab, useActivePanelTab } from '@/features/panel/workspaceStore'
import { portUrl, findPorts } from '@/features/coding/bottom/portsModel'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { cn, useToast } from '@/ui'
import { isDemo } from '@/data'
import { demo as demoData } from '@/data/demo'
import type { BrowserState } from '../../../../shared/types/project-browser'
import type { TerminalRecord } from '../../../../shared/types/terminal'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { sendTerminalQuote } from './AskAi'
import { browserFailed, browserIssueQuote, browserPillOf, type BrowserPill } from './browserPill'
import { quoteCard } from './errorLines'
import { lastLines, pillsOf, type HiddenRuns, type RunPill } from './pills'
import {
  dismissTerminalRun,
  subscribeTerminalHistory,
  terminalError,
  terminalHeadSince,
  terminalTextSince,
  useTerminalStore,
} from './store'
import { useOptionalTerminalUi } from './TerminalProvider'
import { workspaceTerminals } from './workspace'

const DETAIL_LINES = 6
const QUOTE_LINES = 30
const QUOTE_CHARS = 4096
const DETAIL_WIDTH = 340
/** 点过「从这里移除」的终端（模块级：状态栏重新挂载也不会让卡住的胶囊冒回来） */
export const hiddenRuns: Record<string, HiddenRuns[string]> = {}

/** 这些终端现在的胶囊；到点（2 秒门槛、✓ 到期）自己重算。输入框状态栏、极简顶栏的橙点、终端标签的转圈共用 */
export function useRunPills(records: readonly TerminalRecord[]): RunPill[] {
  const store = useTerminalStore()
  const { pills, nextAt } = pillsOf(records, store.marks, store.runs, Date.now(), hiddenRuns)
  const [, tick] = useState(0)
  useEffect(() => {
    if (nextAt === null) return
    const timer = setTimeout(() => tick(n => n + 1), Math.max(0, nextAt - Date.now()) + 20)
    return () => clearTimeout(timer)
  }, [nextAt])
  return pills
}

function Mark({ pill }: { pill: RunPill }) {
  if (pill.state === 'failed') return <TriangleAlert size={12} strokeWidth={1.75} className="shrink-0" />
  if (pill.state === 'done') return <Check size={12} strokeWidth={2} className="shrink-0 text-success" />
  return <span className="size-[7px] shrink-0 rounded-full bg-success" />
}

const statusText = (pill: RunPill, port: number | null): string =>
  pill.state === 'failed'
    ? tr('terminal.quote.exitCode', { code: pill.code ?? 0 })
    : pill.state === 'done'
      ? tr('terminal.pills.done')
      : port
        ? tr('terminal.pills.runningPort', { port })
        : tr('terminal.pills.running')

const portKey = (pill: RunPill): string => `${pill.id}:${pill.generation}:${pill.afterSeq}`

/** 这条命令开始之后输出里的第一个本机端口。只在输出变化时扫（渲染里扫的话流式输出时会一直重复），找到就不再扫 */
function usePorts(pills: RunPill[]): ReadonlyMap<string, number> {
  const [found, setFound] = useState<ReadonlyMap<string, number>>(new Map())
  const waiting = pills.filter(p => p.state === 'running' && !found.has(portKey(p)))
  const waitingKey = waiting.map(portKey).join(' ')
  useEffect(() => {
    if (!waitingKey) return
    const scan = (): void => {
      const hits = waiting.flatMap(pill => {
        const port = findPorts(terminalHeadSince(pill.id, pill.afterSeq))[0]
        return port === undefined ? [] : [[portKey(pill), port] as const]
      })
      if (hits.length) setFound(prev => new Map([...prev, ...hits]))
    }
    scan()
    return subscribeTerminalHistory(scan)
    // waitingKey 没变，waiting 就是同一批
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey])
  return found
}

function Detail({
  pill,
  port,
  open,
  onAskAi,
  onHide,
  browserRef,
}: {
  pill: RunPill
  port: number | null
  open: (pill: RunPill) => void
  onAskAi: (pill: RunPill) => void
  onHide: (pill: RunPill) => void
  browserRef: WorkspaceRef | null
}) {
  const lines = lastLines(terminalTextSince(pill.id, pill.afterSeq), DETAIL_LINES)
  const button = 'rounded-md border border-line-card px-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg'
  return (
    <div data-run-pill-detail className="border-line-subtle not-first:mt-2 not-first:border-t not-first:pt-2">
      <div className="flex items-center gap-1.5 text-ui text-fg">
        <span className={cn('inline-flex shrink-0 items-center', pill.state === 'failed' && 'text-danger')}>
          <Mark pill={pill} />
        </span>
        <span className="min-w-0 truncate" title={pill.name}>
          {pill.name}
        </span>
        <span className="ml-auto shrink-0 text-label text-fg-muted">{statusText(pill, port)}</span>
      </div>
      {lines.length > 0 && (
        <pre className="my-1.5 max-h-32 overflow-hidden rounded-md bg-hover px-2 py-1.5 font-mono text-label break-all whitespace-pre-wrap text-fg-secondary">
          {lines.join('\n')}
        </pre>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => open(pill)}
          className={cn(button, 'border-transparent bg-accent-soft text-accent-fg')}
        >
          {tr('terminal.pills.open')}
        </button>
        {pill.state === 'failed' && (
          <button type="button" onClick={() => onAskAi(pill)} className={button}>
            {tr('terminal.pills.askAi')}
          </button>
        )}
        {pill.state === 'running' && port !== null && browserRef && (
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent(OPEN_BROWSER, { detail: { ref: browserRef, url: portUrl(port) } }))
            }
            className={button}
          >
            {tr('terminal.pills.openBrowser')}
          </button>
        )}
        {pill.state === 'running' && (
          <button
            type="button"
            onClick={() => void window.pixelsky?.terminal.write(pill.id, pill.generation, '\x03').catch(terminalError)}
            className={button}
          >
            {tr('terminal.pills.stop')}
          </button>
        )}
        {pill.state === 'running' && (
          <button type="button" onClick={() => onHide(pill)} title={tr('terminal.pills.hideTitle')} className={button}>
            {tr('terminal.pills.hide')}
          </button>
        )}
      </div>
    </div>
  )
}

/** 一个胶囊按钮和它的详情。详情挂到 body：窄宽时状态栏 overflow: hidden，放里面会被裁掉 */
function Pill({
  details,
  label,
  failed,
  ariaLabel,
  onClick,
  attrs,
}: {
  /** 悬停 / 键盘选中时的详情 */
  details: ReactNode
  label: ReactNode
  failed: boolean
  ariaLabel: string
  onClick: () => void
  attrs?: Record<string, string>
}) {
  const [at, setAt] = useState<{ right: number; bottom: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const detail = useRef<HTMLDivElement>(null)
  const show = (): void => {
    if (timer.current) clearTimeout(timer.current)
    const rect = anchor.current?.getBoundingClientRect()
    if (rect) setAt({ right: rect.right, bottom: window.innerHeight - rect.top })
  }
  const hide = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setAt(null), 120)
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return (
    <span
      {...attrs}
      className="inline-flex min-w-0"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={e => {
        if (!at) return
        if (e.key === 'Escape') {
          e.stopPropagation()
          anchor.current?.focus()
          setAt(null)
        } else if (e.key === 'ArrowUp' && e.target === anchor.current) {
          // 详情挂在 body 上，Tab 走不到：↑ 进去，里面 Tab 切按钮，Esc 回胶囊
          e.preventDefault()
          detail.current?.querySelector('button')?.focus()
        }
      }}
    >
      <button
        ref={anchor}
        type="button"
        data-run-pill
        aria-label={ariaLabel}
        aria-keyshortcuts="ArrowUp"
        onClick={onClick}
        className={cn(
          'inline-flex h-5 max-w-[180px] items-center gap-1.5 rounded-full border px-2 text-label whitespace-nowrap',
          failed
            ? 'border-danger/45 bg-danger/10 text-danger hover:bg-danger/15'
            : 'border-line-card bg-hover text-fg-secondary hover:bg-selected hover:text-fg',
        )}
      >
        {label}
      </button>
      {at &&
        createPortal(
          <div
            className="fixed z-50 pb-2"
            style={{ left: Math.max(8, at.right - DETAIL_WIDTH), bottom: at.bottom, width: DETAIL_WIDTH }}
          >
            <div
              ref={detail}
              className="rounded-lg border border-line-card bg-popover p-2 text-fg-secondary shadow-popover"
            >
              {details}
            </div>
          </div>,
          document.body,
        )}
    </span>
  )
}

const browserStatus = (pill: BrowserPill): string =>
  pill.error
    ? tr('terminal.pills.browserFailed')
    : pill.issues > 0
      ? tr('terminal.pills.browserIssues', { n: pill.issues })
      : pill.loading
        ? tr('terminal.pills.browserLoading')
        : tr('terminal.pills.browserOpen')

/** 这个会话所在工作区的内置浏览器状态（主进程按工作区存，变了广播）；演示模式用演示数据 */
function useBrowserState(ref: WorkspaceRef | null): BrowserState | null {
  const [state, setState] = useState<BrowserState | null>(() => (isDemo ? demoData().projectTools.browser : null))
  useEffect(() => {
    const api = window.pixelsky?.projectBrowser
    if (isDemo || !ref || !api) return
    let gone = false,
      scope: string | null = null
    void api.state(ref).then(
      next => {
        if (gone) return
        scope = next.scope
        setState(next)
      },
      () => {},
    )
    const off = api.onChange(next => {
      if (!gone && next.scope === scope) setState(next)
    })
    return () => {
      gone = true
      off()
      setState(null)
    }
  }, [ref])
  return state
}

function BrowserDetail({
  pill,
  onOpen,
  onReload,
  onAskAi,
}: {
  pill: BrowserPill
  onOpen: (pill: BrowserPill) => void
  onReload: (pill: BrowserPill) => void
  onAskAi: (pill: BrowserPill) => void
}) {
  const failed = browserFailed(pill)
  const lines = [...(pill.error ? [pill.error] : []), ...pill.last]
  const button = 'rounded-md border border-line-card px-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg'
  return (
    <div data-run-pill-detail className="border-line-subtle not-first:mt-2 not-first:border-t not-first:pt-2">
      <div className="flex items-center gap-1.5 text-ui text-fg">
        <span className={cn('inline-flex shrink-0 items-center', failed && 'text-danger')}>
          <Globe size={12} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 truncate" title={pill.title}>
          {pill.title || pill.label}
        </span>
        <span className={cn('ml-auto shrink-0 text-label', failed ? 'text-danger' : 'text-fg-muted')}>
          {browserStatus(pill)}
        </span>
      </div>
      <div title={pill.url} className="truncate pt-0.5 font-mono text-label text-fg-faint">
        {pill.url}
      </div>
      {lines.length > 0 && (
        <pre className="my-1.5 max-h-32 overflow-hidden rounded-md bg-hover px-2 py-1.5 font-mono text-label break-all whitespace-pre-wrap text-fg-secondary">
          {lines.join('\n')}
        </pre>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => onOpen(pill)}
          className={cn(button, 'border-transparent bg-accent-soft text-accent-fg')}
        >
          {tr('terminal.pills.openBrowserTab')}
        </button>
        <button type="button" onClick={() => onReload(pill)} className={button}>
          {tr('terminal.pills.reload')}
        </button>
        {failed && (
          <button type="button" onClick={() => onAskAi(pill)} className={button}>
            {tr('terminal.pills.browserAskAi')}
          </button>
        )}
      </div>
    </div>
  )
}

export const RunPills = memo(function RunPills({
  projectId,
  cwd,
  panelOpen,
  browserRef,
}: {
  projectId: string
  cwd: string
  panelOpen: boolean
  browserRef: WorkspaceRef | null
}) {
  useI18n()
  const store = useTerminalStore()
  const ui = useOptionalTerminalUi()
  const toast = useToast()
  const tab = useActivePanelTab()
  const mode = useAppMode()
  const inView = panelOpen && tab === 'terminal'
  const records = useMemo(
    () => workspaceTerminals(store.terminals, projectId, cwd, window.pixelsky?.platform === 'win32'),
    [store.terminals, projectId, cwd],
  )
  const pills = useRunPills(records)
  const ports = usePorts(pills)

  // 正看着的那个终端：结束的状态算看过了
  const activeId = ui?.activeId ?? null
  const viewing = inView && activeId !== null && pills.some(p => p.id === activeId && p.state !== 'running')
  useEffect(() => {
    if (viewing && activeId) dismissTerminalRun(activeId)
  }, [viewing, activeId])

  // 内置浏览器（§8.1）：浏览器标签不在眼前时，当前页一个胶囊
  const browserState = useBrowserState(browserRef)
  const browser = browserPillOf(browserState, panelOpen && tab === 'browser')
  const terms = inView ? [] : pills

  // 代码模式底部本来就有终端，右边有浏览器
  if (mode === 'code' || (!terms.length && !browser)) return null

  const open = (pill: RunPill): void => {
    ui?.select(pill.id)
    openRightTab('terminal')
    if (pill.state !== 'running') dismissTerminalRun(pill.id)
  }
  const askAi = (pill: RunPill): void => {
    const quoted = lastLines(terminalTextSince(pill.id, pill.afterSeq), QUOTE_LINES).join('\n').slice(-QUOTE_CHARS)
    const failed = sendTerminalQuote(
      quoteCard({
        start: -1,
        end: -1,
        text: quoted,
        command: pill.name,
        exitCode: pill.code,
      }),
      tr('terminal.ask.fixPrompt'),
    )
    if (failed) toast(failed)
  }
  const hide = (pill: RunPill): void => {
    hiddenRuns[pill.id] = { generation: pill.generation, prompts: store.marks[pill.id]?.prompts ?? 0 }
    dismissTerminalRun(pill.id)
  }
  const portOf = (pill: RunPill): number | null => ports.get(portKey(pill)) ?? null
  const describe = (pill: RunPill): string => `${pill.name}, ${statusText(pill, portOf(pill))}`
  const renderDetail = (pill: RunPill): ReactNode => (
    <Detail
      key={pill.id}
      pill={pill}
      port={portOf(pill)}
      open={open}
      onAskAi={askAi}
      onHide={hide}
      browserRef={browserRef}
    />
  )
  const openBrowser = (pill: BrowserPill): void => {
    if (browserRef) void window.pixelsky?.projectBrowser.select(browserRef, pill.pageId).catch(() => {})
    openRightTab('browser')
  }
  const reloadBrowser = (pill: BrowserPill): void => {
    if (browserRef)
      void window.pixelsky?.projectBrowser
        .action(browserRef, pill.pageId, 'reload')
        .catch((e: Error) => toast(e.message))
  }
  const askBrowser = (pill: BrowserPill): void => {
    const failed = sendTerminalQuote(browserIssueQuote(pill), tr('terminal.ask.fixPrompt'))
    if (failed) toast(failed)
  }
  const browserDetail = browser && (
    <BrowserDetail key="browser" pill={browser} onOpen={openBrowser} onReload={reloadBrowser} onAskAi={askBrowser} />
  )
  const browserLabel = (pill: BrowserPill): string =>
    tr('terminal.pills.browserLabel', { url: pill.label, status: browserStatus(pill) })
  const shown = terms.slice(0, 2)
  const rest = terms.slice(2)
  const anyFailed = terms.some(p => p.state === 'failed') || (!!browser && browserFailed(browser))
  const count = terms.length + (browser ? 1 : 0)
  const first = terms[0]
  return (
    <span data-run-pills className="mr-2 flex min-w-0 items-center gap-1.5">
      <span data-run-pills-list className="flex min-w-0 items-center gap-1.5">
        {shown.map(pill => {
          const port = portOf(pill)
          return (
            <Pill
              key={pill.id}
              details={renderDetail(pill)}
              failed={pill.state === 'failed'}
              ariaLabel={describe(pill)}
              onClick={() => open(pill)}
              label={
                <>
                  <Mark pill={pill} />
                  <span data-run-pill-long className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate">{pill.name}</span>
                    {pill.state === 'failed' && <span>{statusText(pill, null)}</span>}
                    {port !== null && <span className="font-mono text-fg-muted">:{port}</span>}
                  </span>
                  <span data-run-pill-short className="max-w-24 min-w-0 truncate">
                    {port !== null ? `:${port}` : pill.short}
                  </span>
                </>
              }
            />
          )
        })}
        {rest.length > 0 && (
          <Pill
            details={rest.map(renderDetail)}
            failed={false}
            ariaLabel={tr('terminal.pills.more', { n: rest.length })}
            onClick={() => open(rest[0])}
            label={`+${rest.length}`}
          />
        )}
        {browser && (
          <Pill
            attrs={{ 'data-browser-pill': '' }}
            details={browserDetail}
            failed={browserFailed(browser)}
            ariaLabel={browserLabel(browser)}
            onClick={() => openBrowser(browser)}
            label={
              <>
                <Globe size={12} strokeWidth={1.75} className="shrink-0" />
                <span data-run-pill-long className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate font-mono">{browser.label}</span>
                  {browserFailed(browser) && <span className="shrink-0">{browserStatus(browser)}</span>}
                </span>
                <span data-run-pill-short className="max-w-24 min-w-0 truncate">
                  {browserFailed(browser) ? browserStatus(browser) : browser.label}
                </span>
              </>
            }
          />
        )}
      </span>
      <span data-run-pills-merged className="min-w-0">
        <Pill
          details={[...terms.map(renderDetail), browserDetail]}
          failed={anyFailed}
          ariaLabel={[...terms.map(describe), ...(browser ? [browserLabel(browser)] : [])].join('; ')}
          onClick={() => (first ? open(first) : browser && openBrowser(browser))}
          label={
            <>
              {first ? <Mark pill={first} /> : <Globe size={12} strokeWidth={1.75} className="shrink-0" />}
              <span className="min-w-0 truncate">
                {count > 1
                  ? tr('terminal.pills.items', { n: count })
                  : first
                    ? portOf(first) !== null
                      ? `:${portOf(first)}`
                      : first.short
                    : browserFailed(browser!)
                      ? browserStatus(browser!)
                      : browser!.label}
              </span>
            </>
          }
        />
      </span>
    </span>
  )
})
