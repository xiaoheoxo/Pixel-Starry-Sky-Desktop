import { translateMessage } from '../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, FolderOpen, RefreshCw, Scissors, X } from 'lucide-react'
import type { ContextDetail, ContextDetailLevel, ContextWindow, EngineId } from '@pixelsky/protocol'
import { ContextRing, cn, useToast } from '@/ui'
import { bridge, useSession } from '@/features/engine'
import { isDemo } from '@/data'
import { openFile } from '@/features/files/store'
import { workspaceFilePath, workspaceRoot } from '@/features/files/pathLinks'
import { machineOf, useMachines } from '@/features/machines/store'
import { motionEnabled } from '@/features/panes/motion'
import {
  changedRows,
  contextLabel,
  contextNumber,
  contextPercentage,
  contextSegments,
  diagnosticValues,
  spinRemaining,
} from './contextData'
import { displayMemoryPath, splitFileName, type MemoryPathBase } from './memoryPath'
import { demo } from '@/data/demo'
import { useSettings } from '@/features/settings/SettingsProvider'
import { openContextSettings } from '@/features/settings/models/contextWindows'
import { AccountUsagePanel } from './AccountUsagePanel'

/** 刷新图标转一圈的时长；明细通常几十毫秒就回来，至少转完一圈（docs/ui/context-window.md §7） */
const SPIN_MS = 700
/** 「已刷新」显示多久 */
const REFRESHED_MS = 1500
/** 刷新开始后多久内到的新明细算这次刷新的结果（用来亮一下变了的数字） */
const FLASH_WINDOW_MS = 3000
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))

/** 演示模式：每刷新一次对话消息多 1.2k，剩余空间相应减少，看得到数字亮一下 */
function demoRefreshed(context: ContextWindow, n: number): ContextWindow {
  const d = context.diagnostic
  if (!n || !d) return context
  const grow = 1200 * n
  return {
    ...context,
    used: (context.used ?? 0) + grow,
    diagnostic: {
      ...d,
      used: d.used + grow,
      categories: d.categories.map(c =>
        c.name === 'Messages'
          ? { ...c, tokens: c.tokens + grow }
          : c.kind === 'free'
            ? { ...c, tokens: Math.max(0, c.tokens - grow) }
            : c,
      ),
    },
  }
}

