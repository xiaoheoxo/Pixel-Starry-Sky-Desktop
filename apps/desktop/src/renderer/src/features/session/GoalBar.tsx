import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Pause, Play, Target, X } from 'lucide-react'
import type { EngineId, GoalAction, GoalStatus, SessionGoal } from '@pixelsky/protocol'
import { Button, IconButton, Spinner, cn } from '@/ui'
import { useEngineState } from '@/features/engine/store'
import { formatDuration, formatTime, formatTokens } from '@/features/usage/format'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage, type TranslationKey } from '../../i18n/core'
import { StepMark } from './live/ProgressCard'
import { currentPlan } from './live/progressData'

const STATUS_KEY = {
  active: 'goal.status.active',
  paused: 'goal.status.paused',
  blocked: 'goal.status.blocked',
  usageLimited: 'goal.status.usageLimited',
  budgetLimited: 'goal.status.budgetLimited',
  complete: 'goal.status.complete',
} as const satisfies Record<GoalStatus, string>

export const goalStatusText = (status: GoalStatus): string => tr(STATUS_KEY[status])

/** 状态点的颜色：进行中强调色，卡住 / 用完警告色，完成成功色，暂停灰 */
const DOT: Record<GoalStatus, string> = {
  active: 'bg-accent',
  paused: 'bg-fg-faint',
  blocked: 'bg-warn',
  usageLimited: 'bg-warn',
  budgetLimited: 'bg-warn',
  complete: 'bg-success',
}

const SHOW_KEY = {
  active: 'goal.native.showActive',
  paused: 'goal.native.showPaused',
  blocked: 'goal.native.showBlocked',
  usageLimited: 'goal.native.showUsageLimited',
  budgetLimited: 'goal.native.showBudgetLimited',
  complete: 'goal.native.showComplete',
} as const satisfies Record<GoalStatus, string>

/** 卡住、额度或预算用完时展开区底下说下一步怎么办 */
const HINT_KEY: Partial<Record<GoalStatus, TranslationKey>> = {
  blocked: 'goal.bar.hint.blocked',
  usageLimited: 'goal.bar.hint.usageLimited',
  budgetLimited: 'goal.bar.hint.budgetLimited',
}

/** 输入框里的 /goal 直接生效后的提示（和进程没在跑时引擎在对话里说的同一句） */
export function goalResultText(action: GoalAction, goal: SessionGoal | null, engine: EngineId = 'codex'): string {
  if (action.kind === 'set')
    return tr(engine === 'pixel' ? 'goal.native.setPixel' : 'goal.native.set', { p0: action.objective })
  if (action.kind === 'pause') return tr('goal.native.paused')
  if (action.kind === 'resume') return tr('goal.native.resumed')
  if (action.kind === 'clear') return tr('goal.native.cleared')
  return goal ? tr(SHOW_KEY[goal.status], { p0: goal.objective }) : tr('goal.native.none')
}

/** 已用 token（有预算时带上预算）· 用时 */
export function goalUsageText(goal: SessionGoal): string {
  const used = formatTokens(goal.tokensUsed)
  const tokens =
    goal.tokenBudget === null
      ? tr('goal.bar.tokens', { used })
      : tr('goal.bar.tokensBudget', { used, budget: formatTokens(goal.tokenBudget) })
  return goal.timeUsedSeconds > 0
    ? `${tokens} · ${tr('goal.bar.time', { time: formatDuration(goal.timeUsedSeconds * 1000) })}`
    : tokens
}

/** 展开区的四格：状态、已用 token（有预算时带比例，画进度条）、用时、最后更新 */
export function goalStats(goal: SessionGoal): { label: string; value: string; warn?: boolean; share?: number }[] {
  const used = formatTokens(goal.tokensUsed)
  const budget = goal.tokenBudget
  return [
    { label: tr('goal.bar.statStatus'), value: goalStatusText(goal.status), warn: !!HINT_KEY[goal.status] },
    budget === null
      ? { label: tr('goal.bar.statTokens'), value: tr('goal.bar.statNoBudget', { used }) }
      : {
          label: tr('goal.bar.statTokens'),
          value: `${used} / ${formatTokens(budget)}`,
          share: budget > 0 ? Math.min(1, goal.tokensUsed / budget) : 1,
        },
    { label: tr('goal.bar.statTime'), value: formatDuration(goal.timeUsedSeconds * 1000) },
    { label: tr('goal.bar.statUpdated'), value: goal.updatedAt > 0 ? formatTime(goal.updatedAt) : '—' },
  ]
}

/**
 * 输入框上方的目标栏（Codex / Pixel）：会话有目标时显示目标、状态、用量，
 * 点这一行展开看完整目标、用量明细和当前计划，能就地改目标。按钮马上生效（不排队）。
 * onAction 返回 null 表示引擎进程不在了（目标也就跟着没了）
 */
