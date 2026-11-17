// 「计划写好了」条什么时候出现（docs/ui/plan-mode-split.md §7）
import { describe, expect, it } from 'vitest'
import { planReadyStep, type PlanPhase } from './planReady'

type Over = {
  state?: 'idle' | 'running'
  mode?: 'plan' | 'full'
  outcome?: 'completed' | 'failed' | null
  engine?: 'codex' | 'claude' | 'antigravity'
  pending?: number
}
const snap = (over: Over = {}) =>
  ({
    state: over.state ?? 'idle',
    pending: Array.from({ length: over.pending ?? 0 }, () => ({})),
    record: {
      permissionMode: over.mode ?? 'plan',
      lastOutcome: over.outcome === undefined ? 'completed' : over.outcome,
      engine: over.engine ?? 'codex',
    },
  }) as Parameters<typeof planReadyStep>[1]

/** 依次看到这些快照，返回每一步显示不显示 */
function run(...seq: Over[]): boolean[] {
  let phase: PlanPhase = 'unknown'
  return seq.map(o => {
    const s = planReadyStep(phase, snap(o))
    phase = s.phase
    return s.show
  })
}

describe('planReadyStep', () => {
  it('计划中看到空闲、再跑完一轮才出现；继续改计划（又跑）时收起，跑完再出现', () => {
    expect(run({}, { state: 'running' }, {}, {}, { state: 'running' }, {})).toEqual([
      false,
      false,
      true,
      true,
      false,
      true,
    ])
  })

  it('打开计划时这一轮已经在跑（开计划之前开始的）：跑完不出现', () => {
    expect(run({ state: 'running' }, {})).toEqual([false, false])
  })

  it('空闲先到、这一轮结果后到：结果到了再出现', () => {
    expect(run({ outcome: null }, { state: 'running', outcome: null }, { outcome: null }, {})).toEqual([
      false,
      false,
      false,
      true,
    ])
  })

  it('没正常结束、关掉计划、有待批的、有计划卡的引擎：不出现', () => {
    expect(run({}, { state: 'running' }, { outcome: 'failed' })).toEqual([false, false, false])
    expect(run({}, { state: 'running' }, { mode: 'full' })).toEqual([false, false, false])
    expect(run({}, { state: 'running' }, { pending: 1 })).toEqual([false, false, false])
    expect(run({ engine: 'claude' }, { state: 'running', engine: 'claude' }, { engine: 'claude' })).toEqual([
      false,
      false,
      false,
    ])
    expect(run({ engine: 'antigravity' }, { state: 'running' }, { engine: 'antigravity' })).toEqual([
      false,
      false,
      true,
    ])
  })
})
