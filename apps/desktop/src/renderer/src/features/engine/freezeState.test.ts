import { describe, expect, it } from 'vitest'
import { IDLE, freezeReducer, isFrozen, type FreezeEvent } from './freezeState'

const run = (...events: FreezeEvent[]) => events.reduce(freezeReducer, IDLE)

describe('侧栏冻结状态', () => {
  it('指针进来冻结，离开解冻', () => {
    expect(isFrozen(run('enter'))).toBe(true)
    expect(isFrozen(run('enter', 'leave'))).toBe(false)
    expect(isFrozen(run('leave'))).toBe(false)
  })

  it('重复 enter（pointermove）不产生新状态对象', () => {
    const s = run('enter')
    expect(freezeReducer(s, 'enter')).toBe(s)
  })

  it('拖动期间浏览器补发的 leave 不解冻，dragend 之后才解', () => {
    const s = run('enter', 'dragstart', 'leave')
    expect(isFrozen(s)).toBe(true)
    expect(isFrozen(freezeReducer(s, 'dragend'))).toBe(false)
  })

  it('拖动结束时指针还在里面：之后的 enter 再冻结，离开再解冻', () => {
    const ended = run('enter', 'dragstart', 'leave', 'dragend')
    expect(isFrozen(ended)).toBe(false)
    const back = freezeReducer(ended, 'enter')
    expect(isFrozen(back)).toBe(true)
    expect(isFrozen(freezeReducer(back, 'leave'))).toBe(false)
  })

  it('拖动中指针回到侧栏再离开，仍然冻结到 dragend', () => {
    expect(isFrozen(run('dragstart', 'leave', 'enter', 'leave'))).toBe(true)
  })

  it('reset（窗口失焦等）把两个标记都清掉，不会一直冻着', () => {
    expect(isFrozen(run('enter', 'dragstart', 'reset'))).toBe(false)
  })
})
