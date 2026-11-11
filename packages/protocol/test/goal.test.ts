import { describe, expect, it } from 'vitest'
import { parseGoalCommand, pixelGoalReport, type SessionGoal } from '../src'

describe('parseGoalCommand', () => {
  it('看 / 暂停 / 继续 / 清除 / 设目标；不是 /goal 开头的不算', () => {
    expect(parseGoalCommand('/goal')).toEqual({ kind: 'get' })
    expect(parseGoalCommand('  /goal  ')).toEqual({ kind: 'get' })
    expect(parseGoalCommand('/goal pause')).toEqual({ kind: 'pause' })
    expect(parseGoalCommand('/goal RESUME')).toEqual({ kind: 'resume' })
    expect(parseGoalCommand('/goal clear')).toEqual({ kind: 'clear' })
    expect(parseGoalCommand('/goal 把测试修好\n全部通过为止')).toEqual({
      kind: 'set',
      objective: '把测试修好\n全部通过为止',
    })
    expect(parseGoalCommand('/goal pause the build')).toEqual({ kind: 'set', objective: 'pause the build' })
    expect(parseGoalCommand('/goals')).toBeNull()
    expect(parseGoalCommand('请 /goal 一下')).toBeNull()
    expect(parseGoalCommand('/compact')).toBeNull()
  })
})

it('Pixel reports reject corrupt state instead of clearing the current goal', () => {
  const goal: SessionGoal = {
    objective: 'Finish',
    status: 'active',
    tokensUsed: 1,
    tokenBudget: null,
    timeUsedSeconds: 2,
    updatedAt: 3,
  }
  expect(pixelGoalReport({ version: 1, goal })?.goal).toEqual(goal)
  expect(pixelGoalReport({ version: 1, goal: null })).not.toBeNull()
  for (const patch of [
    { tokensUsed: NaN },
    { tokenBudget: -1 },
    { timeUsedSeconds: Infinity },
    { objective: '' },
    { status: 'invented' },
  ])
    expect(pixelGoalReport({ version: 1, goal: { ...goal, ...patch } })).toBeNull()
  expect(pixelGoalReport({ version: 1 })).toBeNull()
  expect(pixelGoalReport({ version: 2, goal })).toBeNull()
})
