// 「计划写好了」条（docs/ui/plan-mode-split.md §7）：Codex、Antigravity 计划中没有计划卡，计划就是一段普通回复。
// 这一轮在计划中正常跑完、没有待批的审批时，输入框上方给一个「按计划执行（档位）」；继续打字就是接着改计划。
import { useEffect, useRef, useState } from 'react'
import { ListChecks } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { PERMISSION_INFO, useEngineState, type ComposerController } from '@/features/engine'
import { cn, useToast } from '@/ui'
import { planReadyStep, type PlanPhase } from './planReady'

export function PlanReadyBar({
  live,
}: {
  live: Pick<ComposerController, 'sessionId' | 'level' | 'setPlanning' | 'submit'>
}) {
  useI18n()
  const toast = useToast()
  const snap = useEngineState(s => (live.sessionId ? (s.snapshots[live.sessionId] ?? null) : null))
  // 记下的阶段属于哪个会话：换了会话从 unknown 重新看，不带上一个会话的
  const seen = useRef<{ id: string | null; phase: PlanPhase }>({ id: live.sessionId, phase: 'unknown' })
  const [sending, setSending] = useState(false)
  const step = planReadyStep(seen.current.id === live.sessionId ? seen.current.phase : 'unknown', snap)
  useEffect(() => {
    seen.current = { id: live.sessionId, phase: step.phase }
  })
  if (!step.show) return null
  const label = PERMISSION_INFO[live.level].label
  const run = async (): Promise<void> => {
    setSending(true)
    try {
      // 先关掉计划回到原来那档，再让它按计划做（计划正文就在上面的回复里）
      await live.setPlanning(false)
      await live.submit(tr('planMode.ready.message'))
    } catch (e) {
      toast(translateMessage((e as Error).message))
    } finally {
      setSending(false)
    }
  }
  return (
    <div
      data-plan-ready
      className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-accent-line bg-accent-soft px-3 py-1.5 text-meta text-fg-secondary"
    >
      <ListChecks size={14} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-fg">{tr('planMode.ready.title')}</span>
        <span className="ml-2 text-fg-muted">{tr('planMode.ready.hint')}</span>
      </span>
      <button
        type="button"
        disabled={sending}
        onClick={() => void run()}
        className={cn(
          'shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 font-medium hover:bg-hover disabled:opacity-50',
          live.level === 'full' ? 'text-warn' : 'text-accent-fg',
        )}
      >
        {tr('planMode.ready.run', { p0: label })}
      </button>
    </div>
  )
}
