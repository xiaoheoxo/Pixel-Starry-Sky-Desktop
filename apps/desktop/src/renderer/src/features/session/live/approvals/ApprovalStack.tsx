// 等你决定的审批（docs/ui/approval-stack.md）：输入框上方，最多占对话区一半。
// 1 项是完整的单张卡；2 项以上的命令、改文件、工具合并成一张列表卡；提问、计划、要填表单的单独成卡
import { scrollInPane } from '@/ui/scrollInPane'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../../i18n/core'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  FilePen,
  Globe,
  Hand,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { AlwaysScope, ApprovalDecision, ApprovalRequest } from '@pixelsky/protocol'
import { Button, DiffStat, Popover, Spinner, cn } from '@/ui'
import { settledResizeObserver } from '@/features/panes/motion'
import { FullAccessConfirm } from '../../FullAccessConfirm'
import { ApprovalBody, ApprovalCard, SCOPE_INFO } from '../ApprovalCard'
import {
  allowAllDecisions,
  allowOnce,
  alwaysForGroup,
  answerInOrder,
  approvalSummary,
  commonScopes,
  decisionResult,
  denyOnce,
  isSolo,
  layoutApprovals,
  toolLabel,
  type ApprovalEntry,
  type ApprovalSummary,
} from './model'
import { selectApprovalItem, useApprovalLocate } from './focus'

/** 处理掉的一行留多久（变灰打勾） */
const GHOST_MS = 1000
/** 新来的一行标「新」多久 */
const FRESH_MS = 3000
/** 审批区最矮：标题 + 两行 */
const MIN_HEIGHT = 150

type Answer = (request: ApprovalRequest, decision: ApprovalDecision) => Promise<unknown> | void

/** 审批区最高占对话区（整个会话窗格）的一半 */
function useHalfHeight(
  bounds: RefObject<HTMLElement | null>,
  box: RefObject<HTMLElement | null>,
  active: boolean,
): number | undefined {
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    // 第一次挂载时外层的 ref 可能还没接上：按自己往上找会话窗格
    const el = bounds.current ?? box.current?.closest<HTMLElement>('.conversation-view') ?? null
    if (!el || !active) return
    const update = (): void => setHeight(Math.max(MIN_HEIGHT, Math.floor(el.clientHeight / 2)))
    update()
    const observer = settledResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [bounds, box, active])
  return height
}

