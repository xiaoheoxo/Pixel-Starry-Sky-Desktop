import { translateMessage } from '../../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '../../../i18n/core'
// 智能体追踪面板（docs/engines.md §15.4，参考 JuCode AgentRunsPanel）：
// 会话主区右侧的抽屉。总览：每个多智能体编排一节（按阶段折叠，阶段一行带圆点，docs/ui/agent-trace-phases.md），
// 再加「子智能体（Agent 工具）」一节（每个下面一行「正在做什么」）；
// 点一个智能体进入它的会话（只读），还在运行时每 2.5 秒刷新。
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  History,
  Minus,
  PanelRight,
  PictureInPicture2,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { AgentRun, AgentRuns, Item, WorkflowRun } from '@pixelsky/protocol'
import { IconButton, ResizeHandle, Spinner, cn } from '@/ui'
import { bridge, toChangedFiles, useEngineState } from '@/features/engine'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import {
  RUN_STATE_LABEL,
  anyRunning,
  elapsed,
  formatCount,
  formatDuration,
  phaseOpenByDefault,
  phaseRows,
  phaseViews,
  runState,
  shortModel,
  type PhaseView,
  type RunState,
} from './agentTrace'
import { activityTooltip, agentActivity, agoText, runActivity, type Activity, type AgentStep } from './agentActivity'
import { progressAgents } from './progressData'
import { useFirstSeen } from './useFirstSeen'
import { Markdown } from '@/ui/markdown/Markdown'
import { ReasoningBlock, ToolItemRow, UserBubble } from './ItemRows'
import { useDockFloat, type DragKind } from './useDockFloat'
import { ChangedFilesCard } from '../ChangedFilesCard'
import { agentFileCount, filesByAgent } from './changeBlocks'
import type { ResizeDir } from './traceWindow'
import { ago, endedAt, partitionRuns, turnToolUseIds, type TraceEntry } from './traceHistory'
import { clearHistory, markSeen, restoreHistory, setOnlyTurn, useTraceHistoryState } from './traceHistoryStore'

/** 会话顶部栏高度（top-12）和面板标题栏高度（h-11） */
const SESSION_HEADER = 48
const PANEL_HEADER = 44

/** 浮动时的 8 个缩放把手：四条边和四个角 */
const FLOAT_HANDLES: Record<ResizeDir, string> = {
  n: 'inset-x-3 -top-1 h-2 cursor-ns-resize',
  s: 'inset-x-3 -bottom-1 h-2 cursor-ns-resize',
  w: 'inset-y-3 -left-1 w-2 cursor-ew-resize',
  e: 'inset-y-3 -right-1 w-2 cursor-ew-resize',
  nw: '-top-1 -left-1 size-4 cursor-nwse-resize',
  se: '-right-1 -bottom-1 size-4 cursor-nwse-resize',
  ne: '-top-1 -right-1 size-4 cursor-nesw-resize',
  sw: '-bottom-1 -left-1 size-4 cursor-nesw-resize',
}

const STATE_ICON: Record<RunState, LucideIcon | null> = {
  running: null,
  done: Check,
  failed: X,
  stopped: Minus,
  queued: CircleDashed,
}

/** 带数量的文字：英文 1 个用单数（1 tool call / 12 tool calls），中文两个 key 相同 */
const countText = (n: number, one: TranslationKey, many: TranslationKey): string => tr(n === 1 ? one : many, { n })

const toolCallsText = (n: number): string =>
  countText(n, 'session.live.AgentTracePanel.toolCall', 'session.live.AgentTracePanel.toolCalls')

function StateIcon({ state }: { state: string }) {
  useI18n()
  const s = runState(state)
  const Icon = STATE_ICON[s]
  return (
    <span className="inline-flex w-4 shrink-0 justify-center" title={RUN_STATE_LABEL[s]}>
      {Icon ? (
        <Icon
          size={13}
          strokeWidth={2}
          className={cn(
            s === 'done' && 'text-success',
            s === 'failed' && 'text-danger',
            (s === 'stopped' || s === 'queued') && 'text-fg-faint',
          )}
        />
      ) : (
        <Spinner size={12} />
      )}
    </span>
  )
}

/** 智能体表的列：状态、名字、耗时、tokens、工具次数；面板窄（340 以下）时去掉 tokens */
const ROW_GRID =
  'grid grid-cols-[16px_minmax(0,1fr)_64px_70px_36px] gap-2 @max-[340px]:grid-cols-[16px_minmax(0,1fr)_56px_32px]'
const TOKENS_COL = '@max-[340px]:hidden'

