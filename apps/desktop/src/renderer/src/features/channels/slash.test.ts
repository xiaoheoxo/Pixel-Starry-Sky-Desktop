import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { ChannelMessage } from '@/data/types'
import { matchSlash, parseSlash, pinTarget, SLASH_IDS, slashQuery } from './slash'

describe('slash', () => {
  it('中英名字都认，参数留下；不认识的、不可用的返回 null', () => {
    expect(parseSlash('/流程 改登录页', SLASH_IDS)).toEqual({ id: 'flow', arg: '改登录页' })
    expect(parseSlash('/Archive', SLASH_IDS)).toEqual({ id: 'archive', arg: '' })
    expect(parseSlash('/xyz 你好', SLASH_IDS)).toBeNull()
    expect(parseSlash('/简报', ['flow'])).toBeNull()
    expect(parseSlash('看 /流程', SLASH_IDS)).toBeNull()
  })
  it('菜单只在整段是「/词」时出现，按名字筛', () => {
    expect(slashQuery('/流')).toBe('流')
    expect(slashQuery('/流程 x')).toBeUndefined()
    expect(matchSlash('pin', SLASH_IDS)).toEqual(['pin'])
  })
  it('/置顶：引用的文字消息优先，否则主时间线最后一条文字消息', () => {
    const msgs = [
      { kind: 'message', id: 'm1' },
      { kind: 'message', id: 'm2', threadId: 'm1' },
      { kind: 'task', id: 't1' },
    ] as unknown as ChannelMessage[]
    expect(pinTarget(msgs, null)).toBe('m1')
    expect(pinTarget(msgs, { kind: 'message', id: 'q' } as never)).toBe('q')
    expect(pinTarget([], null)).toBeNull()
  })
})