/** 变成 false 之后再保持 true 一会儿（列表里最后几项处理掉时，留着显示「已允许」） */
function useLinger(value: boolean, ms: number): boolean {
  const [linger, setLinger] = useState(value)
  useEffect(() => {
    if (value) return setLinger(true)
    const t = window.setTimeout(() => setLinger(false), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return value || linger
}

export function ApprovalStack({
  sessionId,
  pending,
  cwd,
  bounds,
  onAnswer,
  onEscape,
}: {
  sessionId: string
  pending: readonly ApprovalRequest[]
  cwd: string | null
  /** 会话窗格：按它的高度限高，Alt+↑ 在它里面生效 */
  bounds: RefObject<HTMLElement | null>
  onAnswer: Answer
  /** 列表里按 Esc：回到输入框 */
  onEscape: () => void
}) {
  useI18n()
  const box = useRef<HTMLDivElement>(null)
  const solo = pending.filter(isSolo)
  const list = pending.filter(r => !isSolo(r))
  const listShown = useLinger(list.length > 0, GHOST_MS + 100)
  const maxHeight = useHalfHeight(bounds, box, pending.length > 0 || listShown)
  const [moreOpen, setMoreOpen] = useState(false)
  const showList = solo.length === 0 || moreOpen

  // 输入框里按 Alt+↑ 进到审批（列表或单张卡的第一个按钮）
  useEffect(() => {
    const root = bounds.current
    if (!root || pending.length === 0) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (!e.altKey || e.key !== 'ArrowUp' || !(e.target as HTMLElement | null)?.closest?.('.composer-card')) return
      const target =
        box.current?.querySelector<HTMLElement>('[data-approval-focus]') ??
        box.current?.querySelector<HTMLElement>('[data-approval-card] button:not(:disabled)')
      if (!target) return
      e.preventDefault()
      target.focus()
    }
    root.addEventListener('keydown', onKey, true)
    return () => root.removeEventListener('keydown', onKey, true)
  }, [bounds, pending.length])

  // 对话里点了「等你决定」：收起的列表先展开，单张卡滚到眼前
  const locate = useApprovalLocate(sessionId)
  useEffect(() => {
    if (!locate) return
    if (list.some(r => r.requestId === locate.requestId)) setMoreOpen(true)
    requestAnimationFrame(() => {
      const card = box.current?.querySelector<HTMLElement>(
        `[data-approval-card][data-approval-request="${locate.requestId}"]`,
      )
      if (!card) return
      scrollInPane(card, 'nearest')
      card.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    })
    // 只在点的时候跳
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate?.token])

  if (pending.length === 0 && !listShown) return null
  return (
    <div
      ref={box}
      data-approvals
      className="mb-3 flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain"
      style={{ maxHeight }}
    >
      {solo.map(r => (
        <ApprovalCard key={r.requestId} request={r} onAnswer={d => onAnswer(r, d)} onEscape={onEscape} />
      ))}
      {listShown &&
        (showList ? (
          <ApprovalList
            sessionId={sessionId}
            requests={list}
            cwd={cwd}
            onAnswer={onAnswer}
            onEscape={onEscape}
            onCollapse={solo.length > 0 ? () => setMoreOpen(false) : undefined}
          />
        ) : (
          <MoreBar requests={list} cwd={cwd} onAnswer={onAnswer} onExpand={() => setMoreOpen(true)} />
        ))}
    </div>
  )
}

/** 列表的一句话：fastctx · grep × 3、git push…（收起时、对话里用） */
function entryText(entry: ApprovalEntry, cwd: string | null): string {
  if (entry.kind === 'group') return `${entry.label} × ${entry.requests.length}`
  const s = approvalSummary(entry.request, cwd)
  return s.label ? `${s.label} ${s.text}`.trim() : s.text
}

/** 有提问或计划在上面时，其余的收成一行 */
function MoreBar({
  requests,
  cwd,
  onAnswer,
  onExpand,
}: {
  requests: readonly ApprovalRequest[]
  cwd: string | null
  onAnswer: Answer
  onExpand: () => void
}) {
  useI18n()
  const [busy, setBusy] = useState(false)
  const what = layoutApprovals(requests)
    .map(e => entryText(e, cwd))
    .join(tr('approvals.listSep'))
  const allowable = requests.some(r => allowOnce(r))
  return (
    <div
      data-approval-more
      className="flex shrink-0 items-center gap-2 rounded-xl border border-line-strong bg-surface py-1.5 pr-2 pl-4 text-list shadow-menu"
    >
      <Hand size={15} strokeWidth={1.5} className="shrink-0 text-fg-secondary" />
      <span className="min-w-0 flex-1 truncate text-fg-muted" title={what}>
        {tr('approvals.more', { n: requests.length, what })}
      </span>
      <Button variant="ghost" className="h-7 px-2 text-meta" onClick={onExpand}>
        {tr('approvals.expand')}
        <ChevronDown size={13} strokeWidth={1.75} />
      </Button>
      {allowable && (
        <Button
          variant="primary"
          className="h-7 px-2.5 text-meta"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void answerInOrder(requests, allowOnce, onAnswer).finally(() => setBusy(false))
          }}
        >
          {tr('approvals.allowAll')}
        </Button>
      )}
    </div>
  )
}

type RowState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'queued' }
  | { kind: 'done'; result: 'allow' | 'deny' | 'gone' }
  | { kind: 'failed'; message: string }

const KIND_ICON: Record<'command' | 'file_change' | 'tool', LucideIcon> = {
  command: SquareTerminal,
  file_change: FilePen,
  tool: Wrench,
}
const iconFor = (r: ApprovalRequest): LucideIcon =>
  r.kind === 'tool' && (r.toolName === 'WebFetch' || r.toolName === 'WebSearch')
    ? Globe
    : (KIND_ICON[r.kind as keyof typeof KIND_ICON] ?? Wrench)

const addTo = <T,>(set: ReadonlySet<T>, ...items: T[]): Set<T> => new Set([...set, ...items])
const removeFrom = <T,>(set: ReadonlySet<T>, ...items: T[]): Set<T> => {
  const next = new Set(set)
  for (const item of items) next.delete(item)
  return next
}