/** 名字下面那一行（docs/ui/agent-trace-phases.md §2）：Agent 工具的子智能体写「正在做什么」，编排里的只在失败时写原因 */
export interface RowLine {
  activity: Activity
  /** 「几秒前」和悬停提示用 */
  steps?: readonly AgentStep[]
}

/** 一行智能体：状态、名字（后面小字：改了几个文件 · 类型 · 模型）、耗时、tokens、工具次数；下面可选一行 */
function AgentRow({
  a,
  now,
  files = 0,
  showModel = true,
  line,
  seen,
  onPick,
}: {
  a: AgentRun
  now: number
  /** 这个子智能体改了几个文件（docs/ui/subagent-changes.md §2.3） */
  files?: number
  /** 阶段里都用同一个模型时写在表头，行里不再写 */
  showModel?: boolean
  line?: RowLine | null
  seen?: (id: string) => number
  onPick: (id: string) => void
}) {
  useI18n()
  const s = runState(a.state)
  const meta = [
    files > 0 && tr(files === 1 ? 'session.changes.agentFile' : 'session.changes.agentFiles', { n: files }),
    a.type,
    showModel && shortModel(a.model),
  ]
    .filter(Boolean)
    .join(' · ')
  const act = line?.activity
  return (
    <button
      type="button"
      disabled={!a.id}
      onClick={() => onPick(a.id)}
      // 悬停：和进度卡片同一套说法（任务：… / 完成：… / 失败：…），docs/ui/progress-card.md §9
      title={
        act && seen ? activityTooltip(act, line?.steps ?? [], seen, now) : runActivity(a)?.full || a.prompt || a.label
      }
      className={cn(
        ROW_GRID,
        'w-full items-center rounded-md px-2 py-1 text-left text-meta hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent',
      )}
    >
      <StateIcon state={a.state} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-list text-fg">
          {a.label || a.id || tr('session.live.AgentTracePanel.queued')}
          {meta && (
            <span className="ml-1.5 text-label text-fg-faint" title={a.model || undefined}>
              {meta}
            </span>
          )}
        </span>
        {act && (
          <span
            data-activity={act.kind}
            className={cn(
              'truncate text-label',
              act.kind === 'failed' ? 'text-danger' : act.kind === 'task' ? 'text-fg-faint' : 'text-fg-muted',
            )}
          >
            {act.text}
            {act.kind === 'step' && act.stepId && seen && (
              <span className="text-fg-faint tabular-nums"> · {agoText(now - seen(act.stepId))}</span>
            )}
          </span>
        )}
      </span>
      <span className="text-right text-fg-muted tabular-nums">{formatDuration(elapsed(a, s, now))}</span>
      <span className={cn('text-right text-fg-muted tabular-nums', TOKENS_COL)}>{formatCount(a.tokens)}</span>
      <span className="text-right text-fg-muted tabular-nums">{a.toolCalls}</span>
    </button>
  )
}

/** 编排里的智能体：只在失败时在名字下面写原因（跑着的只有任务说明，和名字差不多，写了只会变挤） */
const workflowLine = (a: AgentRun): RowLine | null => {
  const activity = runState(a.state) === 'failed' ? runActivity(a) : null
  return activity ? { activity } : null
}

function UnseenTag() {
  useI18n()
  return (
    <span className="shrink-0 rounded-full bg-warn/15 px-1.5 text-label font-medium text-warn">
      {tr('trace.history.unseen')}
    </span>
  )
}

function ColumnHead({ model = '' }: { model?: string }) {
  useI18n()
  return (
    <div className={cn(ROW_GRID, 'px-2 pb-0.5 text-label text-fg-faint')}>
      <span />
      <span className="truncate" title={model || undefined}>
        {model ? shortModel(model) : tr('session.contextData.agents')}
      </span>
      <span className="text-right">{tr('session.live.AgentTracePanel.duration')}</span>
      <span className={cn('text-right', TOKENS_COL)}>Tokens</span>
      <span className="text-right">{tr('session.live.AgentTracePanel.tools')}</span>
    </div>
  )
}

/** 阶段一行上的圆点：每个智能体一个，完成灰实心、跑着亮色呼吸、没开始空、失败红、停掉灰圈；放不下的截掉 */
const DOTS_MAX = 24
function PhaseDots({ dots }: { dots: RunState[] }) {
  return (
    <span aria-hidden className="flex min-w-0 items-center gap-[3px] overflow-hidden">
      {dots.slice(0, DOTS_MAX).map((d, i) => (
        <span
          key={i}
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            d === 'done' && 'bg-fg-faint',
            d === 'running' && 'animate-pulse bg-fg',
            d === 'queued' && 'bg-line-strong',
            d === 'failed' && 'bg-danger',
            d === 'stopped' && 'ring-1 ring-fg-faint ring-inset',
          )}
        />
      ))}
      {dots.length > DOTS_MAX && (
        <span className="shrink-0 text-label text-fg-faint tabular-nums">+{dots.length - DOTS_MAX}</span>
      )}
    </span>
  )
}

