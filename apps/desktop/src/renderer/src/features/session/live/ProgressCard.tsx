import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
// 进度卡片：显示当前计划和子智能体，按对话区宽度浮着或收成顶部一条，概况开着时停靠进右栏（docs/ui/progress-card.md §4，参考 Claude 桌面版）
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Bot, Check, ChevronDown, ChevronUp, CircleSlash, PanelRight, SlidersHorizontal, Square, X } from 'lucide-react'
import { settledResizeObserver } from '@/features/panes/motion'
import type { SessionSnapshot, TodoStep } from '@pixelsky/protocol'
import { IconButton, Spinner, cn } from '@/ui'
import { elapsed, formatDuration, RUN_STATE_LABEL, shortModel, type RunState } from './agentTrace'
import {
  activeStep,
  canFoldDone,
  cardPlacement,
  currentPlan,
  NARROW_PX,
  progressAgents,
  turnKey,
  type Plan,
  type ProgressAgent,
} from './progressData'
import { activityTooltip, agentActivity, agoText } from './agentActivity'
import { useFirstSeen } from './useFirstSeen'
import { useOpenTrace } from './trace'
import { effortLabel } from '@/features/engine/labels'
import { FeatureTip } from '@/features/tips/FeatureTip'

const COLLAPSED_KEY = 'pixelsky.progress.collapsed'
/** 顶部那一条占的高度：上边距 12 + 条高 36 */
const STRIP_PX = 48
/** 全部勾完后停多久自动折叠（docs/ui/progress-card.md §11） */
const ALL_DONE_FOLD_MS = 2000

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function saveCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // 存不了就只在这次打开里有效
  }
}

export interface Progress {
  plan: Plan | null
  agents: ProgressAgent[]
  /** 这一轮说完了，子智能体还在后台跑 */
  background: boolean
  visible: boolean
  /** 引擎正在干活（state 为 running）：计划里进行中的步骤才转圈；等你批准 / 回答、空闲时画静止的橙点 */
  working: boolean
  dismiss: () => void
  /** 关掉过的卡片再显示出来（保留模式的「查看」） */
  reveal: () => void
}

/** 当前计划、子智能体和是否显示；「关闭」只在这一轮里有效 */
export function useProgress(snapshot: SessionSnapshot | null, docked = false): Progress {
  const items = snapshot?.items
  const running = !!snapshot && snapshot.state !== 'idle'
  // 这一轮说完了但后台子智能体还在跑：卡片留着显示它们（docs/ui/notifications.md §7）
  const background = !!snapshot?.background
  const plan = useMemo(() => (items ? currentPlan(items, running) : null), [items, running])
  const agents = useMemo(
    () => progressAgents(snapshot?.subagents ?? [], snapshot?.runs, items),
    [snapshot?.subagents, snapshot?.runs, items],
  )
  const key = `${snapshot?.record.id ?? ''}:${items ? turnKey(items) : ''}`
  const [dismissed, setDismissed] = useState<string | null>(null)
  const dismiss = useCallback(() => setDismissed(key), [key])
  const reveal = useCallback(() => setDismissed(null), [])
  // 只在运行中显示：空闲时计划和子智能体都在这一轮收起的执行块里（docs/ui/conversation-concise.md §3 F）
  return {
    plan,
    agents,
    background: background && !running,
    working: snapshot?.state === 'running',
    // 停靠的卡片没有 ✕：这一轮关掉过的到概况里也看得到，离开概况还是关着
    visible:
      (docked || dismissed !== key) &&
      ((running && (!!plan || agents.length > 0)) || (background && agents.length > 0)),
    dismiss,
    reveal,
  }
}

/**
 * 步骤前的圆圈：完成绿底打勾、进行中橙色转圈（和侧边栏、底部状态行同一个 Spinner）、未开始空心。
 * live 为假（历史里的待办快照）时进行中只画一个不动的橙点，不然已经结束的一轮里会有个转圈一直转
 */