export function GoalBar({
  sessionId,
  onAction,
}: {
  sessionId: string | null
  onAction: (action: GoalAction) => Promise<unknown>
}) {
  useI18n()
  const goal = useEngineState(s => (sessionId ? (s.snapshots[sessionId]?.goal ?? null) : null))
  const engine = useEngineState(s => (sessionId ? s.snapshots[sessionId]?.record?.engine : undefined))
  const items = useEngineState(s => (sessionId ? s.snapshots[sessionId]?.items : undefined))
  const [busy, setBusy] = useState<GoalAction['kind'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 记下展开的是哪个会话：换会话时自然收起
  const [openFor, setOpenFor] = useState<string | null>(null)
  // 正在改的目标文字；null 表示没在改
  const [draft, setDraft] = useState<string | null>(null)
  const [draftBudget, setDraftBudget] = useState('')
  // 目标暂停、引擎空闲时没做完的计划也算当前计划
  const plan = useMemo(() => (items ? currentPlan(items, true) : null), [items])
  const toggleRef = useRef<HTMLButtonElement>(null)
  // 目标没了（清除、进程退出）组件还在：收起并丢掉草稿，下一个目标出来时不带着旧的编辑框
  useEffect(() => {
    if (goal) return
    setOpenFor(null)
    setDraft(null)
  }, [goal])
  if (!goal) return null
  const open = !!sessionId && openFor === sessionId
  const act = async (action: GoalAction): Promise<boolean> => {
    if (busy) return false
    setBusy(action.kind)
    setError(null)
    try {
      // null：进程不在或下一条换了引擎，没改成
      if ((await onAction(action)) === null) {
        setError(tr('errors.engine.goalNoProcess'))
        return false
      }
      return true
    } catch (err) {
      setError(translateMessage((err as Error).message))
      return false
    } finally {
      setBusy(null)
    }
  }
  const toggle = (): void => {
    setOpenFor(open ? null : sessionId)
    setDraft(null)
  }
  // 编辑框关掉后焦点回到这一行，键盘用户不用从头 Tab
  const closeEditor = (): void => {
    setDraft(null)
    toggleRef.current?.focus()
  }
  const edit = (): void => {
    setOpenFor(sessionId)
    setDraft(goal.objective)
    setDraftBudget(goal.tokenBudget?.toString() ?? '')
  }
  const save = async (): Promise<void> => {
    const objective = draft?.trim()
    if (!objective) return
    const tokenBudget = draftBudget.trim() ? Number(draftBudget) : null
    if (engine === 'pixel' && tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
      setError(tr('goal.bar.invalidBudget'))
      return
    }
    const unchanged =
      objective === goal.objective &&
      (engine !== 'pixel' || (tokenBudget === goal.tokenBudget && goal.status !== 'budgetLimited'))
    if (unchanged || (await act({ kind: 'set', objective, ...(engine === 'pixel' ? { tokenBudget } : {}) })))
      closeEditor()
  }
  const status = goalStatusText(goal.status)
  const usage = goalUsageText(goal)
  const hint =
    engine === 'pixel' && goal.status === 'budgetLimited' ? 'goal.bar.hint.pixelBudgetLimited' : HINT_KEY[goal.status]
  const warn = !!hint
  const canResume = goal.status !== 'active' && goal.status !== 'complete'
  const detailId = `goal-detail-${sessionId ?? ''}`
  const stats = goalStats(goal)
  return (
    <section
      aria-label={tr('goal.bar.region')}
      className="@container/goal mb-2 flex flex-col rounded-lg border border-line-card bg-surface"
    >
      <div className="flex min-w-0 items-center gap-1 py-1 pr-1.5 pl-1">
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          title={open ? tr('goal.bar.collapse') : `${goal.objective}\n${usage}`}
          onClick={toggle}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Target size={13} className="shrink-0 text-fg-muted" aria-hidden />
          <span className="shrink-0 text-meta text-fg-muted">{tr('goal.bar.label')}</span>
          <span className={cn('size-1.5 shrink-0 rounded-full', DOT[goal.status])} aria-hidden />
          <span className={cn('shrink-0 text-meta', warn ? 'text-warn' : 'text-fg-muted')}>{status}</span>
          <span className="min-w-0 flex-1 truncate text-list text-fg-secondary">{goal.objective}</span>
          {/* 窄的时候用量藏起来，悬停或展开时看 */}
          <span className="hidden shrink-0 text-label text-fg-faint tabular-nums @min-[480px]/goal:inline">
            {usage}
          </span>
          <ChevronDown
            size={13}
            aria-hidden
            className={cn('shrink-0 text-fg-faint transition-transform duration-(--dur-fast)', open && 'rotate-180')}
          />
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {busy && <Spinner size={11} />}
          {goal.status === 'active' && (
            <Button
              variant="ghost"
              icon={Pause}
              disabled={!!busy}
              title={tr('goal.bar.pauseHint')}
              className="h-6 px-2 text-meta"
              onClick={() => void act({ kind: 'pause' })}
            >
              {tr('goal.bar.pause')}
            </Button>
          )}
          {canResume && (
            <Button
              variant="ghost"
              icon={Play}
              disabled={!!busy}
              title={tr(
                engine === 'pixel' && goal.status === 'budgetLimited'
                  ? 'goal.bar.hint.pixelBudgetLimited'
                  : 'goal.bar.resumeHint',
              )}
              className="h-6 px-2 text-meta"
              onClick={() =>
                engine === 'pixel' && goal.status === 'budgetLimited' ? edit() : void act({ kind: 'resume' })
              }
            >
              {tr('goal.bar.resume')}
            </Button>
          )}
          <IconButton
            icon={X}
            size={24}
            iconSize={12}
            label={tr('goal.bar.clear')}
            title={tr('goal.bar.clearHint')}
            disabled={!!busy}
            onClick={() => void act({ kind: 'clear' })}
          />
        </div>
      </div>
      {open && (
        <div id={detailId} className="flex flex-col gap-2.5 border-t border-line-subtle px-3 pt-2 pb-2.5">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 text-label text-fg-faint">
              <span>{tr('goal.bar.full')}</span>
              {draft === null && (
                <button
                  type="button"
                  disabled={!!busy}
                  className="text-accent hover:underline disabled:opacity-50"
                  onClick={edit}
                >
                  {tr('goal.bar.edit')}
                </button>
              )}
            </div>
            {draft === null ? (
              <p className="max-h-56 overflow-auto pr-1 text-list break-words whitespace-pre-wrap text-fg">
                {goal.objective}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <textarea
                  autoFocus
                  value={draft}
                  maxLength={4000}
                  aria-label={tr('goal.bar.edit')}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.nativeEvent.isComposing) return
                    if (e.key === 'Escape') closeEditor()
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save()
                  }}
                  className="min-h-24 resize-y rounded-md border border-line bg-app px-2.5 py-1.5 text-list text-fg outline-none focus-visible:border-accent"
                />
                {engine === 'pixel' && (
                  <label className="flex flex-wrap items-center gap-2 text-meta text-fg-muted">
                    <span>{tr('goal.bar.budget')}</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={draftBudget}
                      onChange={e => setDraftBudget(e.target.value)}
                      placeholder={tr('goal.bar.noBudget')}
                      className="w-36 rounded-md border border-line bg-app px-2 py-1 text-fg outline-none focus-visible:border-accent"
                    />
                    <span className="text-label text-fg-faint">{tr('goal.bar.budgetHint')}</span>
                  </label>
                )}
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 text-label text-fg-faint">{tr('goal.bar.editHint')}</span>
                  <Button variant="ghost" className="h-6 px-2 text-meta" onClick={closeEditor}>
                    {tr('goal.bar.editCancel')}
                  </Button>
                  <Button
                    variant="primary"
                    className="h-6 px-2 text-meta"
                    disabled={!!busy || !draft.trim()}
                    onClick={() => void save()}
                  >
                    {tr('goal.bar.editSave')}
                  </Button>
                </div>
              </div>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-2 @min-[480px]/goal:grid-cols-4">
            {stats.map(s => (
              <div key={s.label} className="min-w-0 rounded-md bg-subtle px-2 py-1.5">
                <dt className="text-label text-fg-faint">{s.label}</dt>
                <dd className={cn('truncate text-meta tabular-nums', s.warn ? 'text-warn' : 'text-fg')}>{s.value}</dd>
                {s.share !== undefined && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-line" aria-hidden>
                    <div
                      className={cn('h-full rounded-full', s.share >= 0.8 ? 'bg-warn' : 'bg-accent')}
                      style={{ width: `${s.share * 100}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </dl>
          {plan && (
            <div className="flex flex-col gap-1">
              <span className="text-label text-fg-faint tabular-nums">
                {tr('goal.bar.plan')} · {plan.done}/{plan.steps.length}
              </span>
              <ul className="flex flex-col gap-1">
                {plan.steps.map((step, i) => (
                  <li key={i} className="flex items-start gap-2 text-list">
                    <StepMark status={step.status} live={false} />
                    <span
                      className={cn(
                        step.status === 'completed' && 'text-fg-muted line-through',
                        step.status === 'pending' && 'text-fg-secondary',
                        step.status === 'in_progress' && 'font-medium text-fg',
                      )}
                    >
                      {step.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hint && <p className="text-meta text-warn">{tr(hint)}</p>}
        </div>
      )}
      {error && <p className="px-3 pb-1.5 text-meta text-danger">{error}</p>}
    </section>
  )
}
