import { describe, expect, it } from 'vitest'
import type { SessionState, SessionSummary } from '@pixelsky/protocol'
import { AwakeTracker, WAITING_AWAKE_MS } from './keepAwake'

const session = (id: string, state: SessionState, extra: { background?: number; archivedAt?: string } = {}) =>
  ({ record: { id, archivedAt: extra.archivedAt ?? null }, state, background: extra.background }) as SessionSummary

describe('AwakeTracker', () => {
  it('运行中、启动中、只剩后台任务都算；空闲和归档的不算', () => {
    const t = new AwakeTracker()
    expect(t.update([session('a', 'running')], 0).awake).toBe(true)
    expect(t.update([session('a', 'starting')], 0).awake).toBe(true)
    expect(t.update([session('a', 'idle', { background: 1 })], 0).awake).toBe(true)
    expect(t.update([session('a', 'idle', { background: 0 })], 0).awake).toBe(false)
    expect(t.update([session('a', 'running', { archivedAt: 'x' })], 0).awake).toBe(false)
    expect(t.update([], 0)).toEqual({ awake: false, recheckAt: null })
  })

  it('等审批最多保持 30 分钟，到点要重算', () => {
    const t = new AwakeTracker()
    const list = [session('a', 'waiting')]
    expect(t.update(list, 1000)).toEqual({ awake: true, recheckAt: 1000 + WAITING_AWAKE_MS })
    // 期间别的会话状态变化带来的更新不续期
    expect(t.update(list, 5000)).toEqual({ awake: true, recheckAt: 1000 + WAITING_AWAKE_MS })
    expect(t.update(list, 1000 + WAITING_AWAKE_MS)).toEqual({ awake: false, recheckAt: null })
  })

  it('答完以后再等审批，重新算 30 分钟', () => {
    const t = new AwakeTracker()
    t.update([session('a', 'waiting')], 0)
    t.update([session('a', 'running')], WAITING_AWAKE_MS + 1)
    const end = 2 * WAITING_AWAKE_MS
    expect(t.update([session('a', 'waiting')], end)).toEqual({ awake: true, recheckAt: end + WAITING_AWAKE_MS })
  })

  it('等审批超时了，但还有别的会话在运行：仍然保持', () => {
    const t = new AwakeTracker()
    t.update([session('a', 'waiting')], 0)
    const r = t.update([session('a', 'waiting'), session('b', 'running')], WAITING_AWAKE_MS)
    expect(r).toEqual({ awake: true, recheckAt: null })
  })

  it('多个会话在等：按最早到点的重算', () => {
    const t = new AwakeTracker()
    t.update([session('a', 'waiting')], 0)
    const r = t.update([session('a', 'waiting'), session('b', 'waiting')], 100)
    expect(r.recheckAt).toBe(WAITING_AWAKE_MS)
  })
})
