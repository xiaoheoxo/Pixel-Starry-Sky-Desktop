import { describe, expect, it } from 'vitest'
import type { EngineInfo } from '@pixelsky/protocol'
import { scheduleDefaultEngine, scheduleEngines } from './scheduleModel'

const engine = (id: EngineInfo['id'], status: EngineInfo['status']) => ({ id, status })

describe('定时任务的引擎', () => {
  it('只列能存的（和主进程校验同一份名单）', () => {
    const all = (['claude', 'codex', 'pixel', 'antigravity', 'dot', 'omp'] as const).map(id => engine(id, 'ready'))
    expect(scheduleEngines(all).map(e => e.id)).toEqual(['claude', 'codex', 'pixel', 'omp'])
  })
  it('默认用能用的里排最前的；都不能用取第一个；只有存不了的不给', () => {
    expect(
      scheduleDefaultEngine([engine('antigravity', 'ready'), engine('claude', 'missing'), engine('omp', 'ready')]),
    ).toBe('omp')
    expect(scheduleDefaultEngine([engine('dot', 'ready'), engine('codex', 'missing')])).toBe('codex')
    expect(scheduleDefaultEngine([engine('dot', 'ready')])).toBeUndefined()
  })
})