/** 2 项以上合并成的列表卡；只剩 1 项（且没有刚处理掉的、没发出去的）时变回单张卡 */
export function ApprovalList({
  sessionId,
  requests,
  cwd,
  onAnswer,
  onEscape,
  onCollapse,
}: {
  sessionId: string
  requests: readonly ApprovalRequest[]
  cwd: string | null
  onAnswer: Answer
  onEscape: () => void
  /** 有提问在上面时可以收起成一行 */
  onCollapse?: () => void
}) {
  useI18n()
  const listRef = useRef<HTMLDivElement>(null)
  const pendingById = useMemo(() => new Map(requests.map(r => [r.requestId, r])), [requests])

  // 处理掉的行留一会儿（变灰打勾）：这里点的写允许 / 拒绝，别处处理的（超时、手机上点的）写已处理。
  // 在渲染时就记下哪一项什么时候不在了，按时间算还留不留；不用等 effect，否则最后几项一起处理掉时来不及留
  const [doneHere, setDoneHere] = useState<ReadonlyMap<string, 'allow' | 'deny'>>(new Map())
  const known = useRef(new Map<string, ApprovalRequest>())
  const goneAt = useRef(new Map<string, number>())
  const now = Date.now()
  for (const r of requests) {
    known.current.set(r.requestId, r)
    goneAt.current.delete(r.requestId)
  }
  for (const id of known.current.keys())
    if (!pendingById.has(id) && !goneAt.current.has(id)) goneAt.current.set(id, now)
  for (const [id, at] of goneAt.current)
    if (now - at >= GHOST_MS) {
      known.current.delete(id)
      goneAt.current.delete(id)
    }
  const ghostIds = new Set(goneAt.current.keys())
  // 有留着的行时，到点再刷新一次把它们拿掉
  const [, refresh] = useState(0)
  useEffect(() => {
    if (ghostIds.size === 0) return
    const t = window.setTimeout(() => refresh(n => n + 1), GHOST_MS + 30)
    return () => window.clearTimeout(t)
  })
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach(t => window.clearTimeout(t)), [])

  // 顺序：第一次出现的先后；新来的加到末尾
  const shown = [...known.current.values()]

  // 新来的一行：底色闪一下，标「新」几秒
  const initial = useRef(new Set(requests.map(r => r.requestId)))
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const added = requests.map(r => r.requestId).filter(id => !initial.current.has(id))
    if (added.length === 0) return
    for (const id of added) initial.current.add(id)
    setFresh(f => addTo(f, ...added))
    timers.current.push(window.setTimeout(() => setFresh(f => removeFrom(f, ...added)), FRESH_MS))
  }, [requests])

  const [sending, setSending] = useState<ReadonlySet<string>>(new Set())
  const [queued, setQueued] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlyMap<string, { message: string; decision: ApprovalDecision }>>(new Map())
  const [batch, setBatch] = useState<{ kind: 'allow' | 'deny'; total: number; done: number } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmingAll, setConfirmingAll] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const stateOf = (id: string): RowState => {
    if (ghostIds.has(id)) return { kind: 'done', result: doneHere.get(id) ?? 'gone' }
    const done = doneHere.get(id)
    if (done) return { kind: 'done', result: done }
    if (sending.has(id)) return { kind: 'sending' }
    if (queued.has(id)) return { kind: 'queued' }
    const f = failed.get(id)
    if (f) return { kind: 'failed', message: f.message }
    return { kind: 'idle' }
  }

  const markSent = (r: ApprovalRequest, d: ApprovalDecision): void => {
    setDoneHere(m => new Map(m).set(r.requestId, decisionResult(d)))
    setFailed(m => {
      if (!m.has(r.requestId)) return m
      const next = new Map(m)
      next.delete(r.requestId)
      return next
    })
  }

  const run = async (
    targets: readonly ApprovalRequest[],
    decide: (r: ApprovalRequest, i: number) => ApprovalDecision | null,
    kind: 'allow' | 'deny' | null,
  ): Promise<void> => {
    const live = targets.filter(r => pendingById.has(r.requestId) && !doneHere.has(r.requestId))
    const total = live.filter(r => decide(r, 0) !== null).length
    if (total === 0) return
    if (kind) setBatch({ kind, total, done: 0 })
    setQueued(q => addTo(q, ...live.filter(r => decide(r, 0) !== null).map(r => r.requestId)))
    const decisions = new Map<string, ApprovalDecision>()
    const result = await answerInOrder(
      live,
      (r, i) => {
        const d = decide(r, i)
        if (d) decisions.set(r.requestId, d)
        return d
      },
      (r, d) => onAnswer(r, d),
      (id, state) => {
        setQueued(q => removeFrom(q, id))
        if (state === 'sending') setSending(s => addTo(s, id))
        else setSending(s => removeFrom(s, id))
        if (state === 'sent') {
          const r = pendingById.get(id)
          const d = decisions.get(id)
          if (r && d) markSent(r, d)
          if (kind) setBatch(b => b && { ...b, done: b.done + 1 })
        }
      },
    )
    if (result.failed.length)
      setFailed(m => {
        const next = new Map(m)
        for (const f of result.failed) next.set(f.requestId, { message: f.message, decision: f.decision })
        return next
      })
    if (kind) setBatch(null)
  }

  const answerOne = (r: ApprovalRequest, d: ApprovalDecision): void => void run([r], () => d, null)

  // 对话里点了「等你决定」：选中、展开、滚到眼前
  const locate = useApprovalLocate(sessionId)
  useEffect(() => {
    if (!locate || !pendingById.has(locate.requestId)) return
    setSelected(locate.requestId)
    setExpanded(locate.requestId)
    requestAnimationFrame(() => {
      scrollInPane(listRef.current?.querySelector(`[data-approval-row="${locate.requestId}"]`), 'nearest')
      listRef.current?.focus({ preventScroll: true })
    })
    // 只在点的时候跳
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate?.token])

  // 选中的一行：对话里对应的工具行轻微高亮
  const selectedItem = selected ? (pendingById.get(selected)?.itemId ?? null) : null
  useEffect(() => {
    selectApprovalItem(sessionId, selectedItem)
  }, [sessionId, selectedItem])
  useEffect(() => () => selectApprovalItem(sessionId, null), [sessionId])

  const live = requests.filter(r => !doneHere.has(r.requestId))
  const single =
    live.length === 1 && shown.length === 1 && failed.size === 0 && !batch && sending.size === 0 && queued.size === 0
  if (single) return <ApprovalCard request={live[0]} onAnswer={d => onAnswer(live[0], d)} onEscape={onEscape} />

  if (shown.length === 0) return null
  const entries = layoutApprovals(shown)
  const flatIds = entries.flatMap(e => (e.kind === 'row' ? [e.request.requestId] : e.requests.map(r => r.requestId)))
  const selectable = flatIds.filter(id => pendingById.has(id))
  const busy = !!batch
  const skipAllow = live.filter(r => r.canAllow === false).length
  const allowable = live.length - skipAllow
  const deniable = live.some(r => denyOnce(r))
  const canAllowAll = live.some(r => r.canAllowAll)
  const failedLive = [...failed.keys()].filter(id => pendingById.has(id))
  const allFailed = failedLive.length > 0 && failedLive.length === live.length

  const move = (delta: number): void => {
    if (selectable.length === 0) return
    const at = selected ? selectable.indexOf(selected) : -1
    const next = selectable[Math.max(0, Math.min(selectable.length - 1, at + delta))] ?? selectable[0]
    setSelected(next)
    scrollInPane(listRef.current?.querySelector(`[data-approval-row="${next}"]`), 'nearest')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing) return
    const current = selected ? pendingById.get(selected) : undefined
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.repeat) {
      // 带 Shift 的是单张卡片的「始终允许」，这里不当成允许一次；按住不放的重复不算
      e.preventDefault()
      const d = current && allowOnce(current)
      if (current && d && stateOf(current.requestId).kind === 'idle') answerOne(current, d)
    } else if (e.key === 'Backspace' && (e.ctrlKey || e.metaKey) && !e.repeat) {
      e.preventDefault()
      const d = current && denyOnce(current)
      if (current && d && stateOf(current.requestId).kind === 'idle') answerOne(current, d)
    } else if (e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault()
      if (current) setExpanded(x => (x === current.requestId ? null : current.requestId))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onEscape()
    }
  }

  const allowLabel = batch
    ? tr(batch.kind === 'allow' ? 'approvals.allowing' : 'approvals.denying', { done: batch.done, total: batch.total })
    : skipAllow > 0
      ? tr('approvals.allowAllSkip', { n: skipAllow })
      : tr('approvals.allowAll')

  const rowFor = (r: ApprovalRequest, inGroup: boolean): ReactNode => (
    <ApprovalRow
      key={r.requestId}
      request={r}
      summary={approvalSummary(r, cwd)}
      inGroup={inGroup}
      state={stateOf(r.requestId)}
      expanded={expanded === r.requestId}
      selected={selected === r.requestId}
      fresh={fresh.has(r.requestId)}
      disabled={busy}
      onToggle={() => {
        setSelected(r.requestId)
        setExpanded(x => (x === r.requestId ? null : r.requestId))
      }}
      onAnswer={d => answerOne(r, d)}
    />
  )

  return (
    <section
      data-approval-list
      aria-label={tr('approvals.list')}
      className="@container pop-in flex min-h-0 shrink flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-menu"
    >
      <header className="flex shrink-0 items-center gap-2 py-2 pr-2 pl-4 text-ui font-medium text-fg">
        {allFailed ? (
          <CircleAlert size={16} strokeWidth={1.5} className="shrink-0 text-danger" />
        ) : live.length === 0 ? (
          <Check size={16} strokeWidth={1.75} className="shrink-0 text-accent-fg" />
        ) : (
          <Hand size={16} strokeWidth={1.5} className="shrink-0 text-fg-secondary" />
        )}
        <span className="min-w-0 flex-1 truncate" aria-live="polite">
          {allFailed
            ? tr('approvals.failed', { n: failedLive.length })
            : live.length === 0
              ? tr('approvals.handled')
              : tr('approvals.title', { n: live.length })}
          {!allFailed && failedLive.length > 0 && (
            <span className="ml-1.5 text-meta font-normal text-danger">
              {tr('approvals.failed', { n: failedLive.length })}
            </span>
          )}
        </span>
        {failedLive.length > 0 && (
          <Button
            variant={allFailed ? 'primary' : 'outline'}
            className="h-7 px-2.5 text-meta"
            disabled={busy}
            data-approval-retry
            onClick={() =>
              void run(
                failedLive.map(id => pendingById.get(id)!),
                r => failed.get(r.requestId)?.decision ?? null,
                null,
              )
            }
          >
            {tr('approvals.retry')}
          </Button>
        )}
        {!allFailed && live.length > 0 && (
          <>
            {deniable && (
              <Button
                variant="outline"
                className="h-7 px-2.5 text-meta @max-[30rem]:hidden"
                disabled={busy}
                data-approval-deny-all
                onClick={() => void run(live, denyOnce, 'deny')}
              >
                {tr('approvals.denyAll')}
              </Button>
            )}
            {allowable > 0 && (
              <Button
                variant="primary"
                className="h-7 px-2.5 text-meta"
                disabled={busy}
                data-approval-allow-all
                onClick={() => void run(live, allowOnce, 'allow')}
              >
                <span className="@max-[30rem]:hidden">{allowLabel}</span>
                <span className="hidden @max-[30rem]:inline">{batch ? allowLabel : tr('approvals.allowAllShort')}</span>
              </Button>
            )}
          </>
        )}
        {(canAllowAll || deniable || onCollapse) && (
          <span className={cn('relative', !canAllowAll && !onCollapse && '@min-[30rem]:hidden')}>
            <button
              type="button"
              aria-label={tr('approvals.moreActions')}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy}
              onClick={() => setMenuOpen(v => !v)}
              className="press grid size-7 place-items-center rounded-md text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-45"
            >
              <Ellipsis size={15} strokeWidth={1.75} />
            </button>
            <Popover
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              side="top"
              align="end"
              offset={6}
              className="w-60"
            >
              {deniable && (
                <MenuButton
                  className="@min-[30rem]:hidden"
                  onClick={() => {
                    setMenuOpen(false)
                    void run(live, denyOnce, 'deny')
                  }}
                >
                  {tr('approvals.denyAll')}
                </MenuButton>
              )}
              {canAllowAll && (
                <MenuButton
                  title={tr('session.live.ApprovalCard.allowAllHint')}
                  onClick={() => {
                    setMenuOpen(false)
                    setConfirmingAll(true)
                  }}
                >
                  {tr('session.live.ApprovalCard.allowAll')}
                </MenuButton>
              )}
              {onCollapse && (
                <MenuButton
                  onClick={() => {
                    setMenuOpen(false)
                    onCollapse()
                  }}
                >
                  {tr('approvals.collapse')}
                </MenuButton>
              )}
            </Popover>
          </span>
        )}
      </header>

      <div
        ref={listRef}
        role="listbox"
        aria-label={tr('approvals.list')}
        aria-activedescendant={selected ? `approval-row-${selected}` : undefined}
        tabIndex={0}
        data-approval-focus
        onKeyDown={onKeyDown}
        onFocus={e => {
          if (e.target === e.currentTarget && !selected && selectable[0]) setSelected(selectable[0])
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line-subtle outline-none"
      >
        {entries.map(entry =>
          entry.kind === 'row' ? (
            rowFor(entry.request, false)
          ) : (
            <div key={entry.key} data-approval-group={entry.key}>
              <GroupHeader
                entry={entry}
                live={entry.requests.filter(r => pendingById.has(r.requestId) && !doneHere.has(r.requestId))}
                disabled={busy}
                onAlways={(targets, scope) => void run(targets, alwaysForGroup(scope), 'allow')}
              />
              {entry.requests.map(r => rowFor(r, true))}
            </div>
          ),
        )}
      </div>

      {confirmingAll ? (
        <FullAccessConfirm
          title={tr('fullAccess.confirm.title')}
          items={[tr('fullAccess.confirm.allowThis'), tr('fullAccess.confirm.scopeCard')]}
          cancelLabel={tr('fullAccess.confirm.back')}
          confirmLabel={tr('fullAccess.confirm.allowThisOk')}
          disabled={busy}
          onCancel={() => setConfirmingAll(false)}
          onConfirm={() => {
            setConfirmingAll(false)
            const decisions = allowAllDecisions(live)
            void run(live, r => decisions.get(r.requestId) ?? null, 'allow')
          }}
          className="shrink-0 border-t border-line-subtle bg-hover px-4 pt-2.5 pb-2.5"
        />
      ) : null}
    </section>
  )
}

