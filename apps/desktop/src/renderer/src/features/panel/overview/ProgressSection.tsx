// 概况 › 进度。运行中进度卡片自己 portal 进来（overviewSlot.ts，SessionView），这里只管这一轮结束后的那一句总结
import { useMemo } from 'react'
import { List } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { useEngineState } from '@/features/engine'
import { formatDuration } from '@/features/session/live/agentTrace'
import { StepMark } from '@/features/session/live/ProgressCard'
import { currentPlan } from '@/features/session/live/progressData'
import { lastTurnDuration } from './overviewModel'
import type { SectionProps } from './OverviewPanel'
import { Section } from './Section'

export function ProgressSection({ sessionId, active }: SectionProps) {
  useI18n()
  // items 运行中每来一个字都变：只在这一轮真的结束后取。还有后台子智能体在跑时卡片还在，不写总结
  const items = useEngineState(s => {
    const snap = s.snapshots[sessionId]
    return active && snap?.state === 'idle' && !snap.background ? snap.items : null
  })
  const plan = useMemo(() => (items ? currentPlan(items, false) : null), [items])
  if (!items || !plan) return null
  const allDone = plan.done === plan.steps.length
  const text = allDone
    ? tr('session.progress.allDone', { total: plan.steps.length })
    : tr('session.progress.steps', { done: plan.done, total: plan.steps.length })
  const duration = lastTurnDuration(items)
  return (
    <Section
      id="progress"
      icon={List}
      title={tr('session.progress.title')}
      summary={tr('overview.lastTurnPlan', { plan: text })}
    >
      <div className="flex items-start gap-2 text-list text-fg-secondary">
        <StepMark status={allDone ? 'completed' : 'in_progress'} live={false} />
        <span className="min-w-0 flex-1 tabular-nums">
          {duration > 0 ? `${text} · ${tr('goal.bar.time', { time: formatDuration(duration) })}` : text}
        </span>
      </div>
      <p className="mt-1 text-meta text-fg-muted">{tr('overview.planInTurn')}</p>
    </Section>
  )
}