export function StepMark({ status, live = true }: { status: TodoStep['status']; live?: boolean }) {
  return (
    <span
      className={cn(
        'mt-[3px] inline-flex size-[14px] shrink-0 items-center justify-center rounded-full',
        status === 'completed' && 'border border-success bg-success text-surface',
        status === 'in_progress' && !live && 'border border-active',
        status === 'pending' && 'border border-line-strong',
      )}
    >
      {status === 'completed' && <Check size={10} strokeWidth={3} />}
      {status === 'in_progress' && live && <Spinner size={11} className="text-active!" />}
      {status === 'in_progress' && !live && <span className="size-1.5 rounded-full bg-active" />}
    </span>
  )
}

function StateIcon({ state }: { state: RunState }) {
  if (state === 'running') return <span className="mt-[6px] size-[7px] shrink-0 animate-pulse rounded-full bg-active" />
  if (state === 'done') return <Check size={12} strokeWidth={2} className="mt-[3px] shrink-0 text-success" />
  if (state === 'failed') return <X size={12} strokeWidth={2} className="mt-[3px] shrink-0 text-danger" />
  if (state === 'stopped') return <span className="mt-[3px] size-3 shrink-0 rounded-[3px] bg-fg-faint" />
  return <CircleSlash size={12} strokeWidth={1.75} className="mt-[3px] shrink-0 text-fg-muted" />
}