/** 按钮的悬停提示带上快捷键（docs/ui/approval-keys-mockup.html 方案 B：不再有按焦点出现的提示行） */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

function MenuButton({
  children,
  onClick,
  title,
  className,
}: {
  children: ReactNode
  onClick: () => void
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      data-menu-item
      title={title}
      onClick={onClick}
      className={cn('flex h-8 w-full items-center rounded-md px-2 text-left text-ui text-fg hover:bg-hover', className)}
    >
      {children}
    </button>
  )
}

/** 「始终允许」的范围菜单（行上 ▾ 和组头共用） */
function ScopeMenu({
  open,
  onClose,
  note,
  scopes,
  onPick,
  onAllowOnce,
}: {
  open: boolean
  onClose: () => void
  note: string
  scopes: AlwaysScope[]
  onPick: (scope: AlwaysScope) => void
  onAllowOnce?: () => void
}) {
  useI18n()
  return (
    <Popover open={open} onClose={onClose} side="top" align="end" offset={6} className="w-72" role="menu">
      {onAllowOnce && (
        <>
          <MenuButton
            onClick={() => {
              onClose()
              onAllowOnce()
            }}
          >
            {tr('approvals.allowOnce')}
          </MenuButton>
          <div className="mx-1 my-1 border-t border-line-subtle" />
        </>
      )}
      <div className="px-2 pt-1 pb-1 text-label font-medium text-fg-faint">{note}</div>
      {scopes.map(scope => (
        <button
          key={scope}
          type="button"
          data-menu-item
          data-scope={scope}
          onClick={() => {
            onClose()
            onPick(scope)
          }}
          className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-hover"
        >
          <span className="text-ui text-fg">{SCOPE_INFO[scope].label}</span>
          <span className="text-meta text-fg-muted">{SCOPE_INFO[scope].desc}</span>
        </button>
      ))}
    </Popover>
  )
}

