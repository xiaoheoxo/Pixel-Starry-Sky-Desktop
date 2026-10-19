import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import {
  INTERACT_MS,
  STICK_PX,
  afterGlideCancel,
  afterResize,
  contentMark,
  followResize,
  innerCanScrollUp,
  nearBottom,
  scrollUpKey,
  scrolledUp,
} from './scrollFollow'

describe('nearBottom', () => {
  it('离底部不到 STICK_PX 算在底部', () => {
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })).toBe(true)
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 500 - STICK_PX + 1, clientHeight: 500 })).toBe(true)
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 500 - STICK_PX, clientHeight: 500 })).toBe(false)
  })
  it('内容不满一屏时始终在底部', () => {
    expect(nearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 500 })).toBe(true)
  })
})

describe('followResize', () => {
  it('贴底且最近没有操作才跟', () => {
    expect(followResize(true, 0, INTERACT_MS)).toBe(true)
    expect(followResize(true, 1000, 1000 + INTERACT_MS - 1)).toBe(false)
    expect(followResize(false, 0, 10_000)).toBe(false)
  })
})

describe('afterResize', () => {
  // 离底部 150px：已离开底部
  const away = { scrollHeight: 1150, scrollTop: 500, clientHeight: 500 }
  // 下面的卡片收起，对话区高了 100px、滚动位置没变：离底部 50px，已经算到底
  const grown = { scrollHeight: 1150, scrollTop: 500, clientHeight: 600 }

  it('贴底且最近没有操作：跟到底', () => {
    expect(afterResize(away, true, false, 0, INTERACT_MS)).toEqual({ follow: true })
  })
  it('没贴底时底部自己靠过来：按钮消失并恢复贴底', () => {
    expect(afterResize(grown, false, false, 0, 10_000)).toEqual({ follow: false, stick: true, away: false })
  })
  it('没贴底、仍离开底部：保持', () => {
    expect(afterResize(away, false, false, 0, 10_000)).toEqual({ follow: false, stick: false, away: true })
  })
  it('刚操作过（展开了内容）把底部顶远：不跟、离开底部', () => {
    expect(afterResize(away, true, false, 1000, 1000 + INTERACT_MS - 1)).toEqual({
      follow: false,
      stick: false,
      away: true,
    })
  })
  it('搜索跳转后：只更新按钮，不恢复贴底', () => {
    expect(afterResize(grown, false, true, 0, 10_000)).toEqual({ follow: false, stick: false, away: false })
  })
})

describe('contentMark', () => {
  const user: Item = { kind: 'user', id: 'u1', text: 'hi', createdAt: 0 }
  const reply = (text: string): Item => ({ kind: 'assistant', id: 'a1', text, status: 'running' })

  it('条目增加时变化', () => {
    expect(contentMark([user])).not.toBe(contentMark([user, reply('')]))
  })
  it('最后一条文字变长时变化', () => {
    expect(contentMark([user, reply('a')])).not.toBe(contentMark([user, reply('ab')]))
  })
  it('命令输出变长时变化', () => {
    const cmd = (output: string): Item => ({
      kind: 'command',
      id: 'c1',
      command: 'ls',
      description: null,
      output,
      exitCode: null,
      status: 'running',
    })
    expect(contentMark([cmd('a')])).not.toBe(contentMark([cmd('a\nb')]))
  })
  it('只改状态不算新内容', () => {
    expect(contentMark([user, reply('done')])).toBe(
      contentMark([user, { kind: 'assistant', id: 'a1', text: 'done', status: 'completed' }]),
    )
  })
  it('空会话', () => {
    expect(contentMark([])).toBe('0::0')
  })
})