/** 运行中的子智能体每秒刷新已用时间 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

function summary(plan: Plan | null, agents: ProgressAgent[], finished: boolean): string {
  const parts: string[] = []
  if (plan)
    parts.push(
      finished
        ? tr('session.progress.allDone', { total: plan.steps.length })
        : tr('session.progress.steps', { done: plan.done, total: plan.steps.length }),
    )
  const running = agents.filter(a => a.state === 'running').length
  if (running > 0) parts.push(tr('session.progress.agentsRunning', { n: running }))
  else if (agents.length > 0) parts.push(tr('session.progress.agents', { n: agents.length }))
  const stopped = agents.filter(a => a.state === 'stopped').length
  if (running > 0 && stopped > 0) parts.push(tr('subagentStop.stoppedCount', { n: stopped }))
  return parts.join(' · ')
}

function Steps({ plan, working }: { plan: Plan; working: boolean }) {
  const { steps } = plan
  const list = useRef<HTMLOListElement>(null)
  const active = activeStep(steps)
  const [doneOpen, setDoneOpen] = useState(false)
  const foldable = canFoldDone(plan)
  const folded = foldable && !doneOpen
  // 当前步骤变了：只滚动步骤列表本身，不带动对话流
  useLayoutEffect(() => {
    const el = list.current
    const row = el?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!el || !row) return
    if (row.offsetTop < el.scrollTop || row.offsetTop + row.offsetHeight > el.scrollTop + el.clientHeight)
      el.scrollTop = row.offsetTop - (el.clientHeight - row.offsetHeight) / 2
  }, [active, steps.length, folded])
  return (
    <ol ref={list} className="relative flex max-h-[15.5rem] flex-col overflow-y-auto px-1.5">
      {foldable && (
        <li>
          <button
            type="button"
            aria-expanded={doneOpen}
            title={tr(doneOpen ? 'session.progress.doneHide' : 'session.progress.doneShow')}
            onClick={() => setDoneOpen(!doneOpen)}
            className="press flex w-full items-start gap-2 rounded-md px-1.5 py-[3px] text-left text-list text-fg-muted hover:bg-hover"
          >
            <StepMark status="completed" />
            <span className="min-w-0 flex-1">{tr('session.progress.doneFolded', { n: plan.done })}</span>
            {doneOpen ? (
              <ChevronUp size={14} strokeWidth={1.5} className="mt-[3px] shrink-0" />
            ) : (
              <ChevronDown size={14} strokeWidth={1.5} className="mt-[3px] shrink-0" />
            )}
          </button>
        </li>
      )}
      {steps.map((s, i) => {
        if (folded && s.status === 'completed') return null
        return (
          <li
            key={i}
            aria-current={i === active ? 'step' : undefined}
            className={cn(
              'flex items-start gap-2 rounded-md px-1.5 py-[3px] text-list',
              i === active && 'bg-accent-soft',
            )}
          >
            <StepMark status={s.status} live={working} />
            <span
              className={cn(
                'min-w-0 break-words',
                s.status === 'completed' ? 'text-fg-muted' : 'text-fg',
                i === active && 'font-medium',
              )}
            >
              {s.text}
            </span>
          </li>
        )
      })}
      {plan.carried?.map((s, i) => (
        <li key={`carried-${i}`} className="flex items-start gap-2 rounded-md px-1.5 py-[3px] text-list">
          {/* 停下时可能还是进行中：这里不再标，免得看着像正在做 */}
          <StepMark status="pending" />
          <span className="min-w-0 break-words text-fg-muted">
            {s.text}
            <span className="ml-1.5 rounded-sm bg-warn/12 px-1 text-meta whitespace-nowrap text-warn">
              {tr('session.progress.carried')}
            </span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function Agents({
  agents,
  divided,
  onStop,
}: {
  agents: ProgressAgent[]
  divided: boolean
  onStop?: (ids: string[]) => Promise<string[]>
}) {
  const openTrace = useOpenTrace()
  const now = useNow(agents.some(a => a.state === 'running'))
  const seen = useFirstSeen()
  const [stopping, setStopping] = useState<Set<string>>(() => new Set())
  const stop = (ids: string[]): void => {
    setStopping(s => new Set([...s, ...ids]))
    void onStop?.(ids).then(failed => {
      if (failed.length > 0) setStopping(s => new Set([...s].filter(id => !failed.includes(id))))
    })
  }
  const running = agents.filter(a => a.state === 'running' && a.background && !stopping.has(a.id)).map(a => a.id)
  return (
    <div className={cn('px-1.5', divided && 'mt-1.5 border-t border-line-subtle pt-1.5')}>
      <div className="flex items-center justify-between px-1.5 pb-0.5 text-meta text-fg-faint">
        <span>
          {tr('session.progress.subagents')} <span className="tabular-nums">{agents.length}</span>
        </span>
        {onStop && running.length > 0 && (
          <button
            type="button"
            onClick={() => stop(running)}
            className="press inline-flex items-center gap-1 rounded px-1 text-danger hover:bg-hover"
          >
            <Square size={9} strokeWidth={0} fill="currentColor" />
            {tr('subagentStop.stopAll')}
          </button>
        )}
      </div>
      <ul className="flex max-h-[11rem] flex-col overflow-y-auto">
        {agents.map(a => {
          const time = elapsed(a, a.state, now)
          return (
            <li key={a.id} className="group relative flex items-start">
              <button
                type="button"
                onClick={() => openTrace?.({ agentId: a.id })}
                title={tr('session.live.SessionStrips.viewSubagentConversation')}
                className={cn(
                  'press flex min-w-0 flex-1 items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-hover',
                  onStop && a.state === 'running' && a.background && 'pr-8',
                )}
              >
                <StateIcon state={a.state} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5 text-list">
                    {/* 任务名优先：模型名、类型限宽、先缩到三个字宽，长了各自省略（GitHub #38） */}
                    <span className="min-w-0 truncate text-fg">{a.label}</span>
                    {a.model && (
                      <span
                        title={a.model}
                        className="max-w-[35%] min-w-[3em] shrink-[10] truncate text-meta text-fg-faint"
                      >
                        {shortModel(a.model)}
                        {a.effort && ` · ${effortLabel(a.effort)}`}
                      </span>
                    )}
                    {a.type && (
                      <span className="max-w-[30%] min-w-[3em] shrink-[10] truncate rounded-sm border border-line px-1 text-meta leading-[1.4] text-fg-muted">
                        {a.type}
                      </span>
                    )}
                    <span className="flex-1" />
                    {a.state === 'stopped' ? (
                      <span className="shrink-0 text-meta text-fg-faint">{RUN_STATE_LABEL.stopped}</span>
                    ) : (
                      time > 0 && (
                        <span className="shrink-0 text-meta text-fg-faint tabular-nums">{formatDuration(time)}</span>
                      )
                    )}
                  </span>
                  <ActivityLine agent={a} now={now} seen={seen} />
                </span>
              </button>
              {onStop && a.state === 'running' && a.background && (
                <button
                  type="button"
                  aria-label={tr('subagentStop.stopOne')}
                  title={tr('subagentStop.stopOne')}
                  disabled={stopping.has(a.id)}
                  onClick={() => stop([a.id])}
                  className="press absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded bg-danger/10 text-danger opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-40"
                >
                  <Square size={9} strokeWidth={0} fill="currentColor" />
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 子智能体下面那一行「正在做什么」（agentActivity.ts）；悬停看完整的一句和最近 3 步 */
function ActivityLine({ agent, now, seen }: { agent: ProgressAgent; now: number; seen: (id: string) => number }) {
  useI18n()
  const line = agentActivity(agent, agent.steps)
  if (!line) return null
  return (
    <span
      data-activity={line.kind}
      title={activityTooltip(line, agent.steps, seen, now)}
      className={cn(
        'truncate text-meta',
        line.kind === 'failed' ? 'text-danger' : line.kind === 'task' ? 'text-fg-faint' : 'text-fg-muted',
      )}
    >
      {line.text}
      {line.kind === 'step' && line.stepId && (
        <span className="text-fg-faint tabular-nums"> · {agoText(now - seen(line.stepId))}</span>
      )}
    </span>
  )
}

export function ProgressCard({
  progress,
  belowFind,
  offset = 0,
  onOpenTrace,
  onStopAgents,
  expandToken,
  expandSeen,
  docked = false,
  onDock,
  onConfigure,
  overrideCount = 0,
}: {
  progress: Progress
  /** 对话内搜索条打开着：卡片挪到搜索条下面 */
  belowFind?: boolean
  /** 上面后台任务条的高度：卡片放到任务条下面，不盖住「输出 / 停止」 */
  offset?: number
  onOpenTrace?: () => void
  /** 停一个或几个子智能体；引擎没有后台任务能力时不传，界面不出停止按钮 */
  onStopAgents?: (ids: string[]) => Promise<string[]>
  /** 变一次就把卡片展开（保留模式的「查看」） */
  expandToken?: number
  /** 用过的 expandToken：卡片每轮重新挂载，记在外层，旧的不会再展开一次 */
  expandSeen?: RefObject<number>
  /** 停靠在概况里（portal 进右栏）：不量宽度、不浮着，没有 ✕ 和停靠按钮，收起不存偏好 */
  docked?: boolean
  /** 点了去概况；不传时不显示按钮（代码模式没有概况） */
  onDock?: () => void
  onConfigure?: () => void
  overrideCount?: number
}) {
  useI18n()
  const probe = useRef<HTMLSpanElement>(null)
  const card = useRef<HTMLElement>(null)
  const stripBox = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [peek, setPeek] = useState(false)
  // 变宽了就不再是临时盖住：不留着，免得下次变窄时自己弹出来
  if (peek && !narrow) setPeek(false)
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null)
  const [stored] = useState(readCollapsed)
  // 量对话区（卡片的定位容器）的宽度。条和卡片都可能不在，量的是总在的 probe 的父元素
  useLayoutEffect(() => {
    const box = probe.current?.parentElement
    // 停靠时父元素是右栏，比阈值窄是常态，不能算窄。进出停靠都会重新挂载，narrow 从 false 开始
    if (!box || docked) return
    const measure = (): void => {
      // 隐藏的标签、右栏最大化时可能量到 0：留着上一次的
      if (box.clientWidth > 0) setNarrow(box.clientWidth < NARROW_PX)
    }
    measure()
    const ro = settledResizeObserver(measure)
    ro.observe(box)
    return () => ro.disconnect()
  }, [docked])
  const { plan, agents } = progress
  // 全部勾完、它还在写总结：停一会儿自动折叠，不存成偏好；这份计划手动动过卡片就不管了；换一份计划自然展开
  const allDone = !!plan && plan.done === plan.steps.length
  const agentRunning = agents.some(a => a.state === 'running')
  const planId = plan?.id ?? null
  const [foldedPlan, setFoldedPlan] = useState<string | null>(null)
  const keptOpen = useRef<string | null>(null)
  const autoFolded = allDone && !agentRunning && foldedPlan === planId
  useEffect(() => {
    if (!allDone || agentRunning || keptOpen.current === planId) return
    const timer = window.setTimeout(() => {
      // 等的这 2 秒里手动动过卡片：听用户的
      if (keptOpen.current !== planId) setFoldedPlan(planId)
    }, ALL_DONE_FOLD_MS)
    return () => window.clearTimeout(timer)
  }, [allDone, agentRunning, planId])
  useEffect(() => {
    if (!expandToken || !expandSeen || expandSeen.current === expandToken) return
    expandSeen.current = expandToken
    setUserCollapsed(false)
    setFoldedPlan(null)
    keptOpen.current = planId
    setPeek(true)
    // 只在「查看」时：换计划不算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandToken])
  // 存的偏好管的是对话区里的卡片；概况本来就是来看它的，停靠时默认展开
  const preferCollapsed = userCollapsed ?? (!docked && stored)
  const collapsed = autoFolded || preferCollapsed
  const { strip, card: placed } = cardPlacement({ docked, narrow, collapsed, peek })
  const over = placed === 'over'
  // 临时盖住的卡片点别处收回。条要算在里面，不然点条上的按钮会先收回、再被 click 打开。不接 Esc：输入框里 Esc 是停止这一轮
  useEffect(() => {
    if (!over) return
    const down = (e: PointerEvent): void => {
      const target = e.target as Element
      // 卡片里弹出的层（功能提示）画在 body 上，点它不算点别处
      if (!card.current?.contains(target) && !stripBox.current?.contains(target) && !target.closest?.('[data-popover]'))
        setPeek(false)
    }
    document.addEventListener('pointerdown', down, true)
    return () => document.removeEventListener('pointerdown', down, true)
  }, [over])
  const toggle = (): void => {
    keptOpen.current = planId
    setFoldedPlan(null)
    // 窄的时候只是临时看一眼，不动偏好
    if (narrow) {
      setPeek(!peek)
      return
    }
    // 只是自动折叠的：去掉就展开了，不动偏好。本来就想折叠（存过）时往下走，一次点击就展开
    if (autoFolded && !preferCollapsed) return
    setUserCollapsed(!collapsed)
    if (!docked) saveCollapsed(!collapsed)
  }
  const open = over || (placed !== null && !collapsed)
  const finished = !open && allDone
  const step = plan ? plan.steps[activeStep(plan.steps)] : undefined
  const current = open ? undefined : step
  const chevron = (
    <IconButton
      icon={open ? ChevronUp : ChevronDown}
      label={tr(open ? 'session.progress.collapse' : 'session.progress.expand')}
      aria-expanded={open}
      size={24}
      iconSize={14}
      onClick={toggle}
    />
  )
  const dismiss = !docked && (
    <IconButton icon={X} label={tr('session.progress.dismiss')} size={24} iconSize={14} onClick={progress.dismiss} />
  )
  const dock = !docked && onDock && (
    <IconButton icon={PanelRight} label={tr('overview.dock')} size={24} iconSize={14} onClick={onDock} />
  )
  const configure = onConfigure && (
    <IconButton
      icon={SlidersHorizontal}
      label={tr('subagentRoute.session.title')}
      size={24}
      iconSize={14}
      onClick={onConfigure}
    />
  )
  return (
    <>
      <span ref={probe} hidden />
      {strip && (
        <div
          ref={stripBox}
          data-progress-strip
          className="conversation-inset conversation-reading conversation-reading-strips shrink-0 pt-3"
        >
          <div className="conversation-message flex h-9 items-center gap-2 rounded-lg border border-line bg-popover pr-1.5 pl-3 whitespace-nowrap">
            <span className="text-list font-medium text-fg">{tr('session.progress.title')}</span>
            {/* 有当前步骤时，特别窄就让给它（conversation.css）；没有时这一句是唯一的信息，一直留着 */}
            <span
              data-progress-sum={step ? '' : undefined}
              className={cn('min-w-0 truncate text-meta tabular-nums', allDone ? 'text-success' : 'text-fg-muted')}
            >
              {summary(plan, agents, allDone)}
            </span>
            {step ? (
              <div className="flex min-w-0 flex-1 items-start gap-1.5 rounded-sm bg-accent-soft px-1.5 py-px text-list font-medium text-fg">
                <StepMark status="in_progress" live={progress.working} />
                <span title={step.text} className="min-w-0 truncate">
                  {step.text}
                </span>
              </div>
            ) : (
              <span className="flex-1" />
            )}
            <span className="flex shrink-0 items-center gap-1">
              {configure}
              {dock}
              {chevron}
              {dismiss}
            </span>
          </div>
        </div>
      )}
      {placed && (
        <section
          ref={card}
          data-progress-float={placed === 'float' ? '' : undefined}
          aria-label={tr('session.progress.title')}
          style={
            docked
              ? undefined
              : { top: over ? STRIP_PX + offset + (belowFind ? 52 : 8) : (belowFind ? 56 : 12) + offset }
          }
          className={cn(
            'flex flex-col py-2',
            docked
              ? 'rounded-lg border border-line-card bg-surface'
              : cn(
                  'pop-in absolute z-20 max-h-[60%] w-[min(22rem,calc(100%-2rem))] rounded-xl border border-line bg-popover shadow-popover',
                  over ? 'right-4' : 'right-5',
                ),
          )}
        >
          <div className="flex items-center gap-1 pr-1.5 pl-3">
            <span className="text-list font-medium text-fg">{tr('session.progress.title')}</span>
            {progress.background && (
              <span className="ml-1 truncate text-meta text-fg-muted">{tr('session.progress.background')}</span>
            )}
            <span className="flex-1" />
            {dock}
            {configure}
            {onOpenTrace && (
              <IconButton
                icon={Bot}
                label={tr('session.live.AgentTracePanel.agentActivity')}
                size={24}
                iconSize={14}
                onClick={onOpenTrace}
              />
            )}
            {chevron}
            {dismiss}
          </div>
          <div className={cn('px-3 pb-1 text-meta tabular-nums', finished ? 'text-success' : 'text-fg-muted')}>
            {summary(plan, agents, finished)}
          </div>
          {current && (
            <div className="mx-1.5 flex items-start gap-2 rounded-md bg-accent-soft px-1.5 py-[3px] text-list font-medium text-fg">
              <StepMark status="in_progress" live={progress.working} />
              <span title={current.text} className="min-w-0 truncate">
                {current.text}
              </span>
            </div>
          )}
          {open && (
            <div className="flex min-h-0 flex-col overflow-y-auto">
              {plan && <Steps key={plan.id} plan={plan} working={progress.working} />}
              {agents.length > 0 && <Agents agents={agents} divided={!!plan} onStop={onStopAgents} />}
            </div>
          )}
          {onConfigure && open && (
            <div className="mx-3 mt-2 flex items-center gap-1">
              <button
                type="button"
                onClick={onConfigure}
                className="rounded-sm py-1 text-left text-meta text-accent-fg hover:bg-hover"
              >
                {tr(overrideCount ? 'subagentRoute.session.overridden' : 'subagentRoute.session.title', {
                  n: overrideCount,
                })}
              </button>
              <FeatureTip id="subagent" />
            </div>
          )}
        </section>
      )}
    </>
  )
}