function RowTag({ children, accent, warn }: { children: ReactNode; accent?: boolean; warn?: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm px-1.5 py-px text-label',
        accent ? 'bg-accent-soft text-accent-fg' : warn ? 'bg-warn/12 text-warn' : 'bg-subtle text-fg-muted',
      )}
    >
      {children}
    </span>
  )
}

function GroupHeader({
  entry,
  live,
  disabled,
  onAlways,
}: {
  entry: Extract<ApprovalEntry, { kind: 'group' }>
  live: ApprovalRequest[]
  disabled: boolean
  onAlways: (targets: ApprovalRequest[], scope: AlwaysScope) => void
}) {
  useI18n()
  const [open, setOpen] = useState(false)
  const scopes = commonScopes(live)
  const allowable = live.some(r => r.canAllow !== false)
  return (
    <div
      data-approval-group-head
      className="flex min-h-8 items-center gap-2 border-b border-line-subtle bg-wall-tint py-1 pr-2 pl-4 text-meta text-fg-muted"
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-fg-secondary">{entry.label}</span> × {live.length || entry.requests.length}
      </span>
      {scopes.length > 0 && allowable && live.length > 0 && (
        <span className="relative">
          <Button
            variant="outline"
            className="h-6 gap-1 px-2 text-meta font-normal"
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            data-approval-group-always
            onClick={() => setOpen(v => !v)}
          >
            <span className="@max-[30rem]:hidden">{tr('approvals.alwaysGroup', { tool: entry.short })}</span>
            <span className="hidden @max-[30rem]:inline">{tr('approvals.alwaysShort')}</span>
            <ChevronDown size={12} strokeWidth={1.75} className="text-fg-muted" />
          </Button>
          <ScopeMenu
            open={open}
            onClose={() => setOpen(false)}
            note={tr('approvals.alwaysGroupNote', { n: live.length })}
            scopes={scopes}
            onPick={scope => onAlways(live, scope)}
          />
        </span>
      )}
    </div>
  )
}

