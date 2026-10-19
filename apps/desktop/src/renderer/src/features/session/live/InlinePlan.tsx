import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
// 极简模式下计划写在对话里（docs/ui/minimal-mode.md §3，参考 Factory）：这一轮运行中列在对话末尾，
// 做完的划掉、右边绿勾，正在做的橙色转圈，没开始空心；右上角提示按 Esc 中断。浮动进度卡片这时只放子智能体
import { Check } from 'lucide-react'
import { Spinner, cn } from '@/ui'
import type { Plan } from './progressData'

export function InlinePlan({ plan, working }: { plan: Plan; working: boolean }) {
  useI18n()
  return (
    <section data-inline-plan className="conversation-message flex flex-col">
      <div className="flex h-6 items-center justify-between text-list text-fg-muted">
        <span>{tr('minimal.plan.title', { done: plan.done, total: plan.steps.length })}</span>
        <span className="flex items-center gap-1 text-meta text-fg-faint">
          {tr('minimal.plan.pressBefore')}
          <kbd className="rounded-sm border border-line px-1 font-mono text-label text-fg-muted">Esc</kbd>
          {tr('minimal.plan.pressAfter')}
        </span>
      </div>
      <ol className="flex flex-col">
        {plan.steps.map((step, i) => (
          <li key={i} data-step-status={step.status} className="flex min-h-6 items-center gap-2.5 text-list">
            {step.status === 'in_progress' && working ? (
              // 11px 的转圈占 7px 的位置：左右各让出 2px，后面的文字不挪
              <Spinner size={11} className="-mx-0.5 text-active!" />
            ) : (
              <span
                className={cn(
                  'size-[7px] shrink-0 rounded-full',
                  step.status === 'completed' && 'bg-success',
                  // 等你批准 / 回答时没在干活：进行中的步骤画静止的橙点，不转
                  step.status === 'in_progress' && 'bg-active',
                  step.status === 'pending' && 'border-[1.5px] border-fg-faint',
                )}
              />
            )}
            <span
              className={cn(
                'min-w-0 flex-1',
                step.status === 'completed' ? 'text-fg-faint line-through' : 'text-fg',
                step.status === 'in_progress' && 'font-medium',
              )}
            >
              {step.text}
            </span>
            {step.status === 'completed' && <Check size={13} strokeWidth={2.25} className="shrink-0 text-success" />}
          </li>
        ))}
      </ol>
    </section>
  )
}