export function ContextWindowButton({
  sessionId,
  engine,
  nativeAccount = true,
}: {
  sessionId: string | null
  engine: EngineId
  nativeAccount?: boolean
}) {
  useI18n()
  const toast = useToast()
  const settings = useSettings()
  const snapshot = useSession(isDemo ? null : sessionId)
  const [demoRefreshes, setDemoRefreshes] = useState(0)
  const context = isDemo ? demoRefreshed(demo().context, demoRefreshes) : snapshot?.context
  const percent = contextPercentage(context),
    segments = contextSegments(context)
  const [open, setOpen] = useState(false),
    [details, setDetails] = useState(false),
    [busy, setBusy] = useState<'inspect' | 'compact' | null>(null),
    [confirm, setConfirm] = useState(false),
    [error, setError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null)
  // 引擎支持 get_context_usage 时运行中也能取明细；否则只能在空闲、没有排队时发 /context
  const live = !!snapshot?.flags.contextLive
  const idle = snapshot?.state === 'idle' && !snapshot.queue.length
  const canInspect = !isDemo && !!sessionId && !busy && (live || (!!snapshot?.flags.contextAvailable && idle))
  const canCompact =
    !isDemo &&
    !!sessionId &&
    !!snapshot?.flags.compactAvailable &&
    snapshot.state === 'idle' &&
    !snapshot.queue.length &&
    !busy
  const diagnostic = context?.diagnostic
  const compactLimit =
    diagnostic && !context?.diagnosticStale
      ? diagnostic.window - (diagnostic.categories.find(c => c.kind === 'buffer')?.tokens ?? 0)
      : null
  const reason = isDemo
    ? tr('session.ContextWindowButton.engineActionsAreUnavailable')
    : !sessionId
      ? tr('session.ContextWindowButton.startConversationFirst')
      : snapshot?.state !== 'idle' || !!snapshot?.queue.length
        ? tr('session.ContextWindowButton.waitForCurrentTask')
        : tr('session.ContextWindowButton.thisEngineDoesNot')
  useEffect(() => {
    setOpen(false)
    setConfirm(false)
    setError('')
  }, [sessionId, snapshot?.record.model, snapshot?.record.platform?.groupId])
  const close = (): void => {
    setOpen(false)
    setConfirm(false)
    trigger.current?.focus()
  }
  useLayoutEffect(() => {
    if (!open || !popup.current || !trigger.current) return
    const position = (): void => {
      const r = trigger.current!.getBoundingClientRect(),
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
  }, [open])
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (!popup.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) {
        setOpen(false)
        setConfirm(false)
      }
    }
    window.addEventListener('pointerdown', down)
    return () => window.removeEventListener('pointerdown', down)
  }, [open])
  const inspect = async (detail: ContextDetailLevel): Promise<boolean> => {
    if (!canInspect || !sessionId) return false
    setBusy('inspect')
    setError('')
    try {
      await bridge?.context(sessionId, detail)
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(null)
    }
  }
  // 「刷新明细」：图标至少转完一圈，之后「已刷新」显示一会儿，变了的数字亮一下（关闭动画时只显示「已刷新」）
  const [spinning, setSpinning] = useState(false),
    [refreshed, setRefreshed] = useState(false),
    [flash, setFlash] = useState<{ rows: Set<string>; n: number }>({ rows: new Set(), n: 0 })
  const flashFrom = useRef<{ values: Map<string, number>; at: number } | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const canRefresh = (isDemo || canInspect) && !spinning
  const refresh = async (): Promise<void> => {
    if (!canRefresh) return
    const start = performance.now(),
      animate = motionEnabled()
    flashFrom.current = { values: diagnosticValues(diagnostic), at: Date.now() }
    setSpinning(true)
    setRefreshed(false)
    let ok = true
    if (isDemo) {
      await sleep(60)
      setDemoRefreshes(n => n + 1)
    } else ok = await inspect('full')
    if (animate) await sleep(spinRemaining(performance.now() - start, SPIN_MS))
    if (!alive.current) return
    setSpinning(false)
    if (ok) setRefreshed(true)
  }
  useEffect(() => {
    if (!refreshed) return
    const t = setTimeout(() => setRefreshed(false), REFRESHED_MS)
    return () => clearTimeout(t)
  }, [refreshed])
  // 新明细到了（转完一圈之后再亮，和「已刷新」同时出现）：和刷新前比，变了的行亮一下
  useEffect(() => {
    const from = flashFrom.current
    if (!from || spinning) return
    if (Date.now() - from.at > FLASH_WINDOW_MS) {
      flashFrom.current = null
      return
    }
    const rows = changedRows(from.values, diagnosticValues(diagnostic))
    if (!rows.size) return
    flashFrom.current = null
    if (motionEnabled()) setFlash(f => ({ rows, n: f.n + 1 }))
  }, [spinning, diagnostic])
  useEffect(() => {
    if (!flash.rows.size) return
    // 亮完就清掉：不然关了再打开弹窗又亮一次
    const t = setTimeout(() => setFlash(f => ({ rows: new Set(), n: f.n })), 1000)
    return () => clearTimeout(t)
  }, [flash])
  const flashKey = (row: string): string => (flash.rows.has(row) ? `${row}#${flash.n}` : row)

  // 记忆文件（docs/ui/context-window.md §7）：项目里的在右侧打开，项目外的交给主进程用默认编辑器打开
  const machines = useMachines()
  const machine = machineOf(sessionId)
  const [root, setRoot] = useState<string | null>(null)
  useEffect(() => {
    if (isDemo || !sessionId || !window.pixelsky) return
    let live = true
    void workspaceRoot({ sessionId }).then(path => live && setRoot(path))
    return () => {
      live = false
    }
  }, [sessionId])
  const memoryBase: MemoryPathBase = isDemo
    ? { home: 'C:\\Users\\linxia', root: 'D:\\pixel-web', windows: true }
    : {
        home: machines.machines.find(m => m.id === machine)?.home ?? null,
        root,
        windows:
          (machine === 'local'
            ? window.pixelsky?.platform
            : machines.machines.find(m => m.id === machine)?.platform) === 'win32',
      }
  const openMemory = async (path: string, action: 'open' | 'reveal'): Promise<void> => {
    if (!sessionId && !isDemo) return
    try {
      if (isDemo) {
        const relative = displayMemoryPath(path, memoryBase).replaceAll('\\', '/')
        if (action === 'open' && relative in demo().files.contents) {
          await openFile({ sessionId: sessionId! }, relative)
          close()
        } else toast(tr('session.ContextWindowButton.demoLocalFile'))
        return
      }
      const ref = { sessionId: sessionId! }
      const relative = action === 'open' ? await workspaceFilePath(ref, path) : null
      if (relative) await openFile(ref, relative)
      else if (machine !== 'local') return toast(tr('session.ContextWindowButton.remoteMemoryFile'))
      else await window.pixelsky!.editor.openMemory(sessionId!, path, action)
      close()
    } catch (e) {
      toast(translateMessage((e as Error).message))
    }
  }
  // 运行中每次新请求都会让明细过期：弹窗开着就用 summary 重新取（不调接口）；空闲时每轮结束引擎已经取过
  const outdated = !diagnostic || !!context?.diagnosticStale
  useEffect(() => {
    if (open && live && !idle && outdated && canInspect) void inspect('summary')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, live, idle, outdated])
  const compact = async (): Promise<void> => {
    if (!canCompact || !sessionId) return
    setBusy('compact')
    setError('')
    try {
      await bridge?.compact(sessionId)
      setConfirm(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <span className="inline-flex shrink-0">
      <button
        ref={trigger}
        type="button"
        data-context-trigger
        aria-label={tr('session.ContextWindowButton.contextWindow')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          context?.compacting
            ? tr('session.ContextWindowButton.compactingContext')
            : percent !== null
              ? tr('session.ContextWindowButton.context', {
                  p0: contextNumber(context?.used),
                  p1: contextNumber(context?.window),
                  p2: percent.toFixed(1),
                })
              : tr('session.ContextWindowButton.viewContextWindow')
        }
        onClick={() => setOpen(v => !v)}
        className={cn(
          'press no-drag inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-meta hover:bg-hover',
          percent !== null && percent >= 80 ? 'text-warn' : 'text-fg-muted',
        )}
      >
        <ContextRing percent={Math.min(100, Math.max(0, percent ?? 0))} size={16} />
        <span data-context-percent className="tabular-nums">
          {context?.compacting
            ? tr('session.ContextWindowButton.compacting')
            : percent === null
              ? tr('session.ContextWindowButton.context2')
              : `${Number(percent.toFixed(1))}%`}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            role="dialog"
            aria-label={tr('session.ContextWindowButton.contextWindowDetails')}
            tabIndex={-1}
            data-context-popover
            // 滚动条的位置一直留着（10px，见 globals.css ::-webkit-scrollbar）：展开明细后出现滚动条时内容不变窄；
            // 右边内边距相应少 10px，看起来左右一样宽（docs/ui/context-window.md §7）
            className="pop-in no-drag fixed z-50 max-h-[calc(100vh-16px)] w-[440px] max-w-[calc(100vw-16px)] [scrollbar-gutter:stable] overflow-y-auto rounded-xl border border-line-card bg-popover py-4 pr-1.5 pl-4 text-ui text-fg shadow-menu outline-none"
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
              e.stopPropagation()
            }}
          >
            <div className="flex items-center gap-2">
              <h2 className="flex-1 text-ui font-medium">{tr('session.ContextWindowButton.contextWindow')}</h2>
              <span className="text-ui text-fg-secondary tabular-nums">
                {context?.stale
                  ? tr('session.ContextWindowButton.waitingForUpdate')
                  : `${contextNumber(context?.used)} / ${contextNumber(context?.window)}${percent === null ? '' : `（${Number(percent.toFixed(1))}%）`}`}
              </span>
              <button
                type="button"
                aria-label={tr('session.ContextWindowButton.closeContextDetails')}
                onClick={close}
                className="rounded-md p-1 text-fg-muted hover:bg-hover"
              >
                <X size={14} />
              </button>
            </div>
            <div
              role="progressbar"
              aria-label={tr('session.ContextWindowButton.contextUsage')}
              aria-valuenow={percent === null ? undefined : Math.min(100, percent)}
              aria-valuemin={0}
              aria-valuemax={100}
              className="my-3 flex h-1.5 w-full overflow-hidden rounded-full bg-subtle"
            >
              {segments.map((segment, i) => (
                <span
                  key={i}
                  title={`${segment.name}：${segment.tokens.toLocaleString('zh-CN')} Token`}
                  className={cn('h-full', segment.color)}
                  style={{ width: `${Math.min(100, Math.max(0, (segment.tokens / (context?.window || 1)) * 100))}%` }}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-meta text-fg-muted">
              <span>
                {context?.compacting
                  ? tr('session.ContextWindowButton.compactingConversation')
                  : context?.stale
                    ? tr('session.ContextWindowButton.dataIsStaleWaiting')
                    : percent !== null && percent >= 80
                      ? tr('session.ContextWindowButton.highContextUsage')
                      : context?.used === null || !context
                        ? tr('session.ContextWindowButton.waitingForFirstRequest')
                        : !context.window
                          ? tr('session.ContextWindowButton.windowCapacityUnavailable')
                          : tr('session.ContextWindowButton.tokensRemaining', {
                              p0: contextNumber(Math.max(0, context.window - context.used)),
                            })}
              </span>
              <button
                type="button"
                disabled={!canCompact}
                title={!canCompact ? reason : tr('session.ContextWindowButton.compactingCallsModelAnd')}
                onClick={() => setConfirm(v => !v)}
                className="inline-flex items-center gap-1 text-accent-fg hover:underline disabled:cursor-default disabled:text-fg-faint disabled:no-underline"
              >
                <Scissors size={13} />
                {tr('session.ContextWindowButton.compactConversation')}
              </button>
            </div>
            {compactLimit !== null && (
              <p className="mt-2 text-label text-fg-muted">
                {tr('session.ContextWindowButton.engineReserve')} {contextNumber(diagnostic!.window - compactLimit)}
                {tr('session.ContextWindowButton.tokensUsableUpTo')} {contextNumber(compactLimit)}
              </p>
            )}
            {confirm && (
              <div className="mt-3 rounded-lg bg-subtle p-3 text-meta">
                <p>{tr('session.ContextWindowButton.compactingCallsModelAnd2')}</p>
                <div className="mt-2 flex justify-end gap-3">
                  <button type="button" onClick={() => setConfirm(false)} className="text-fg-muted">
                    {tr('account.AccountMenu.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={!canCompact}
                    onClick={() => void compact()}
                    className="text-accent-fg disabled:opacity-50"
                  >
                    {tr('session.ContextWindowButton.startCompaction')}
                  </button>
                </div>
              </div>
            )}
            {error && (
              <p role="status" className="mt-2 text-meta text-danger">
                {translateMessage(error)}
              </p>
            )}
            <div className="mt-3 border-t border-line pt-2">
              <button
                type="button"
                aria-expanded={details}
                onClick={() => {
                  setDetails(v => !v)
                  if (!details && canInspect && outdated) void inspect(live ? 'summary' : 'full')
                }}
                className="flex h-8 w-full items-center gap-1 text-left text-ui text-fg-secondary hover:text-fg"
              >
                <ChevronRight size={14} className="disclosure-chevron" data-open={details || undefined} />
                {tr('session.ContextWindowButton.viewDetailedUsage')}
              </button>
              <div className="disclosure" data-open={details || undefined} inert={!details}>
                <div className="-mx-1 px-1">
                  <div className="mt-2 mb-2 flex items-center gap-2 text-label text-fg-muted">
                    <span className="flex-1">
                      {diagnostic
                        ? tr(
                            diagnostic.detail === 'summary'
                              ? 'session.ContextWindowButton.engineSummaryEstimate'
                              : 'session.ContextWindowButton.engineDiagnosticEstimate',
                            { p0: context?.diagnosticStale ? tr('session.ContextWindowButton.refreshNeeded') : '' },
                          )
                        : tr('session.ContextWindowButton.latestMainRequestCount')}
                    </span>
                    <button
                      type="button"
                      disabled={!canRefresh || (busy === 'inspect' && !spinning)}
                      title={
                        !canInspect && !isDemo ? reason : tr('session.ContextWindowButton.engineDiagnosticsMayQuery')
                      }
                      onClick={() => void refresh()}
                      className={cn(
                        'inline-flex items-center gap-1',
                        // 转圈时按钮是禁用的，颜色不变灰
                        spinning
                          ? 'text-accent-fg'
                          : refreshed
                            ? 'text-success'
                            : 'text-accent-fg disabled:text-fg-faint',
                      )}
                    >
                      {refreshed ? (
                        <Check size={12} className="pop-in" />
                      ) : (
                        <RefreshCw
                          size={12}
                          className={spinning || busy === 'inspect' ? 'animate-spin' : undefined}
                          style={{ animationDuration: `${SPIN_MS}ms` }}
                        />
                      )}
                      <span role="status">
                        {spinning || busy === 'inspect'
                          ? tr('session.ContextWindowButton.refreshing')
                          : refreshed
                            ? tr('session.ContextWindowButton.refreshed')
                            : tr('session.ContextWindowButton.refreshDetails')}
                      </span>
                    </button>
                  </div>
                  {diagnostic ? (
                    <>
                      <div className="space-y-1">
                        {diagnostic.categories.map((c, i) => (
                          <NumberRow
                            key={flashKey(`category:${c.name}`) + i}
                            flash={flash.rows.has(`category:${c.name}`)}
                            name={contextLabel(c.name)}
                            value={c.tokens}
                            percent={
                              c.kind !== 'deferred' && diagnostic.window > 0
                                ? (c.tokens / diagnostic.window) * 100
                                : null
                            }
                          />
                        ))}
                      </div>
                      {(['tools', 'memory', 'agents', 'skills'] as const).map(group => (
                        <DetailGroup
                          key={group}
                          title={
                            group === 'tools'
                              ? tr('session.contextData.mcpTools')
                              : group === 'memory'
                                ? tr('session.contextData.memoryFiles')
                                : group === 'agents'
                                  ? tr('session.contextData.agents')
                                  : 'Skills'
                          }
                          rows={diagnostic[group]}
                          row={(row, i) => {
                            const key = `${group}:${row.name}`
                            const flashed = flash.rows.has(key)
                            return group === 'memory' ? (
                              <MemoryRow
                                key={flashKey(key) + i}
                                flash={flashed}
                                row={row}
                                base={memoryBase}
                                reveal={isDemo || machine === 'local'}
                                onOpen={action => void openMemory(row.name, action)}
                              />
                            ) : (
                              <NumberRow key={flashKey(key) + i} flash={flashed} name={row.name} value={row.tokens} />
                            )
                          }}
                        />
                      ))}
                    </>
                  ) : (
                    <>
                      <NumberRow name={tr('session.contextData.uncachedInput')} value={context?.input ?? null} />
                      <NumberRow name={tr('session.contextData.cacheRead')} value={context?.cacheRead ?? null} />
                      <NumberRow name={tr('session.contextData.cacheWrite')} value={context?.cacheWrite ?? null} />
                      <p className="mt-2 text-label text-fg-faint">
                        {tr('session.ContextWindowButton.contentCategoriesAreNot')}
                      </p>
                    </>
                  )}
                  <div className="mt-3 border-t border-line pt-2">
                    <NumberRow
                      name={tr('session.ContextWindowButton.latestOutputExcludedFrom')}
                      value={context?.output ?? null}
                    />
                  </div>
                  <p className="mt-2 text-label text-fg-faint">
                    {diagnostic
                      ? tr(
                          diagnostic.detail === 'summary'
                            ? 'session.ContextWindowButton.summaryEstimateNote'
                            : 'session.ContextWindowButton.diagnosticsEstimateNewlyAdded',
                        )
                      : tr('session.ContextWindowButton.usageIsSumOf')}
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <p className="min-w-0 flex-1 truncate text-label text-fg-faint" title={context?.model ?? ''}>
                {context?.model ?? tr('session.ContextWindowButton.modelNotReportedYet')}
                {context?.observedAt
                  ? tr('session.ContextWindowButton.updated', {
                      p0: new Date(context.observedAt).toLocaleTimeString('zh-CN'),
                    })
                  : ''}
                {isDemo ? tr('session.ContextWindowButton.demoData') : ''}
              </p>
              {/* 跟随输入框当前的执行引擎，未创建会话时也能打开对应详情。 */}
              <button
                type="button"
                data-context-settings
                onClick={() => {
                  setOpen(false)
                  openContextSettings(engine, settings.openSettings)
                }}
                className="shrink-0 text-label text-accent-fg hover:underline"
              >
                {tr('contextWindow.settings')}
              </button>
            </div>
            {nativeAccount && (engine === 'claude' || engine === 'codex') && (
              <AccountUsagePanel engine={engine} sessionId={sessionId} />
            )}
          </div>,
          document.body,
        )}
    </span>
  )
}
function NumberRow({
  name,
  value,
  percent,
  flash,
}: {
  name: string
  value: number | null
  percent?: number | null
  /** 刷新后变了：底色亮一下 */
  flash?: boolean
}) {
  useI18n()
  return (
    <div className={cn('-mx-1 flex items-center gap-3 rounded px-1 py-1 text-meta', flash && 'value-flash')}>
      <span className="min-w-0 flex-1 truncate text-fg-secondary" title={name}>
        {name}
      </span>
      <span className="tabular-nums">{value === null ? '—' : value.toLocaleString('zh-CN')}</span>
      {percent !== undefined && (
        <span className="w-12 text-right text-fg-muted tabular-nums">
          {percent === null ? '—' : `${Number(percent.toFixed(1))}%`}
        </span>
      )}
    </div>
  )
}
/** 记忆文件的一行：点路径打开；悬停时右边出现「在文件夹中显示」。路径截中间，文件名一直看得见 */
function MemoryRow({
  row,
  base,
  reveal,
  flash,
  onOpen,
}: {
  row: ContextDetail
  base: MemoryPathBase
  /** 能不能在文件夹中显示（远程机器上的不行） */
  reveal: boolean
  flash?: boolean
  onOpen: (action: 'open' | 'reveal') => void
}) {
  useI18n()
  const { dir, name } = splitFileName(displayMemoryPath(row.name, base))
  return (
    <div className={cn('group -mx-1 flex items-center gap-1 rounded px-1 text-meta', flash && 'value-flash')}>
      <button
        type="button"
        title={row.name}
        aria-label={tr('session.ContextWindowButton.openMemoryFile', { p0: row.name })}
        onClick={() => onOpen('open')}
        className="flex min-w-0 flex-1 py-1 text-left text-fg-secondary hover:text-accent-fg hover:underline"
      >
        <span className="min-w-0 truncate">{dir}</span>
        <span className="max-w-full shrink-0 truncate">{name}</span>
      </button>
      {reveal && (
        <button
          type="button"
          title={tr('session.ContextWindowButton.revealMemoryFile')}
          aria-label={tr('session.ContextWindowButton.revealMemoryFile')}
          onClick={() => onOpen('reveal')}
          className="rounded p-0.5 text-fg-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
        >
          <FolderOpen size={12} />
        </button>
      )}
      <span className="ml-2 tabular-nums">{row.tokens.toLocaleString('zh-CN')}</span>
    </div>
  )
}
/** 明细里的一组（MCP 工具、记忆文件、子智能体、Skills）：点标题展开 / 收起，带动画 */
function DetailGroup({
  title,
  rows,
  row,
}: {
  title: string
  rows: ContextDetail[]
  row: (row: ContextDetail, index: number) => ReactNode
}) {
  useI18n()
  const [open, setOpen] = useState(false)
  if (!rows.length) return null
  return (
    <div className="mt-2 rounded-md bg-subtle px-2 py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-1 text-left text-meta text-fg-secondary hover:text-fg"
      >
        <ChevronRight size={12} className="disclosure-chevron shrink-0" data-open={open || undefined} />
        {title}（{rows.length}）
      </button>
      <div className="disclosure" data-open={open || undefined} inert={!open}>
        {/* 左右各多 4px：行的底色（刷新后亮一下）不被收起用的 overflow 切掉 */}
        <div className="-mx-1 px-1">{rows.map(row)}</div>
      </div>
    </div>
  )
}
