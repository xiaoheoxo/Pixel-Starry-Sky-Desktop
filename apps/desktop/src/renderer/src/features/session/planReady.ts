// 「计划写好了」条该不该显示（docs/ui/plan-mode-split.md §7），界面在 PlanReadyBar.tsx
import type { EngineId, SessionSnapshot } from '@pixelsky/protocol'

/** 计划写完有审批卡的引擎（Claude 的 ExitPlanMode、像素星空和 oh-my-pi 的计划确认）：不出这个条 */
const HAS_PLAN_CARD: ReadonlySet<EngineId> = new Set(['claude', 'pixel', 'omp'])

type View = Pick<SessionSnapshot, 'state' | 'pending'> & {
  record: Pick<SessionSnapshot['record'], 'permissionMode' | 'lastOutcome' | 'engine'>
}

/**
 * 看到的阶段：unknown 还不知道（刚出现时这一轮已经在跑，可能是开计划之前就开始的）；idle 计划中看到过空闲；
 * ran 计划中看到过空闲之后又开始跑——这之后的一轮才算「计划中跑的」
 */
export type PlanPhase = 'unknown' | 'idle' | 'ran'

/**
 * 这一刻的阶段和条该不该显示。不靠「从跑着变空闲」那一下：空闲和这一轮结果（lastOutcome）可能分两次到，
 * 空闲期间每次都按最新的结果算
 */
export function planReadyStep(phase: PlanPhase, snap: View | null): { phase: PlanPhase; show: boolean } {
  if (!snap || snap.record.permissionMode !== 'plan') return { phase: 'unknown', show: false }
  if (snap.state !== 'idle') return { phase: phase === 'unknown' ? 'unknown' : 'ran', show: false }
  const next = phase === 'ran' ? 'ran' : 'idle'
  const show =
    next === 'ran' &&
    snap.record.lastOutcome === 'completed' &&
    snap.pending.length === 0 &&
    !HAS_PLAN_CARD.has(snap.record.engine)
  return { phase: next, show }
}
