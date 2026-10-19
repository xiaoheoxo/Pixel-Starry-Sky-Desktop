import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { CornerDownLeft, FolderGit2, Info, RefreshCw, Search, X } from 'lucide-react'
import type { NativeSessionDetail, NativeSessionSummary } from '@pixelsky/protocol'
import { Button, IconButton, Spinner, cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { OPEN_SESSION_EVENT } from '@/features/engine/openRequests'
import { relativeTime } from '@/features/engine/labels'
import {
  cancelNativeImport,
  getEngineState,
  importNativeSession,
  listNativeSessions,
  nativeSessionDetails,
  useEngineState,
  useNativeImportProgress,
} from '@/features/engine/store'
import { isLive } from '@/features/engine/hooks'
import { composerInputFor } from '@/features/session/composerInput/ComposerInput'
import { chooseRow, isGoneError, settingsWhenReady, type ChooseHow, type ChooseOutcome } from './choose'
import {
  filterRows,
  groupRows,
  mergeRows,
  moveSelection,
  needsChoice,
  rowStatus,
  unreadableText,
  type NavKey,
  type ResumeGroups,
  type ResumeRow,
} from './model'
import { RESUME_ENGINE_NAMES, closeResumePicker, type ResumeEngine, type ResumeRequest } from './store'
import { refreshResumeCounts } from './hint'

/** 第二步每批补多少行（对着屏幕上能看到的行逐批补） */
const TAIL_BATCH = 8
const NAV_KEYS: readonly string[] = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']

// ---------------------------------------------------------------------------
// 展示（不带状态，测试直接渲染它）
// ---------------------------------------------------------------------------

export interface PickerViewProps {
  /** 列哪个引擎的会话（标题、空状态、错误、帮助按它换文字） */
  engine: ResumeEngine
  groups: ResumeGroups
  query: string
  selectedId: string | null
  /** 第一步还没回来 */
  loading: boolean
  /** 读不到会话目录 */
  error: string | null
  /** 第二步还在逐批补尾部 */
  reading: boolean
  /** 状态栏的一句话（记录不在了、还开着、没有这个会话……） */
  notice: string | null
  /** 正在导入的行；percent 是大文件的进度，null 为不显示百分比 */
  busy: { id: string; percent: number | null } | null
  /** 点了「我去那边关掉再来」的行：这一行改成「关掉后再按 Enter」 */
  waiting: ReadonlySet<string>
  help: boolean
  inputRef?: Ref<HTMLInputElement>
  projectPath: string | null
  noProject: boolean
  onQuery(value: string): void
  onSelect(id: string): void
  onActivate(row: ResumeRow, how: ChooseHow): void
  onWait(row: ResumeRow): void
  onCancelImport(): void
  /** 重试 / 重新查找：重新列一遍（不用缓存） */
  onRetry(): void
  onHelp(): void
  onClose(): void
}

function StatusChip({ row }: { row: ResumeRow }) {
  const status = rowStatus(row)
  if (!status) return null
  return (
    <span data-resume-status={status} className="shrink-0 rounded bg-warn/10 px-1.5 text-meta text-warn">
      {tr(`resume.live.${status}`)}
    </span>
  )
}

function Row({
  row,
  index,
  selected,
  view,
}: {
  row: ResumeRow
  index: number
  selected: boolean
  view: PickerViewProps
}) {
  const busy = view.busy?.id === row.id
  const waiting = view.waiting.has(row.id)
  const status = rowStatus(row)
  const choice = selected && !view.busy && !waiting && needsChoice(row)
  // 正开着：主按钮是复制一份接着聊；可能还开着：主按钮是直接接着聊，复制放次要位置
  const copyFirst = status === 'terminal' || status === 'other'
  const when = row.activeAt
  return (
    <div
      id={`resume-row-${index}`}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-resume-row={row.id}
      data-resume-index={index}
      data-owned={row.ownerId ? '' : undefined}
      data-live={row.live ?? undefined}
      onMouseEnter={() => view.onSelect(row.id)}
      onClick={() => {
        if (!view.busy && !choice) view.onActivate(row, 'default')
      }}
      className={cn(
        'flex cursor-default flex-col gap-0.5 rounded-lg px-3 py-2 text-left',
        selected ? 'bg-selected' : 'hover:bg-hover',
        row.ownerId && 'opacity-80',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-ui font-medium text-fg">{row.title}</span>
        {row.subdir && (
          <span
            data-resume-subdir
            className="inline-flex shrink-0 items-center gap-1 rounded bg-hover px-1.5 text-meta text-fg-muted"
          >
            <FolderGit2 size={11} strokeWidth={1.5} />
            {row.subdir}
          </span>
        )}
        <span className="min-w-2 flex-1" />
        <span className="shrink-0 text-label text-fg-faint tabular-nums">
          {[row.branch, relativeTime(when)].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className="flex min-h-4 min-w-0 items-center gap-2 text-label text-fg-faint">
        <span className="min-w-0 flex-1 truncate">
          {busy
            ? view.busy?.percent === null || view.busy?.percent === undefined
              ? tr('resume.importing')
              : tr('resume.importingPercent', { percent: view.busy.percent })
            : waiting
              ? tr('resume.closeThereDone')
              : row.ownerId
                ? tr('resume.ownedRow')
                : row.lastPrompt
                  ? tr('resume.last', { text: row.lastPrompt.replace(/\s+/g, ' ').trim() })
                  : ''}
        </span>
        {busy && <Spinner size={12} />}
        <span className="shrink-0">
          {tr(row.source === 'terminal' ? 'resume.source.terminal' : 'resume.source.other')}
        </span>
        <StatusChip row={row} />
        {selected && !busy && !choice && <CornerDownLeft size={13} className="shrink-0 text-fg-faint" />}
      </div>
      {busy && (
        <div className="mt-1 flex items-center gap-2">
          {view.busy?.percent !== null && view.busy?.percent !== undefined && (
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-hover">
              <div className="h-full bg-accent" style={{ width: `${view.busy.percent}%` }} />
            </div>
          )}
          <Button
            variant="ghost"
            data-resume-action="cancel"
            className="h-6 px-2 text-meta"
            onClick={e => {
              e.stopPropagation()
              view.onCancelImport()
            }}
          >
            {tr('resume.cancel')}
          </Button>
        </div>
      )}
      {choice && (
        <div data-resume-choice className="mt-1.5 flex flex-col gap-1.5">
          <p className="text-meta text-fg-muted">
            {tr(
              status === 'maybe' && view.engine === 'codex'
                ? 'resume.liveNote.maybe.codex'
                : `resume.liveNote.${status!}`,
            )}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {copyFirst ? (
              <>
                <Button
                  variant="primary"
                  data-resume-action="copy"
                  className="h-7 px-2.5 text-meta"
                  onClick={e => {
                    e.stopPropagation()
                    view.onActivate(row, 'copy')
                  }}
                >
                  {tr('resume.copy')}
                </Button>
                <Button
                  variant="ghost"
                  data-resume-action="close-there"
                  className="h-7 px-2.5 text-meta"
                  onClick={e => {
                    e.stopPropagation()
                    view.onWait(row)
                  }}
                >
                  {tr('resume.closeThere')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  data-resume-action="inplace"
                  className="h-7 px-2.5 text-meta"
                  onClick={e => {
                    e.stopPropagation()
                    view.onActivate(row, 'inplace')
                  }}
                >
                  {tr('resume.inplace')}
                </Button>
                <Button
                  variant="ghost"
                  data-resume-action="copy"
                  className="h-7 px-2.5 text-meta"
                  onClick={e => {
                    e.stopPropagation()
                    view.onActivate(row, 'copy')
                  }}
                >
                  {tr('resume.copy')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const HELP_KEYS = {
  claude: [
    'resume.help.switch',
    'resume.help.history',
    'resume.help.live',
    'resume.help.newer',
    'resume.help.context',
    'resume.help.engine',
  ],
  codex: [
    'resume.help.switch',
    'resume.help.history',
    'resume.help.codex.live',
    'resume.help.newer',
    'resume.help.codex.context',
    'resume.help.codex.idle',
    'resume.help.codex.revert',
    'resume.help.codex.legacy',
    'resume.help.codex.engine',
  ],
} as const

export function ResumePickerView(view: PickerViewProps) {
  useI18n()
  const { groups } = view
  const total = groups.all.length
  const empty = !view.loading && !view.error && total === 0
  const help = HELP_KEYS[view.engine]
  const engineName = RESUME_ENGINE_NAMES[view.engine]
  const indexOf = (row: ResumeRow): number => groups.all.indexOf(row)
  return (
    <div
      data-resume-picker
      role="dialog"
      aria-modal="true"
      aria-labelledby="resume-title"
      className="pop-in flex max-h-[80vh] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-line-card bg-popover shadow-menu"
    >
      <header className="flex items-center gap-3 px-4 pt-3 pb-1.5">
        <h2
          id="resume-title"
          className="flex min-w-0 flex-1 items-baseline gap-3 text-ui font-medium text-fg-secondary"
        >
          <span className="shrink-0">{tr('resume.title', { engine: engineName })}</span>
          {view.projectPath && (
            <span className="min-w-0 truncate text-label font-normal text-fg-faint" title={view.projectPath}>
              {view.projectPath}
            </span>
          )}
        </h2>
        {view.reading && (
          <span data-resume-reading className="inline-flex items-center gap-1.5 text-label text-fg-faint">
            <Spinner size={11} />
            {tr('resume.reading')}
          </span>
        )}
        <IconButton
          icon={RefreshCw}
          label={tr('resume.hint.recheck')}
          data-resume-action="recheck"
          size={24}
          iconSize={14}
          disabled={view.noProject || view.loading}
          onClick={view.onRetry}
        />
        <IconButton
          icon={Info}
          label={tr('resume.help')}
          size={24}
          iconSize={14}
          active={view.help}
          onClick={view.onHelp}
        />
        <IconButton icon={X} label={tr('resume.close')} size={24} iconSize={14} onClick={view.onClose} />
      </header>
      {view.help && (
        <ul
          data-resume-help
          className="mx-4 mb-1 flex flex-col gap-1 rounded-lg bg-subtle px-3 py-2 text-meta text-fg-muted"
        >
          {help.map(key => (
            <li key={key}>{tr(key)}</li>
          ))}
        </ul>
      )}
      <div className="mx-4 flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 focus-within:border-accent-line">
        <Search size={16} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
        <input
          type="search"
          ref={view.inputRef}
          data-resume-search
          value={view.query}
          maxLength={200}
          placeholder={tr('resume.search')}
          aria-label={tr('resume.searchLabel')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded
          aria-controls="resume-list"
          aria-activedescendant={
            view.selectedId && total ? `resume-row-${groups.all.findIndex(r => r.id === view.selectedId)}` : undefined
          }
          className="h-11 min-w-0 flex-1 bg-transparent text-prose text-fg outline-none placeholder:text-fg-faint"
          onChange={e => view.onQuery(e.target.value)}
        />
        {view.loading && <Spinner size={14} />}
      </div>
      <div
        id="resume-list"
        role="listbox"
        aria-label={tr('resume.list')}
        aria-busy={view.loading || view.reading}
        className="mt-2 min-h-36 min-w-0 flex-1 overflow-y-auto border-t border-line-subtle p-2"
      >
        {groups.free.map(row => (
          <Row key={row.id} row={row} index={indexOf(row)} selected={row.id === view.selectedId} view={view} />
        ))}
        {groups.owned.length > 0 && (
          <div
            data-resume-group="owned"
            role="presentation"
            className="mt-2 mb-1 flex items-center gap-2 px-3 text-label text-fg-faint"
          >
            <span className="h-px flex-1 bg-line-subtle" />
            <span>{tr('resume.owned', { n: groups.owned.length })}</span>
            <span className="h-px flex-1 bg-line-subtle" />
          </div>
        )}
        {groups.owned.map(row => (
          <Row key={row.id} row={row} index={indexOf(row)} selected={row.id === view.selectedId} view={view} />
        ))}
        {view.noProject && (
          <div role="status" className="px-4 py-9 text-center text-ui text-fg-muted">
            {tr('resume.noProject')}
          </div>
        )}
        {!view.noProject && view.loading && total === 0 && (
          <div role="status" className="px-4 py-9 text-center text-ui text-fg-muted">
            {tr('resume.loading')}
          </div>
        )}
        {view.error && (
          <div
            role="alert"
            data-resume-error
            className="flex flex-col items-center gap-3 px-4 py-9 text-center text-ui text-fg-muted"
          >
            <span>{unreadableText(view.engine, view.error)}</span>
            <Button data-resume-action="retry" onClick={view.onRetry}>
              {tr('resume.retry')}
            </Button>
          </div>
        )}
        {empty && !view.noProject && (
          <div
            role="status"
            data-resume-empty
            className="flex flex-col items-center gap-3 px-4 py-9 text-center text-ui text-fg-muted"
          >
            <span>{view.query.trim() ? tr('resume.noMatch') : tr('resume.empty', { engine: engineName })}</span>
            {!view.query.trim() && (
              <Button data-resume-action="recheck-empty" onClick={view.onRetry}>
                {tr('resume.hint.recheck')}
              </Button>
            )}
          </div>
        )}
      </div>
      <footer className="flex items-center gap-3 border-t border-line-subtle px-4 py-2.5 text-label text-fg-faint">
        <span role="status" data-resume-notice className={cn('min-w-0 flex-1 truncate', view.notice && 'text-warn')}>
          {view.notice ?? tr('resume.footer')}
        </span>
        <span>{tr('resume.keySelect')}</span>
        <span>{tr('resume.keyOpen')}</span>
        <span>{tr('resume.keyClose')}</span>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 带状态的选择框
// ---------------------------------------------------------------------------

/** 等新对话出现在会话列表里再打开（宿主广播会话列表可能比导入的返回晚一点） */
async function waitForSession(id: string): Promise<void> {
  if (!isLive) return
  for (let i = 0; i < 40 && !getEngineState().sessions.some(s => s.record.id === id); i++)
    await new Promise(r => setTimeout(r, 50))
}

/** 新对话的输入框要等标签页挂上才有，逐帧试几次 */
function focusNewComposer(id: string, left = 30): void {
  const key = isLive ? id : `demo:${id}`
  requestAnimationFrame(() => {
    const target = composerInputFor(key)
    if (target) target.focusEnd()
    else if (left > 0) focusNewComposer(id, left - 1)
  })
}

export function ResumePicker({ request }: { request: ResumeRequest }) {
  useI18n()
  const projectId = request.projectId
  const engine = request.engine
  const project = useEngineState(s => s.projects.find(p => p.id === projectId) ?? null)
  const [rows, setRows] = useState<NativeSessionSummary[] | null>(null)
  const [details, setDetails] = useState<ReadonlyMap<string, NativeSessionDetail>>(() => new Map())
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState(request.query ?? '')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<{ id: string; token: string } | null>(null)
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set())
  const [help, setHelp] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement | null>(null)
  const busyRef = useRef<typeof busy>(null)
  busyRef.current = busy
  const progress = useNativeImportProgress(busy?.token ?? null)
  const requested = useRef(new Set<string>())
  const handledId = useRef(false)

  const merged = useMemo(() => mergeRows(rows ?? [], details), [rows, details])
  const groups = useMemo(() => groupRows(filterRows(merged, query)), [merged, query])
  const selected = groups.all.find(r => r.id === selectedId) ?? groups.all[0] ?? null

  // 第一步：列表（只读头部，很快）
  useEffect(() => {
    if (!projectId) return
    let dead = false
    setError(null)
    requested.current = new Set()
    listNativeSessions(projectId, { engine, subfolders: true })
      .then(list => !dead && setRows(list))
      .catch((e: unknown) => !dead && (setRows([]), setError((e as Error).message)))
    return () => {
      dead = true
    }
  }, [projectId, attempt, engine])

  // 第二步：按显示顺序逐批补尾部（最后一句、标题、模型）；补上时行不跳位（排序按修改时间）
  useEffect(() => {
    if (!projectId || !rows?.length) return
    let dead = false
    const order = groupRows(mergeRows(rows, new Map())).all.map(r => r.id)
    void (async () => {
      setReading(true)
      for (let i = 0; i < order.length && !dead; i += TAIL_BATCH) {
        const ids = order.slice(i, i + TAIL_BATCH).filter(id => !requested.current.has(id))
        if (!ids.length) continue
        ids.forEach(id => requested.current.add(id))
        const got = await nativeSessionDetails(projectId, ids, engine).catch(() => [] as NativeSessionDetail[])
        if (dead) return
        setDetails(prev => new Map([...prev, ...got.map(d => [d.id, d] as const)]))
      }
      if (!dead) setReading(false)
    })()
    return () => {
      dead = true
    }
  }, [projectId, rows, engine])

  // 关掉选择框时还没读完的导入取消，不建对话
  useEffect(
    () => () => {
      const b = busyRef.current
      if (b) void cancelNativeImport(b.token).catch(() => undefined)
    },
    [],
  )

  const openNew = async (sessionId: string): Promise<void> => {
    await waitForSession(sessionId)
    window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId } }))
    request.onOpened?.()
    closeResumePicker({ restoreFocus: false })
    focusNewComposer(sessionId)
  }

  const handle = async (outcome: ChooseOutcome, row: ResumeRow): Promise<void> => {
    if (outcome.kind === 'live') {
      // 列表之后才被开着：这一行改成正开着，展开两个按钮
      setRows(list => list?.map(r => (r.id === row.id ? { ...r, live: outcome.live } : r)) ?? list)
      setWaiting(w => new Set([...w].filter(id => id !== row.id)))
      setNotice(tr('resume.stillLive'))
      return
    }
    if (outcome.kind === 'owned') {
      window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId: outcome.sessionId } }))
      request.onOpened?.()
      closeResumePicker({ restoreFocus: false })
      return
    }
    await openNew(outcome.sessionId)
  }

  const activate = async (row: ResumeRow, how: ChooseHow = 'default'): Promise<void> => {
    if (busyRef.current || !projectId) return
    // 打开之后执行者被换了（比如在别的窗口）：设置是按新执行者算的，不导入，请重新打开
    const executor = request.executorNow?.()
    if (executor && executor !== engine) return void setNotice(tr('resume.executorChanged'))
    // 点过「我去那边关掉再来」的行：再按 Enter 重新查一次，不开着了就原地导入，还开着就照旧给两个按钮
    if (how === 'default' && waiting.has(row.id)) how = 'inplace'
    if (row.ownerId) return void handle({ kind: 'owned', sessionId: row.ownerId }, row)
    const token = crypto.randomUUID()
    setBusy({ id: row.id, token })
    busyRef.current = { id: row.id, token }
    setNotice(null)
    try {
      const outcome = await chooseRow(row, how, {
        token,
        importSession: (id, opts) => importNativeSession(projectId, id, { ...opts, engine }),
        modelOf: async id => (await nativeSessionDetails(projectId, [id], engine))[0]?.model ?? null,
        settingsFor: model => settingsWhenReady(request.settingsFor, model),
      })
      if (busyRef.current?.token !== token) return
      await handle(outcome, row)
    } catch (e) {
      // 点了「取消」：busyRef 已经清掉了，不当错误
      if (busyRef.current?.token !== token) return
      const message = (e as Error).message
      if (isGoneError(message)) {
        setRows(list => list?.filter(r => r.id !== row.id) ?? list)
        setNotice(tr('resume.gone'))
      } else setNotice(translateMessage(message))
    } finally {
      if (busyRef.current?.token === token) {
        busyRef.current = null
        setBusy(null)
      }
    }
  }

  // /resume <完整 uuid>：不弹列表，直接走选中之后的流程（照样查占用和开着）
  useEffect(() => {
    if (!request.id || !rows || handledId.current) return
    handledId.current = true
    const row = merged.find(r => r.id.toLowerCase() === request.id)
    if (row) void activate(row, 'default')
    else setNotice(tr('resume.notInFolder'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => {
    if (!selected) return
    dialog.current
      ?.querySelector<HTMLElement>(`[data-resume-row="${selected.id}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeResumePicker()
    } else if (
      NAV_KEYS.includes(e.key) &&
      groups.all.length &&
      (e.target === input.current || e.key.startsWith('Arrow'))
    ) {
      // Home / End 在输入框里要用来移动光标，只有 PageUp / PageDown 和上下键抢
      if ((e.key === 'Home' || e.key === 'End') && e.target === input.current && !e.ctrlKey) return
      e.preventDefault()
      const from = Math.max(
        0,
        groups.all.findIndex(r => r.id === selected?.id),
      )
      setSelectedId(groups.all[moveSelection(from, e.key as NavKey, groups.all.length)].id)
    } else if (e.key === 'Enter' && e.target === input.current && selected && !busyRef.current) {
      e.preventDefault()
      void activate(selected, 'default')
    } else if (e.key === 'Tab') {
      const focusable = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>('input,select,button:not(:disabled),[tabindex="0"]') ?? [],
      ).filter(el => el.getBoundingClientRect().width > 0)
      const first = focusable[0],
        last = focusable.at(-1)
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
  }

  const percent =
    progress && progress.total > 0 ? Math.min(100, Math.floor((progress.read / progress.total) * 100)) : null
  return createPortal(
    <div
      className="fade-in no-drag fixed inset-0 z-[70] flex items-start justify-center bg-scrim px-4 pt-[min(10vh,80px)]"
      onMouseDown={e => {
        if (e.target === e.currentTarget) closeResumePicker()
      }}
    >
      <div ref={dialog} className="contents" onKeyDown={onKeyDown}>
        <ResumePickerView
          engine={engine}
          groups={groups}
          query={query}
          selectedId={selected?.id ?? null}
          loading={!!projectId && rows === null}
          error={error}
          reading={reading}
          notice={notice}
          busy={busy ? { id: busy.id, percent } : null}
          waiting={waiting}
          help={help}
          inputRef={input}
          projectPath={project?.path ?? null}
          noProject={!projectId}
          onQuery={value => {
            setQuery(value)
            setSelectedId(null)
            setNotice(null)
          }}
          onSelect={setSelectedId}
          onActivate={(row, how) => void activate(row, how)}
          onWait={row => setWaiting(w => new Set(w).add(row.id))}
          onCancelImport={() => {
            const b = busyRef.current
            busyRef.current = null
            setBusy(null)
            if (b) void cancelNativeImport(b.token).catch(() => undefined)
          }}
          onRetry={() => {
            setRows(null)
            setDetails(new Map())
            setAttempt(n => n + 1)
            // 导入提示、空状态的计数跟着更新
            if (projectId && isLive) void refreshResumeCounts(projectId)
          }}
          onHelp={() => setHelp(v => !v)}
          onClose={() => closeResumePicker()}
        />
      </div>
    </div>,
    document.body,
  )
}