/** 一个阶段：一行（状态、名字、圆点、完成数/总数、箭头）点开是这个阶段的表；没分阶段的编排直接是表 */
function PhaseBlock({
  phase,
  open,
  onToggle,
  bare,
  now,
  onPick,
}: {
  phase: PhaseView
  open: boolean
  onToggle: () => void
  /** 编排没分阶段：不画阶段那一行 */
  bare: boolean
  now: number
  onPick: (id: string) => void
}) {
  useI18n()
  const [all, setAll] = useState(false)
  const { shown, hidden } = phaseRows(phase.agents, all)
  const table = (
    <div className="pt-0.5 pb-1">
      <ColumnHead model={phase.model} />
      {shown.map((a, j) => (
        <AgentRow
          key={a.id || `${phase.title}-${j}`}
          a={a}
          now={now}
          showModel={!phase.model}
          line={workflowLine(a)}
          onPick={onPick}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="ml-[26px] rounded-md px-2 py-0.5 text-label text-fg-muted hover:bg-hover hover:text-fg"
        >
          {tr('trace.phase.more', { n: hidden })}
        </button>
      )}
    </div>
  )
  if (bare) return table
  const total = phase.agents.length
  return (
    <div data-trace-phase={phase.title || undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        title={tr('trace.phase.count', { done: phase.done, total })}
        className={cn(
          'flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover',
          open && 'bg-subtle',
        )}
      >
        <StateIcon state={phase.state} />
        <span className="max-w-[45%] shrink-0 truncate text-list text-fg">
          {phase.title || tr('trace.phase.other')}
        </span>
        <PhaseDots dots={phase.dots} />
        <span className="flex-1" />
        <span className="shrink-0 text-meta text-fg-muted tabular-nums">
          {phase.done}/{total}
        </span>
        <ChevronRight
          size={13}
          strokeWidth={1.5}
          className={cn('shrink-0 text-fg-faint transition-transform duration-(--dur-fast)', open && 'rotate-90')}
        />
      </button>
      {open && table}
    </div>
  )
}

function WorkflowSection({
  run,
  open,
  onToggle,
  now,
  onPick,
  unseen,
}: {
  run: WorkflowRun
  open: boolean
  onToggle: () => void
  now: number
  onPick: (id: string) => void
  /** 「需要看一眼」里还没看过的：橙色细边框 + 小标签 */
  unseen?: boolean
}) {
  useI18n()
  const phases = useMemo(() => phaseViews(run), [run])
  // 阶段展开：跑着的和有失败的默认展开，点过的这次打开面板里记住
  const [phaseOpen, setPhaseOpen] = useState<Record<string, boolean>>({})
  const s = runState(run.status)
  const bare = phases.length === 1 && !phases[0].title
  return (
    <section className={cn('rounded-xl border bg-surface shadow-sm', unseen ? 'border-warn/35' : 'border-line')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 pt-2.5 pb-0.5 text-left"
      >
        <StateIcon state={run.status} />
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-fg">
          {run.name || run.description || run.id}
        </span>
        {unseen && <UnseenTag />}
        <ChevronRight
          size={14}
          strokeWidth={1.5}
          className={cn('shrink-0 text-fg-faint transition-transform duration-(--dur-fast)', open && 'rotate-90')}
        />
      </button>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-3 pl-[34px] text-meta text-fg-muted tabular-nums">
        <span title={RUN_STATE_LABEL[s]}>{tr('trace.phase.workflow')}</span>
        <span>{formatDuration(elapsed(run, s, now))}</span>
        <span>{formatCount(run.tokens)} tokens</span>
        <span>{toolCallsText(run.toolCalls)}</span>
      </div>
      {run.name && run.description && (
        <p
          title={run.description}
          className="line-clamp-2 px-3 pt-0.5 pl-[34px] text-meta text-fg-faint @max-[340px]:line-clamp-1"
        >
          {run.description}
        </p>
      )}
      <div className={cn('px-1.5 pt-1.5', open ? 'pb-1.5' : 'pb-1')}>
        {!open ? null : run.agents.length === 0 ? (
          <div className="px-2 py-2 text-meta text-fg-faint">
            {tr('session.live.AgentTracePanel.noAgentsDispatchedYet')}
          </div>
        ) : (
          phases.map((p, i) => {
            const key = p.title || `#${i}`
            const isOpen = phaseOpen[key] ?? phaseOpenByDefault(p.state)
            return (
              <PhaseBlock
                key={key}
                phase={p}
                bare={bare}
                open={isOpen}
                onToggle={() => setPhaseOpen(o => ({ ...o, [key]: !isOpen }))}
                now={now}
                onPick={onPick}
              />
            )
          })
        )}
      </div>
    </section>
  )
}

/** 历史里的一行：状态、名字、几个智能体 / 子智能体、耗时、tokens、多久前 */
function HistoryRow({ entry, now, onClick }: { entry: TraceEntry; now: number; onClick: () => void }) {
  useI18n()
  const { run } = entry
  const wf = entry.kind === 'workflow'
  const state = entry.kind === 'workflow' ? entry.run.status : entry.run.state
  const s = runState(state)
  const name =
    entry.kind === 'workflow'
      ? entry.run.name || entry.run.description || entry.run.id
      : entry.run.label || entry.run.id
  const kind =
    entry.kind === 'workflow'
      ? countText(entry.run.agents.length, 'trace.history.agentsOne', 'trace.history.agentsMany')
      : tr('trace.history.subagent')
  return (
    <button
      type="button"
      data-trace-history-row
      aria-expanded={wf ? false : undefined}
      onClick={onClick}
      disabled={!run.id}
      title={name}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-meta hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
    >
      <StateIcon state={state} />
      <span className="min-w-0 flex-1 truncate text-list text-fg">{name}</span>
      <span className="shrink-0 text-label text-fg-faint">{kind}</span>
      <span className="w-14 shrink-0 text-right text-fg-muted tabular-nums">
        {formatDuration(elapsed(run, s, now))}
      </span>
      <span className="w-16 shrink-0 text-right text-fg-muted tabular-nums">{formatCount(run.tokens)}</span>
      <span className="w-14 shrink-0 text-right text-fg-faint tabular-nums">
        {endedAt(run) > 0 ? ago(endedAt(run), now) : ''}
      </span>
      <ChevronRight size={13} strokeWidth={1.5} className="shrink-0 text-fg-faint" />
    </button>
  )
}

/** 历史：默认折叠成一行虚线框，展开后一行一个；编排点开就地变卡片，子智能体进详情 */
function TraceHistory({
  sessionId,
  entries,
  clearedCount,
  onlyTurn,
  now,
  onPick,
}: {
  sessionId: string
  entries: TraceEntry[]
  clearedCount: number
  onlyTurn: boolean
  now: number
  onPick: (id: string) => void
}) {
  useI18n()
  const [open, setOpen] = useState(false)
  const [cards, setCards] = useState<Record<string, boolean>>({})
  const tokens = entries.reduce((n, e) => n + e.run.tokens, 0)
  const allCleared = entries.length === 0 && clearedCount > 0
  const summary = [
    onlyTurn
      ? tr('trace.history.thisTurn', { n: entries.length })
      : tr('trace.history.completed', { n: entries.length }),
    tr('session.live.AgentTracePanel.tokensTotal', { tokens: formatCount(tokens) }),
  ].join(' · ')
  const small =
    'shrink-0 rounded-md px-2 py-0.5 text-label text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent'
  return (
    <div
      data-trace-history
      role="group"
      aria-label={tr('trace.history.sectionHistory')}
      className="flex flex-col gap-1"
    >
      <div
        data-trace-history-row
        className="flex items-center gap-1 rounded-lg border border-dashed border-line px-2 py-1.5"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? tr('trace.history.collapse') : tr('trace.history.expand')}
          onClick={() => setOpen(v => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-meta text-fg-muted"
        >
          <History size={14} strokeWidth={1.5} className="shrink-0" />
          <span className="min-w-0 truncate tabular-nums">
            {allCleared ? tr('trace.history.cleared', { n: clearedCount }) : summary}
          </span>
          <ChevronRight
            size={13}
            strokeWidth={1.5}
            className={cn('shrink-0 transition-transform duration-(--dur-fast)', open && 'rotate-90')}
          />
        </button>
        {clearedCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-label text-fg-faint">
            {!allCleared && tr('trace.history.cleared', { n: clearedCount })}
            <button
              type="button"
              aria-label={tr('trace.history.show')}
              onClick={() => restoreHistory(sessionId)}
              className="rounded-md px-1 text-accent hover:bg-hover"
            >
              {tr('trace.history.show')}
            </button>
          </span>
        )}
        <button
          type="button"
          aria-pressed={onlyTurn}
          aria-label={tr('trace.history.onlyTurn')}
          title={tr('trace.history.onlyTurnHint')}
          onClick={() => setOnlyTurn(!onlyTurn)}
          className={cn(small, onlyTurn && 'bg-selected text-fg')}
        >
          {tr('trace.history.onlyTurn')}
        </button>
        {entries.length > 0 && (
          <button
            type="button"
            aria-label={tr('trace.history.clear')}
            title={tr('trace.history.clearHint')}
            onClick={() => clearHistory(sessionId, Date.now())}
            className={small}
          >
            {tr('trace.history.clear')}
          </button>
        )}
      </div>
      {open &&
        (entries.length === 0 ? (
          <div className="px-2 py-1 text-meta text-fg-faint">
            {onlyTurn ? tr('trace.history.empty') : tr('trace.history.emptyAll')}
          </div>
        ) : (
          entries.map((e, i) => {
            const id = e.run.id
            if (e.kind === 'workflow' && cards[id]) {
              return (
                <WorkflowSection
                  key={`w-${id || i}`}
                  run={e.run}
                  open
                  onToggle={() => setCards(c => ({ ...c, [id]: false }))}
                  now={now}
                  onPick={onPick}
                />
              )
            }
            return (
              <HistoryRow
                key={`${e.kind}-${id || i}`}
                entry={e}
                now={now}
                onClick={() => (e.kind === 'workflow' ? setCards(c => ({ ...c, [id]: true })) : onPick(id))}
              />
            )
          })
        ))}
    </div>
  )
}

function TranscriptItem({ item }: { item: Item }) {
  useI18n()
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} />
    case 'assistant':
      return <Markdown text={item.text} />
    case 'reasoning':
      return <ReasoningBlock item={item} />
    case 'command':
    case 'file_change':
    case 'tool':
      return <ToolItemRow item={item} />
    default:
      return null
  }
}

/** 一个智能体的详情：任务说明 + 它的对话（只读） */
function AgentFocus({
  sessionId,
  agent,
  run,
  now,
  onBack,
}: {
  sessionId: string
  agent: AgentRun
  run: WorkflowRun | null
  now: number
  onBack: () => void
}) {
  useI18n()
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [taskOpen, setTaskOpen] = useState(false)
  const s = runState(agent.state)
  const live = s === 'running'

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      // 演示模式从演示数据取（docs/ui/demo-conversation.md）
      const request = isDemo
        ? Promise.resolve().then(() => demo().conversations.subagentTranscript(sessionId, agent.id))
        : bridge?.subagentTranscript(sessionId, agent.id)
      request
        ?.then(list => {
          if (cancelled) return
          setItems(list)
          setError(null)
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message)
        })
    }
    load()
    // 窗口在后台时不轮询，回到前台马上取一次（docs/perf-audit-2026-10-18.md B7）
    const timer = live ? window.setInterval(() => document.visibilityState === 'visible' && load(), 2500) : undefined
    const onVisible = (): void => {
      if (live && document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [sessionId, agent.id, live])

  // 第一条用户消息就是任务说明，单独折叠显示
  const task = items?.[0]?.kind === 'user' ? items[0].text : agent.prompt
  const rest = items?.[0]?.kind === 'user' ? items.slice(1) : (items ?? [])
  // 它改了哪些文件：从它自己的对话里汇总（docs/ui/subagent-changes.md §2.3）
  const changes = useMemo(
    () =>
      toChangedFiles(
        (items ?? []).flatMap(it => (it.kind === 'file_change' && it.status === 'completed' ? it.changes : [])),
      ),
    [items],
  )
  const target = useMemo(() => ({ sessionId }), [sessionId])

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-meta text-fg-muted hover:bg-hover hover:text-fg"
      >
        <ArrowLeft size={14} strokeWidth={1.5} />
        {tr('session.live.AgentTracePanel.backToList')}{' '}
      </button>
      <div>
        <div className="flex items-center gap-2">
          <StateIcon state={agent.state} />
          <span className="min-w-0 truncate text-section font-semibold text-fg">{agent.label || agent.id}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-6 text-meta text-fg-muted tabular-nums">
          {run && <span>{run.name || run.description}</span>}
          {[agent.type, shortModel(agent.model)].filter(Boolean).length > 0 && (
            <span title={agent.model || undefined}>
              {[agent.type, shortModel(agent.model)].filter(Boolean).join(' · ')}
            </span>
          )}
          <span>{RUN_STATE_LABEL[s]}</span>
          <span>{formatDuration(elapsed(agent, s, now))}</span>
          <span>{formatCount(agent.tokens)} tokens</span>
          <span>{toolCallsText(agent.toolCalls)}</span>
        </div>
      </div>
      {task && (
        <section className="rounded-lg border border-line bg-surface">
          <button
            type="button"
            onClick={() => setTaskOpen(v => !v)}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-meta font-medium text-fg-secondary"
          >
            <ChevronRight
              size={13}
              strokeWidth={1.5}
              className={cn('transition-transform duration-(--dur-fast)', taskOpen && 'rotate-90')}
            />
            {tr('session.live.AgentTracePanel.task')}{' '}
          </button>
          {taskOpen && (
            <div className="border-t border-line-subtle px-3 py-2">
              <Markdown text={task} />
            </div>
          )}
        </section>
      )}
      {changes && <ChangedFilesCard data={changes} target={target} />}
      {agent.result && !items?.length && (
        <div className="text-meta text-fg-muted">
          {tr('session.live.AgentTracePanel.result')}
          {agent.result}
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        {error ? (
          <div className="text-meta text-fg-faint">{translateMessage(error)}</div>
        ) : items === null ? (
          <div className="flex items-center gap-2 text-meta text-fg-muted">
            <Spinner size={12} />
            {tr('session.live.AgentTracePanel.loadingConversation')}{' '}
          </div>
        ) : rest.length === 0 ? (
          <div className="text-meta text-fg-faint">{tr('session.live.AgentTracePanel.noOutputYet')}</div>
        ) : (
          rest.map(it => <TranscriptItem key={it.id} item={it} />)
        )}
      </div>
    </div>
  )
}

export interface AgentTracePanelProps {
  sessionId: string
  runs: AgentRuns
  /** 打开时定位的智能体；null 表示总览 */
  focus: string | null
  onFocus: (agentId: string | null) => void
  onClose: () => void
  /** 主区顶部有会话顶部栏（不在窗格里）时让开它；窗格里顶部栏在主区外面，面板从顶上开始 */
  belowHeader?: boolean
}

export function AgentTracePanel({ sessionId, runs, focus, onFocus, onClose, belowHeader }: AgentTracePanelProps) {
  useI18n()
  const [now, setNow] = useState(() => Date.now())
  const running = anyRunning(runs.workflows, runs.agents)
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [running])

  // 正在跑的编排默认展开；需要看一眼的默认收起
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const focused = useMemo(() => {
    if (!focus) return null
    for (const w of runs.workflows) {
      const a = w.agents.find(x => x.id === focus)
      if (a) return { agent: a, run: w }
    }
    const a = runs.agents.find(x => x.id === focus)
    return a ? { agent: a, run: null } : null
  }, [focus, runs])

  // 子智能体改了几个文件：主会话里它的工具条目带着派出它的 Agent 调用 id
  const sessionItems = useEngineState(s => s.snapshots[sessionId]?.items)
  const fileCounts = useMemo(() => filesByAgent(sessionItems ?? []), [sessionItems])
  const turnIds = useMemo(() => turnToolUseIds(sessionItems ?? []), [sessionItems])
  const hist = useTraceHistoryState(sessionId)
  // 在「需要看一眼」里展开过的编排：已记为看过，但这次打开期间先留在原地，免得点开就消失
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set())
  const seen = useMemo(() => {
    if (held.size === 0) return hist.seen
    const next = new Set(hist.seen)
    for (const id of held) next.delete(id)
    return next
  }, [hist.seen, held])
  const part = useMemo(
    () =>
      partitionRuns(runs, {
        now,
        seen,
        clearedAt: hist.clearedAt,
        onlyTurn: hist.onlyTurn,
        turnToolUseIds: turnIds,
      }),
    [runs, now, seen, hist.clearedAt, hist.onlyTurn, turnIds],
  )
  const runningCount = part.running.workflows.length + part.running.agents.length
  // Agent 工具的子智能体「正在做什么」：引擎给的摘要 / 结果 / 任务说明 + 对话里它调用过的工具（agentActivity.ts）
  const sessionSubagents = useEngineState(s => s.snapshots[sessionId]?.subagents)
  const agentLines = useMemo(() => {
    const out = new Map<string, RowLine>()
    for (const a of progressAgents(sessionSubagents ?? [], runs, sessionItems ?? [])) {
      const activity = agentActivity(a, a.steps)
      if (activity) out.set(a.id, { activity, steps: a.steps })
    }
    return out
  }, [sessionSubagents, runs, sessionItems])
  const stepSeen = useFirstSeen()
  const empty = runs.workflows.length === 0 && runs.agents.length === 0
  const allDone = !empty && runningCount === 0 && part.attention.length === 0
  const showHistory = part.history.length > 0 || part.clearedCount > 0 || hist.onlyTurn

  // 看过：进了子智能体详情，或在「需要看一眼」里展开了编排（别在 render 里写 localStorage）
  // 只记失败 / 停止的：还在跑的先别记，免得之后失败了直接进历史；在编排里的子智能体连带记它所属的编排
  const bad = (s: string | undefined) => s !== undefined && ['failed', 'stopped'].includes(runState(s))
  const focusedId = focused && bad(focused.agent.state) ? focused.agent.id : undefined
  const focusedWfId = focused?.run && bad(focused.run.status) ? focused.run.id : undefined
  useEffect(() => {
    if (focusedId) markSeen(sessionId, focusedId)
    if (focusedWfId) markSeen(sessionId, focusedWfId)
  }, [sessionId, focusedId, focusedWfId])
  useEffect(() => {
    for (const id of held) markSeen(sessionId, id)
  }, [sessionId, held])

  // 停靠 / 浮动：量面板的父元素（会话主区），位置计算见 traceWindow.ts
  const rootRef = useRef<HTMLElement>(null)
  const win = useDockFloat(rootRef, {
    topOffset: belowHeader ? SESSION_HEADER : 0,
    headerHeight: PANEL_HEADER,
  })
  const cancelDrag = win.cancelDrag

  // Esc 关闭：在捕获阶段先拿到并标记已处理，输入框就不会再用这次 Esc 停止回复（docs/ui/conversation-ux.md §2.5）
  // 拖动窗口时 Esc 只撤回这次拖动；停靠宽度把手拖动中由把手自己处理（它在 data-layout-resize 期间接管 Esc）
  // 只管自己所在的会话：面板在后台标签 / 被隐藏的窗格里（inert）不处理；Esc 发生在别的会话或别处也不处理（焦点不在任何元素上时照旧关）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (cancelDrag()) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      const root = rootRef.current
      if (!root || root.closest('[inert],[aria-hidden="true"]')) return
      const target = e.target instanceof Node ? e.target : null
      const idle = !target || target === document.body || target === document.documentElement
      if (!idle && !(root.parentElement ?? root).contains(target)) return
      if (document.documentElement.dataset.layoutResize) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, cancelDrag])

  const { rect } = win
  const floatToggle = win.floating ? (
    <IconButton icon={PanelRight} label={tr('session.live.AgentTracePanel.dockRight')} onClick={win.toggle} />
  ) : (
    <IconButton
      icon={PictureInPicture2}
      label={tr('session.live.AgentTracePanel.float')}
      disabled={!win.canFloat}
      onClick={win.toggle}
    />
  )

  return (
    <aside
      ref={rootRef}
      // 底色用卡片色：工作台里 --bg-app 是透明的，用它会透出下面的对话（docs/ui/conversation-ux.md §2.2）
      className={cn(
        'pop-in absolute z-30 flex flex-col bg-surface shadow-popover',
        rect
          ? 'rounded-xl border border-line'
          : cn('right-0 bottom-0 border-l border-line', belowHeader ? 'top-12' : 'top-0'),
      )}
      style={
        rect
          ? { left: rect.x, top: rect.y + (belowHeader ? SESSION_HEADER : 0), width: rect.w, height: rect.h }
          : { width: `min(${win.dockWidth}px, 90%)` }
      }
      aria-label={tr('session.live.AgentTracePanel.agentActivity')}
    >
      {rect ? (
        (Object.keys(FLOAT_HANDLES) as ResizeDir[]).map(dir => (
          <div
            key={dir}
            data-no-drag
            aria-hidden="true"
            className={cn('absolute z-20 touch-none', FLOAT_HANDLES[dir])}
            {...win.dragProps(dir as DragKind)}
          />
        ))
      ) : (
        <ResizeHandle
          label={tr('session.live.AgentTracePanel.resizeWidth')}
          axis="x"
          scale={-1}
          value={win.dockWidth}
          min={win.dockMin}
          max={win.dockMax}
          className="top-0 bottom-0 -left-1"
          onChange={win.dockPreview}
          onCommit={win.dockCommit}
          onCancel={() => win.dockPreview(null)}
          onReset={win.dockReset}
        />
      )}
      <header
        className={cn(
          'flex h-11 shrink-0 touch-none items-center gap-2 border-b border-line px-4 select-none',
          rect &&
            'cursor-move rounded-t-xl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        )}
        tabIndex={rect ? 0 : undefined}
        aria-label={rect ? tr('session.live.AgentTracePanel.moveWindow') : undefined}
        title={rect ? tr('session.live.AgentTracePanel.moveWindow') : undefined}
        onKeyDown={win.headerKey}
        onDoubleClick={e => {
          if (!(e.target as HTMLElement).closest('button')) win.toggle()
        }}
        {...win.dragProps('move')}
      >
        <Bot size={16} strokeWidth={1.5} className="shrink-0 text-fg-secondary" />
        <span className="shrink-0 text-ui font-medium whitespace-nowrap text-fg">
          {tr('session.live.AgentTracePanel.agentActivity')}
        </span>
        {!empty && (
          <span className="min-w-0 truncate text-meta text-fg-muted tabular-nums">
            {runningCount > 0 ? (
              <span className="text-warn">{tr('trace.history.running', { n: runningCount })}</span>
            ) : part.attention.length > 0 ? (
              <span className="text-warn">{tr('trace.history.attention', { n: part.attention.length })}</span>
            ) : (
              <span className="text-success">{tr('trace.history.allDone')}</span>
            )}
            {' · '}
            {tr('trace.history.historyCount', { n: part.history.length })}
            {' · '}
            {tr('session.live.AgentTracePanel.tokensTotal', { tokens: formatCount(part.totalTokens) })}
          </span>
        )}
        <span className="flex-1" />
        {floatToggle}
        <IconButton icon={X} label={tr('session.live.AgentTracePanel.closeEsc')} onClick={onClose} />
      </header>
      <div className="selectable @container min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {focus && focused ? (
          <AgentFocus
            key={focused.agent.id}
            sessionId={sessionId}
            agent={focused.agent}
            run={focused.run}
            now={now}
            onBack={() => onFocus(null)}
          />
        ) : empty ? (
          <div className="flex flex-col items-center px-6 pt-16 text-center">
            <Bot size={28} strokeWidth={1.25} className="text-fg-faint" />
            <div className="mt-3 text-ui text-fg">{tr('session.live.AgentTracePanel.noSubagentsRunningYet')}</div>
            <p className="mt-1.5 max-w-80 text-meta text-fg-muted">
              {tr('session.live.AgentTracePanel.enableUltracodeOrAsk')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {runningCount > 0 && (
              <>
                <div className="px-0.5 text-label font-medium text-fg-muted">{tr('trace.history.sectionRunning')}</div>
                {part.running.workflows.map(w => (
                  <WorkflowSection
                    key={w.id}
                    run={w}
                    open={open[w.id] ?? true}
                    onToggle={() => setOpen(o => ({ ...o, [w.id]: !(o[w.id] ?? true) }))}
                    now={now}
                    onPick={onFocus}
                  />
                ))}
                {part.running.agents.length > 0 && (
                  <section className="rounded-xl border border-line bg-surface px-1.5 pt-2.5 pb-1.5 shadow-sm">
                    <div className="px-2 pb-2 text-ui font-medium text-fg">
                      {tr('session.live.AgentTracePanel.subagentsAgentTool')}
                    </div>
                    <ColumnHead />
                    {part.running.agents.map(a => (
                      <AgentRow
                        key={a.id}
                        a={a}
                        now={now}
                        files={agentFileCount(fileCounts, a.toolUseId, a.label)}
                        line={agentLines.get(a.id)}
                        seen={stepSeen}
                        onPick={onFocus}
                      />
                    ))}
                  </section>
                )}
              </>
            )}
            {part.attention.length > 0 && (
              <>
                <div className="px-0.5 text-label font-medium text-fg-muted">
                  {tr('trace.history.sectionAttention')}
                </div>
                {part.attention.map(e =>
                  e.kind === 'workflow' ? (
                    <WorkflowSection
                      key={`w-${e.run.id}`}
                      run={e.run}
                      unseen
                      open={open[e.run.id] ?? false}
                      onToggle={() => {
                        const w = e.run
                        // 展开时留在原地；收起就放走，已记为看过的这时才挪进历史
                        setHeld(h => {
                          const next = new Set(h)
                          if (open[w.id] ?? false) next.delete(w.id)
                          else next.add(w.id)
                          return next
                        })
                        setOpen(o => ({ ...o, [w.id]: !(o[w.id] ?? false) }))
                      }}
                      now={now}
                      onPick={onFocus}
                    />
                  ) : (
                    <section
                      key={`a-${e.run.id}`}
                      className="flex items-center gap-1 rounded-xl border border-warn/35 bg-surface px-1.5 py-1 shadow-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <AgentRow
                          a={e.run}
                          now={now}
                          files={agentFileCount(fileCounts, e.run.toolUseId, e.run.label)}
                          line={agentLines.get(e.run.id)}
                          seen={stepSeen}
                          onPick={onFocus}
                        />
                      </div>
                      <UnseenTag />
                    </section>
                  ),
                )}
              </>
            )}
            {allDone && (
              <div className="flex flex-col items-center px-6 py-6 text-center">
                <CircleCheck size={26} strokeWidth={1.5} className="text-success" />
                <div className="mt-2 text-ui text-fg">{tr('trace.history.allDone')}</div>
                <p className="mt-1 text-meta text-fg-muted">{tr('trace.history.allDoneDetail')}</p>
              </div>
            )}
            {showHistory && (
              <TraceHistory
                sessionId={sessionId}
                entries={part.history}
                clearedCount={part.clearedCount}
                onlyTurn={hist.onlyTurn}
                now={now}
                onPick={onFocus}
              />
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