function ApprovalRow({
  request,
  summary,
  inGroup,
  state,
  expanded,
  selected,
  fresh,
  disabled,
  onToggle,
  onAnswer,
}: {
  request: ApprovalRequest
  summary: ApprovalSummary
  inGroup: boolean
  state: RowState
  expanded: boolean
  selected: boolean
  fresh: boolean
  disabled: boolean
  onToggle: () => void
  onAnswer: (d: ApprovalDecision) => void
}) {
  useI18n()
  const [menu, setMenu] = useState(false)
  const Icon = iconFor(request)
  const done = state.kind === 'done'
  const canAllow = request.canAllow !== false
  const canDeny = request.canDeny !== false
  const idle = state.kind === 'idle' || state.kind === 'failed'
  const label = inGroup ? null : summary.label
  return (
    <div
      id={`approval-row-${request.requestId}`}
      role="option"
      aria-selected={selected}
      data-approval-row={request.requestId}
      data-state={state.kind}
      className={cn('border-b border-line-subtle last:border-b-0', fresh && 'value-flash')}
    >
      <div
        className={cn(
          'flex min-h-9 items-center gap-1 pr-2 pl-2',
          selected && 'bg-selected shadow-[inset_2px_0_0_var(--accent)]',
        )}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-expanded={expanded}
          onClick={onToggle}
          title={summary.full}
          className={cn(
            'flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-list',
            done ? 'text-fg-faint' : 'text-fg',
          )}
        >
          {expanded ? (
            <ChevronDown size={13} strokeWidth={1.75} className="shrink-0 text-fg-faint" />
          ) : (
            <ChevronRight size={13} strokeWidth={1.75} className="shrink-0 text-fg-faint" />
          )}
          <Icon size={15} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          <span className={cn('min-w-0 flex-1 truncate', done && 'opacity-60')}>
            {label && <span className="mr-2 text-fg-muted">{label}</span>}
            <span className={cn(summary.mono && 'font-mono text-[length:calc(12.5px*var(--font-scale,1))]')}>
              {summary.text}
            </span>
            {request.kind === 'file_change' && (summary.added || summary.removed) ? (
              <DiffStat added={summary.added ?? 0} removed={summary.removed ?? 0} className="ml-1.5 text-meta" />
            ) : null}
            {summary.hint && (
              <span className="ml-1.5 text-meta text-fg-muted">
                <span className="@max-[30rem]:hidden">· {summary.hint}</span>
                {summary.hintShort && <span className="hidden @max-[30rem]:inline">{summary.hintShort}</span>}
              </span>
            )}
          </span>
          {/* 标签不跟着文字一起被省略号截掉 */}
          {summary.outside && <RowTag>{tr('approvals.outside')}</RowTag>}
          {summary.wrapped && <RowTag warn>{tr('approvals.wrapped')}</RowTag>}
          {!canAllow && !done && <RowTag>{tr('approvals.onlyDeny')}</RowTag>}
          {fresh && !done && <RowTag accent>{tr('approvals.newRow')}</RowTag>}
        </button>
        <RowActions
          state={state}
          canAllow={canAllow}
          canDeny={canDeny}
          disabled={disabled || !idle}
          scopes={request.alwaysScopes}
          toolName={summary.label || toolLabel(request.toolName, request.description) || request.title}
          menu={menu}
          setMenu={setMenu}
          onAnswer={onAnswer}
        />
      </div>
      {state.kind === 'failed' && (
        <p role="alert" className="pr-4 pb-1.5 pl-11 text-meta text-danger">
          {tr('approvals.sendFailed', { p0: state.message })}
        </p>
      )}
      {expanded && !done && (
        <div className="pr-4 pb-2.5 pl-11">
          {summary.where && (
            <p className="mb-1 truncate font-mono text-label text-fg-faint" title={summary.where}>
              {summary.where}
            </p>
          )}
          <ApprovalBody request={request} className="max-h-40 overflow-auto" compact />
        </div>
      )}
    </div>
  )
}

