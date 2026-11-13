// 概况最上面（不跟着滚动，D274）：会话标题和状态胶囊，下面一行「正在」——等审批（橙底，「去看看」）、运行中的当前步骤和分段进度、
// 空闲时上一轮的结果
import { useMemo, useRef } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import type { ApprovalRequest, TodoStep } from '@pixelsky/protocol'
import { cn, Spinner } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { useEngineState } from '@/features/engine'
import { formatDuration } from '@/features/session/live/agentTrace'
import { locateApproval } from '@/features/session/live/approvals/focus'
import { activeStep, currentPlan } from '@/features/session/live/progressData'
import { useSessionRecord } from './overviewData'
import { approvalItem, lastTurnDuration } from './overviewModel'
import { Pill } from './Section'

const NO_PENDING: ApprovalRequest[] = []
/** 步骤多于这些就不画分段，只写 2/12 */
const MAX_SEGMENTS = 8

const CHIP = 'ml-auto inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-meta whitespace-nowrap'
const LINE = 'mt-1 flex min-h-[38px] items-center gap-[9px] rounded-full pr-1.5 pl-3'

interface NowStep {
  text: string
  statuses: TodoStep['status'][]
  done: number
}

/** 运行中的当前步骤。items 每来一个字都变：算出来的一样就返回上一份，不重新渲染 */
function useNowStep(sessionId: string): NowStep | null {
  const kept = useRef<NowStep | null>(null)
  return useEngineState(s => {
    const snap = s.snapshots[sessionId]
    const plan = snap && snap.state !== 'idle' ? currentPlan(snap.items, true) : null
    const step = plan?.steps[activeStep(plan.steps)]
    const next = plan && step ? { text: step.text, statuses: plan.steps.map(x => x.status), done: plan.done } : null
    const prev = kept.current
    if (prev && next && prev.text === next.text && prev.statuses.join() === next.statuses.join()) return prev
    return (kept.current = next)
  })
}

export function SessionHead({ sessionId, fresh }: { sessionId: string; fresh: boolean }) {
  useI18n()
  const record = useSessionRecord(sessionId, true)
  const state = useEngineState(s => s.snapshots[sessionId]?.state ?? 'idle')
  const pending = useEngineState(s => s.snapshots[sessionId]?.pending) ?? NO_PENDING
  const step = useNowStep(sessionId)
  // items 运行中每来一个字都变：只在空闲时取，算上一轮
  const items = useEngineState(s => (s.snapshots[sessionId]?.state === 'idle' ? s.snapshots[sessionId]?.items : null))
  const last = useMemo(() => {
    if (!items) return null
    const plan = currentPlan(items, false)
    const parts = [
      plan &&
        (plan.done === plan.steps.length
          ? tr('session.progress.allDone', { total: plan.steps.length })
          : tr('session.progress.steps', { done: plan.done, total: plan.steps.length })),
      lastTurnDuration(items) > 0 && formatDuration(lastTurnDuration(items)),
    ].filter(Boolean)
    return parts.length ? { text: parts.join(' · '), allDone: !!plan && plan.done === plan.steps.length } : null
  }, [items])
  const approval = approvalItem(pending, record?.cwd ?? null)
  const running = state !== 'idle'
  const chip = approval ? (
    <span className={cn(CHIP, 'bg-warn/18 text-warn-fg')}>
      <TriangleAlert size={13} strokeWidth={1.6} />
      {tr('overview.stateWaiting')}
    </span>
  ) : running ? (
    <span className={cn(CHIP, 'bg-ov-chip text-fg-secondary')}>
      <Spinner size={12} />
      {tr('overview.stateRunning')}
    </span>
  ) : fresh ? (
    <span className={cn(CHIP, 'bg-ov-chip text-fg-secondary')}>{tr('overview.stateNew')}</span>
  ) : (
    <span className={cn(CHIP, 'bg-success/14 text-success')}>
      <Check size={13} strokeWidth={1.8} />
      {tr('overview.stateIdle')}
    </span>
  )
  const action = approval?.action?.kind === 'approval' ? approval.action : null
  return (
    <div data-overview-head-state={approval ? 'waiting' : state} className="shrink-0 px-2.5 pt-0.5 pb-2">
      <div className="flex min-h-[30px] items-center gap-2 px-1.5">
        <span title={record?.title} className="min-w-0 truncate text-prose font-semibold text-fg">
          {record?.title}
        </span>
        {chip}
      </div>
      {approval ? (
        <div data-overview-now="approval" className={cn(LINE, 'bg-ov-warn text-fg')}>
          <TriangleAlert size={15} strokeWidth={1.6} className="shrink-0 text-warn-fg" />
          <span title={approval.sub ?? approval.text} className="min-w-0 flex-1 truncate font-medium">
            {approval.text}
          </span>
          {action && (
            <Pill tone="warn" onClick={() => locateApproval(sessionId, action.requestId)}>
              {tr('overview.attentionLocate')}
            </Pill>
          )}
        </div>
      ) : running && step ? (
        <div data-overview-now="step" className={cn(LINE, 'bg-accent-soft text-fg')}>
          <Spinner size={13} />
          <span title={step.text} className="min-w-0 flex-1 truncate font-medium">
            {step.text}
          </span>
          <span
            aria-label={tr('session.progress.steps', { done: step.done, total: step.statuses.length })}
            className="flex shrink-0 items-center gap-[3px] pr-1.5"
          >
            {step.statuses.length <= MAX_SEGMENTS &&
              step.statuses.map((s, i) => (
                <i
                  key={i}
                  className={cn(
                    'h-1.5 w-3 rounded-full',
                    s === 'completed' ? 'bg-success' : s === 'in_progress' ? 'bg-active' : 'bg-ov-track',
                  )}
                />
              ))}
            <b className="ml-1 text-meta font-medium text-fg-secondary tabular-nums">
              {step.done}/{step.statuses.length}
            </b>
          </span>
        </div>
      ) : (
        !running &&
        last && (
          <div data-overview-now="last" className={cn(LINE, 'bg-ov-card text-fg-secondary')}>
            {last.allDone && (
              <span className="grid size-[15px] shrink-0 place-items-center rounded-full bg-success text-(--bg-workbench)">
                <Check size={10} strokeWidth={2.6} />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">
              <small className="mr-1 text-meta text-fg-muted">{tr('overview.lastTurn')}</small>
              {last.text}
            </span>
          </div>
        )
      )}
    </div>
  )
}