// AI 输出时滚不上去（用户反馈）：往上滚一点就松开，不等滚出 STICK_PX
describe('用户往上滚', () => {
  it('位置往上走、对话流没变矮才算往上滚', () => {
    expect(scrolledUp(null, { top: 500, height: 2000 })).toBe(false)
    expect(scrolledUp({ top: 500, height: 2000 }, { top: 492, height: 2000 })).toBe(true)
    // 新内容让对话流变高，同时往上滚
    expect(scrolledUp({ top: 500, height: 2000 }, { top: 495, height: 2030 })).toBe(true)
    // 往下滚、不动、1px 以内的抖动都不算
    expect(scrolledUp({ top: 500, height: 2000 }, { top: 560, height: 2000 })).toBe(false)
    expect(scrolledUp({ top: 500, height: 2000 }, { top: 499.5, height: 2000 })).toBe(false)
    // 下面的卡片收起、对话流变矮，浏览器把位置往上夹：不算
    expect(scrolledUp({ top: 500, height: 2000 }, { top: 380, height: 1880 })).toBe(false)
  })

  it('往上滚的按键', () => {
    for (const key of ['ArrowUp', 'PageUp', 'Home']) expect(scrollUpKey({ key, shiftKey: false })).toBe(true)
    expect(scrollUpKey({ key: ' ', shiftKey: true })).toBe(true)
    expect(scrollUpKey({ key: ' ', shiftKey: false })).toBe(false)
    expect(scrollUpKey({ key: 'ArrowDown', shiftKey: false })).toBe(false)
    expect(scrollUpKey({ key: 'End', shiftKey: false })).toBe(false)
  })

  it('松开以后（hold）内容变高不跟到底，离底部还在 STICK_PX 以内也不恢复贴底', () => {
    const near = { scrollHeight: 1030, scrollTop: 500, clientHeight: 500 }
    expect(afterResize(near, false, true, 0, 10_000)).toEqual({ follow: false, stick: false, away: false })
    // 没松开时按位置重新判断，在底部附近就恢复贴底
    expect(afterResize(near, false, false, 0, 10_000)).toEqual({ follow: false, stick: true, away: false })
  })
})

describe('innerCanScrollUp', () => {
  afterEach(() => vi.unstubAllGlobals())
  type Box = {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    parentElement: Box | null
    overflow: string
  }
  const box = (patch: Partial<Box>, parent: Box | null): Box => ({
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    overflow: 'visible',
    parentElement: parent,
    ...patch,
  })
  const run = (target: Box, root: Box): boolean => {
    vi.stubGlobal('getComputedStyle', (el: Box) => ({ overflowY: el.overflow }))
    return innerCanScrollUp(target as unknown as Element, root as unknown as Element)
  }

  it('滚轮落在能往上滚的输出框里：滚的是那个框', () => {
    const root = box({ scrollTop: 900, scrollHeight: 2000, clientHeight: 500, overflow: 'auto' }, null)
    const output = box({ scrollTop: 40, scrollHeight: 400, clientHeight: 200, overflow: 'auto' }, root)
    const line = box({}, output)
    expect(run(line, root)).toBe(true)
  })

  it('框已经在最上面、框不能滚、或者只是 overflow 隐藏：滚的是对话', () => {
    const root = box({ scrollTop: 900, scrollHeight: 2000, clientHeight: 500, overflow: 'auto' }, null)
    expect(run(box({ scrollTop: 0, scrollHeight: 400, clientHeight: 200, overflow: 'auto' }, root), root)).toBe(false)
    expect(run(box({ scrollTop: 10, overflow: 'auto' }, root), root)).toBe(false)
    expect(run(box({ scrollTop: 40, scrollHeight: 400, clientHeight: 200, overflow: 'hidden' }, root), root)).toBe(
      false,
    )
    expect(run(box({}, root), root)).toBe(false)
  })
})

describe('afterGlideCancel', () => {
  const at = (top: number) => ({ scrollHeight: 2000, clientHeight: 500, scrollTop: top })

  it('打断在离底很远的地方：不再贴底，显示「回到最新」', () => {
    expect(afterGlideCancel(at(800), true, false, false)).toEqual({ stick: false, away: true })
  })

  it('打断在底部附近：照旧贴底，不显示按钮', () => {
    expect(afterGlideCancel(at(1450), false, false, false)).toEqual({ stick: true, away: false })
  })

  it('用户已往上滚（released）：哪怕还在 80px 内也不恢复贴底，但按钮按位置判断', () => {
    expect(afterGlideCancel(at(1450), true, false, true)).toEqual({ stick: false, away: false })
  })

  it('搜索跳转后暂停（detached）：贴底保持原值，只更新按钮', () => {
    expect(afterGlideCancel(at(800), false, true, false)).toEqual({ stick: false, away: true })
    expect(afterGlideCancel(at(1450), false, true, false)).toEqual({ stick: false, away: false })
  })
})
