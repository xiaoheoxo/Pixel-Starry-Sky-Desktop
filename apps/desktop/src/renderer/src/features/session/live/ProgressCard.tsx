import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
// 进度卡片：浮在对话区右上角，显示当前计划和子智能体（docs/ui/progress-card.md，参考 Claude 桌面版）
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, ChevronUp, CircleSlash, Square, X } from 'lucide-react'
import { settledResizeObserver } from '@/features/panes/motion'
import type { SessionSnapshot, TodoStep } from '@pixelsky/protocol'
import { IconButton, Spinner, cn } from '@/ui'
import { elapsed, formatDuration, RUN_STATE_LABEL, shortModel, type RunState } from './agentTrace'
import { activeStep, currentPlan, progressAgents, turnKey, type Plan, type ProgressAgent } from './progressData'
import { activityTooltip, agentActivity, agoText } from './agentActivity'
import { useFirstSeen } from './useFirstSeen'
import { useOpenTrace } from './trace'

const COLLAPSED_KEY = 'pixelsky.progress.collapsed'
/** 对话区比这窄时默认折叠 */
const NARROW_PX = 640

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
export function useProgress(snapshot: SessionSnapshot | null): Progress {
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
    visible: dismissed !== key && ((running && (!!plan || agents.length > 0)) || (background && agents.length > 0)),
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

function summary(plan: Plan | null, agents: ProgressAgent[]): string {
  const parts: string[] = []
  if (plan) parts.push(tr('session.progress.steps', { done: plan.done, total: plan.steps.length }))
  const running = agents.filter(a => a.state === 'running').length
  if (running > 0) parts.push(tr('session.progress.agentsRunning', { n: running }))
  else if (agents.length > 0) parts.push(tr('session.progress.agents', { n: agents.length }))
  const stopped = agents.filter(a => a.state === 'stopped').length
  if (running > 0 && stopped > 0) parts.push(tr('subagentStop.stoppedCount', { n: stopped }))
  return parts.join(' · ')
}

function Steps({ steps, working }: { steps: TodoStep[]; working: boolean }) {
  const list = useRef<HTMLOListElement>(null)
  const active = activeStep(steps)
  // 当前步骤变了：只滚动步骤列表本身，不带动对话流
  useLayoutEffect(() => {
    const el = list.current
    const row = active >= 0 ? (el?.children[active] as HTMLElement | undefined) : undefined
    if (!el || !row) return
    if (row.offsetTop < el.scrollTop || row.offsetTop + row.offsetHeight > el.scrollTop + el.clientHeight)
      el.scrollTop = row.offsetTop - (el.clientHeight - row.offsetHeight) / 2
  }, [active, steps.length])
  return (
    <ol ref={list} className="relative flex max-h-[15.5rem] flex-col overflow-y-auto px-1.5">
      {steps.map((s, i) => (
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
}) {
  useI18n()
  const card = useRef<HTMLElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null)
  const [stored] = useState(readCollapsed)
  // 量对话区（卡片的定位容器）的宽度：窄窗格默认折叠
  useLayoutEffect(() => {
    const box = card.current?.parentElement
    if (!box) return
    const measure = (): void => setNarrow(box.clientWidth < NARROW_PX)
    measure()
    const ro = settledResizeObserver(measure)
    ro.observe(box)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (expandToken) setUserCollapsed(false)
  }, [expandToken])
  const collapsed = userCollapsed ?? (stored || narrow)
  const toggle = (): void => {
    setUserCollapsed(!collapsed)
    saveCollapsed(!collapsed)
  }
  const { plan, agents } = progress
  return (
    <section
      ref={card}
      aria-label={tr('session.progress.title')}
      style={{ top: (belowFind ? 56 : 12) + offset }}
      className={cn(
        'pop-in absolute right-5 z-20',
        'flex max-h-[60%] w-[min(22rem,calc(100%-2rem))] flex-col rounded-xl border border-line bg-popover py-2 shadow-popover',
      )}
    >
      <div className="flex items-center gap-1 pr-1.5 pl-3">
        <span className="text-list font-medium text-fg">{tr('session.progress.title')}</span>
        {progress.background && (
          <span className="ml-1 truncate text-meta text-fg-muted">{tr('session.progress.background')}</span>
        )}
        <span className="flex-1" />
        {onOpenTrace && (
          <IconButton
            icon={Bot}
            label={tr('session.live.AgentTracePanel.agentActivity')}
            size={24}
            iconSize={14}
            onClick={onOpenTrace}
          />
        )}
        <IconButton
          icon={collapsed ? ChevronDown : ChevronUp}
          label={tr(collapsed ? 'session.progress.expand' : 'session.progress.collapse')}
          aria-expanded={!collapsed}
          size={24}
          iconSize={14}
          onClick={toggle}
        />
        <IconButton
          icon={X}
          label={tr('session.progress.dismiss')}
          size={24}
          iconSize={14}
          onClick={progress.dismiss}
        />
      </div>
      <div className="px-3 pb-1 text-meta text-fg-muted tabular-nums">{summary(plan, agents)}</div>
      {!collapsed && (
        <div className="flex min-h-0 flex-col overflow-y-auto">
          {plan && <Steps steps={plan.steps} working={progress.working} />}
          {agents.length > 0 && <Agents agents={agents} divided={!!plan} onStop={onStopAgents} />}
        </div>
      )}
    </section>
  )
}
