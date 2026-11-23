import { describe, expect, it } from 'vitest'
import { SCHEDULE_RUNS_MAX, type ScheduleRun, type TaskSchedule } from '../../../shared/types/project-tools'
import { cleanSchedule, pushRun } from './schedule'

const now = new Date(2026, 9, 26, 10, 0).getTime()
const input = {
  enabled: true,
  freq: 'daily',
  hour: 9,
  minute: 0,
  weekday: 1,
  engine: 'claude',
  model: null,
  permission: 'plan',
  session: 'new',
}

describe('cleanSchedule', () => {
  it('新启用从现在之前最近的时间点算起，不立刻补跑', () => {
    expect(cleanSchedule(input, null, now)?.lastSlot).toBe(new Date(2026, 9, 26, 9, 0).getTime())
  })
  it('界面传来的运行记录被忽略，沿用已存的；频率没变时 lastSlot 不动', () => {
    const run: ScheduleRun = { at: 1, trigger: 'manual', status: 'done' }
    const prior = { ...(cleanSchedule(input, null, now) as TaskSchedule), lastSlot: 5, runs: [run], lastSessionId: 's' }
    const next = cleanSchedule({ ...input, runs: [], lastSlot: 99 }, prior, now)
    expect(next).toMatchObject({ lastSlot: 5, runs: [run], lastSessionId: 's' })
    // 引擎、模型、权限改了：不再续用旧会话，新设置下次才生效
    expect(cleanSchedule({ ...input, engine: 'codex' }, prior, now)?.lastSessionId).toBeNull()
    expect(cleanSchedule({ ...input, model: 'm2' }, prior, now)?.lastSessionId).toBeNull()
    expect(cleanSchedule({ ...input, permission: 'edits' }, prior, now)?.lastSessionId).toBeNull()
    expect(cleanSchedule({ ...input, hour: 10 }, prior, now)?.lastSlot).toBe(new Date(2026, 9, 26, 10, 0).getTime())
  })
  it('oh-my-pi 能存；没接定时任务的引擎报错', () => {
    expect(cleanSchedule({ ...input, engine: 'omp' }, null, now)?.engine).toBe('omp')
    for (const engine of ['antigravity', 'dot', 'nope', undefined])
      expect(() => cleanSchedule({ ...input, engine }, null, now)).toThrow('参数不正确')
  })
  it('null 清除；非法值报错；不给 full 权限', () => {
    expect(cleanSchedule(null, undefined, now)).toBeNull()
    expect(() => cleanSchedule({ ...input, hour: 24 }, null, now)).toThrow()
    expect(() => cleanSchedule({ ...input, freq: 'monthly' }, null, now)).toThrow()
    expect(() => cleanSchedule({ ...input, permission: 'full' }, null, now)).toThrow()
  })
})

describe('pushRun', () => {
  it('新的在前，最多保留 20 条', () => {
    let runs: ScheduleRun[] = []
    for (let i = 0; i < SCHEDULE_RUNS_MAX + 5; i++) runs = pushRun(runs, { at: i, trigger: 'schedule', status: 'done' })
    expect(runs).toHaveLength(SCHEDULE_RUNS_MAX)
    expect(runs[0].at).toBe(SCHEDULE_RUNS_MAX + 4)
  })
})
