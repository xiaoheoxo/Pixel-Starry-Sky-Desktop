import { describe, expect, it } from 'vitest'
import { appendRun, MAX_RUNS, parseRunReason, runReasonOf } from './runReason'
import type { ChannelRun } from '../types/channels'

describe('runReasonOf', () => {
  it('只有失败才有原因', () => {
    expect(runReasonOf('done', '余额不足')).toBeNull()
    expect(runReasonOf('stopped', null)).toBeNull()
  })
  it('引擎报错按协议包的归类', () => {
    expect(runReasonOf('failed', 'API Error: 401 authentication_error')).toBe('engine.auth')
    expect(runReasonOf('failed', '平台余额不足，请充值')).toBe('engine.quota')
    expect(runReasonOf('failed', 'API Error: 429 rate limit exceeded')).toBe('engine.busy')
    expect(runReasonOf('failed', 'prompt is too long: 210000 tokens')).toBe('engine.context')
    expect(runReasonOf('failed', 'API Error: 404 model_not_found')).toBe('engine.model')
  })
  it('执行端自己的失败、认不出的', () => {
    expect(runReasonOf('failed', '会话已删除')).toBe('session_gone')
    expect(runReasonOf('failed', '这个 AI 成员已被删除')).toBe('not_deployed')
    expect(runReasonOf('failed', 'something odd')).toBe('other')
    expect(runReasonOf('failed', '')).toBe('other')
  })
})

describe('parseRunReason', () => {
  it('认识的原样，不认识的当 other，空的当没有', () => {
    expect(parseRunReason('machine_offline')).toBe('machine_offline')
    expect(parseRunReason('engine.future')).toBe('other')
    expect(parseRunReason('')).toBeNull()
    expect(parseRunReason(null)).toBeNull()
  })
})

describe('appendRun', () => {
  const run = (n: number, endedAt = n * 1000): ChannelRun => ({ n, status: 'done', startedAt: null, endedAt })
  it('同一轮同一时间不重复', () => {
    expect(appendRun([run(1)], run(1))).toHaveLength(1)
    expect(appendRun([run(1)], run(1, 5))).toHaveLength(2)
  })
  it('最多留 MAX_RUNS 条，丢最旧的', () => {
    let list: ChannelRun[] = []
    for (let i = 1; i <= MAX_RUNS + 2; i++) list = appendRun(list, run(i))
    expect(list).toHaveLength(MAX_RUNS)
    expect(list[0].n).toBe(3)
  })
})
