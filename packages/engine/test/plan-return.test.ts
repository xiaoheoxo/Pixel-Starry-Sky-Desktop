// 「先出计划」和权限档位分开（docs/ui/plan-mode-split.md §3、§7）
import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '@pixelsky/protocol'
import { nextPlanReturn, reportedMode } from '../src/host/plan-return'

const rec = (permissionMode: SessionRecord['permissionMode'], planReturn: SessionRecord['planReturn'] = null) =>
  ({ permissionMode, planReturn }) as SessionRecord

describe('nextPlanReturn', () => {
  it('进计划记下原来那档；规划中换档；离开就清掉', () => {
    expect(nextPlanReturn(rec('full'), 'plan', undefined)).toBe('full')
    expect(nextPlanReturn(rec('ask'), 'plan', 'full')).toBe('full')
    expect(nextPlanReturn(rec('plan', 'full'), 'plan', undefined)).toBe('full')
    expect(nextPlanReturn(rec('plan', 'full'), 'plan', 'edits')).toBe('edits')
    expect(nextPlanReturn(rec('plan', 'full'), 'full', undefined)).toBeNull()
    expect(nextPlanReturn(rec('plan', 'full'), 'plan', null)).toBeNull()
    // 不在计划中给的 planReturn 不算数
    expect(nextPlanReturn(rec('ask'), 'edits', 'full')).toBeNull()
    expect(() => nextPlanReturn(rec('ask'), 'plan', 'plan')).toThrow()
    expect(() => nextPlanReturn(rec('ask'), 'plan', 'bogus')).toThrow()
  })
})

describe('reportedMode', () => {
  it('计划中引擎报离开计划：换成 planReturn，和引擎报的不同才推回去', () => {
    expect(reportedMode(rec('plan', 'full'), 'ask')).toEqual({ permissionMode: 'full', planReturn: null, push: true })
    expect(reportedMode(rec('plan', 'full'), 'full')).toEqual({ permissionMode: 'full', planReturn: null, push: false })
  })
  it('旧记录没有 planReturn：照引擎报的', () => {
    expect(reportedMode(rec('plan'), 'ask')).toEqual({ permissionMode: 'ask', planReturn: null, push: false })
  })
  it('用户在审批里明确选的（Codex 全部放行）：照选的，不换', () => {
    expect(reportedMode(rec('plan', 'edits'), 'full', true)).toEqual({
      permissionMode: 'full',
      planReturn: null,
      push: false,
    })
  })
  it('批准了计划但用户已经换到别的档：以用户换的为准，和引擎报的不同就推回去（§11）', () => {
    expect(reportedMode(rec('ask'), 'full', false, true)).toEqual({
      permissionMode: 'ask',
      planReturn: null,
      push: true,
    })
    expect(reportedMode(rec('ask'), 'ask', false, true)).toEqual({
      permissionMode: 'ask',
      planReturn: null,
      push: false,
    })
    // 还在计划中就是普通的批准；引擎又进计划、用户在审批里明确选的不归它管
    expect(reportedMode(rec('plan', 'edits'), 'ask', false, true)).toEqual({
      permissionMode: 'edits',
      planReturn: null,
      push: true,
    })
    expect(reportedMode(rec('ask'), 'plan', false, true)).toMatchObject({ permissionMode: 'plan', planReturn: 'ask' })
    expect(reportedMode(rec('ask'), 'full', true, true)).toMatchObject({ permissionMode: 'full', push: false })
    // 没批准过计划：照引擎报的
    expect(reportedMode(rec('ask'), 'edits')).toMatchObject({ permissionMode: 'edits', push: false })
  })
  it('引擎自己进计划：记下原来那档', () => {
    expect(reportedMode(rec('full'), 'plan')).toEqual({ permissionMode: 'plan', planReturn: 'full', push: false })
    expect(reportedMode(rec('plan', 'edits'), 'plan')).toEqual({
      permissionMode: 'plan',
      planReturn: 'edits',
      push: false,
    })
  })
})