function RowActions({
  state,
  canAllow,
  canDeny,
  disabled,
  scopes,
  toolName,
  menu,
  setMenu,
  onAnswer,
}: {
  state: RowState
  canAllow: boolean
  canDeny: boolean
  disabled: boolean
  scopes: AlwaysScope[]
  toolName: string
  menu: boolean
  setMenu: (open: boolean) => void
  onAnswer: (d: ApprovalDecision) => void
}) {
  useI18n()
  if (state.kind === 'done')
    return (
      <span className="inline-flex shrink-0 items-center gap-1 px-1 text-meta text-accent-fg">
        {state.result !== 'deny' && <Check size={13} strokeWidth={2} />}
        {tr(
          state.result === 'allow'
            ? 'approvals.allowed'
            : state.result === 'deny'
              ? 'approvals.denied'
              : 'approvals.handled',
        )}
      </span>
    )
  if (state.kind === 'sending')
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 px-1 text-meta text-fg-muted">
        <Spinner size={12} />
        {tr('approvals.sending')}
      </span>
    )
  if (state.kind === 'queued')
    return <span className="shrink-0 px-1 text-meta text-fg-faint">{tr('approvals.queued')}</span>
  return (
    <span className="flex shrink-0 items-center gap-1">
      {canDeny && (
        <Button
          variant="ghost"
          className="h-7 px-2 text-meta font-normal"
          disabled={disabled}
          title={`${tr('approvals.deny')} · ${MOD}+⌫`}
          aria-label={tr('approvals.deny')}
          data-approval-deny
          onClick={() => onAnswer({ type: 'deny' })}
        >
          <span className="@max-[30rem]:hidden">{tr('approvals.deny')}</span>
          <X size={14} strokeWidth={1.75} className="hidden @max-[30rem]:block" />
        </Button>
      )}
      {canAllow && (
        <span className="relative inline-flex">
          <Button
            variant="outline"
            className={cn('h-7 px-2.5 text-meta', scopes.length > 0 && 'rounded-r-none')}
            disabled={disabled}
            title={`${tr('approvals.allow')} · ${MOD}+Enter`}
            aria-label={tr('approvals.allow')}
            data-approval-allow
            onClick={() => onAnswer({ type: 'allow' })}
          >
            <span className="@max-[30rem]:hidden">{tr('approvals.allow')}</span>
            <Check size={14} strokeWidth={1.75} className="hidden @max-[30rem]:block" />
          </Button>
          {scopes.length > 0 && (
            <>
              <Button
                variant="outline"
                className="h-7 rounded-l-none border-l-0 px-1 text-fg-muted"
                disabled={disabled}
                aria-label={tr('approvals.alwaysOne', { tool: toolName })}
                aria-haspopup="menu"
                aria-expanded={menu}
                data-approval-always
                onClick={() => setMenu(!menu)}
              >
                <ChevronDown size={13} strokeWidth={1.75} />
              </Button>
              <ScopeMenu
                open={menu}
                onClose={() => setMenu(false)}
                note={tr('approvals.alwaysOne', { tool: toolName })}
                scopes={scopes}
                onPick={scope => onAnswer({ type: 'allow_always', scope })}
                onAllowOnce={() => onAnswer({ type: 'allow' })}
              />
            </>
          )}
        </span>
      )}
    </span>
  )
}
