// 运行胶囊（docs/ui/panel-pill.md）：手动开的终端不在眼前时，输入框状态栏显示它的状态
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, TriangleAlert } from 'lucide-react'
import { useAppMode } from '@/features/coding/mode'
import { OPEN_BROWSER } from '@/features/panel/EnvironmentPanel'
import { openRightTab, useActivePanelTab } from '@/features/panel/workspaceStore'
import { portUrl, findPorts } from '@/features/coding/bottom/portsModel'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { cn, useToast } from '@/ui'
import type { TerminalRecord } from '../../../../shared/types/terminal'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { sendTerminalQuote } from './AskAi'
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
  pills,
  label,
  failed,
  ariaLabel,
  onClick,
  renderDetail,
  attrs,
}: {
  pills: RunPill[]
  label: ReactNode
  failed: boolean
  ariaLabel: string
  onClick: () => void
  renderDetail: (pill: RunPill) => ReactNode
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
              {pills.map(renderDetail)}
            </div>
          </div>,
          document.body,
        )}
    </span>
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

  // 代码模式底部本来就有终端
  if (mode === 'code' || inView || !pills.length) return null

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
  const shown = pills.slice(0, 2)
  const rest = pills.slice(2)
  const anyFailed = pills.some(p => p.state === 'failed')
  return (
    <span data-run-pills className="mr-2 flex min-w-0 items-center gap-1.5">
      <span data-run-pills-list className="flex min-w-0 items-center gap-1.5">
        {shown.map(pill => {
          const port = portOf(pill)
          return (
            <Pill
              key={pill.id}
              pills={[pill]}
              failed={pill.state === 'failed'}
              ariaLabel={describe(pill)}
              onClick={() => open(pill)}
              renderDetail={renderDetail}
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
            pills={rest}
            failed={false}
            ariaLabel={tr('terminal.pills.more', { n: rest.length })}
            onClick={() => open(rest[0])}
            renderDetail={renderDetail}
            label={`+${rest.length}`}
          />
        )}
      </span>
      <span data-run-pills-merged className="min-w-0">
        <Pill
          pills={pills}
          failed={anyFailed}
          ariaLabel={pills.map(describe).join('; ')}
          onClick={() => open(pills[0])}
          renderDetail={renderDetail}
          label={
            <>
              <Mark pill={pills[0]} />
              <span className="min-w-0 truncate">
                {pills.length > 1
                  ? tr('terminal.pills.items', { n: pills.length })
                  : portOf(pills[0]) !== null
                    ? `:${portOf(pills[0])}`
                    : pills[0].short}
              </span>
            </>
          }
        />
      </span>
    </span>
  )
})
