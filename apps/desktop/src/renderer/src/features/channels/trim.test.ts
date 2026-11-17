// 离开的频道只留最近 100 条（docs/memory-tier3.md §2.2）：回来往上翻接得上，不漏；讨论串、回复对象被裁掉时清掉
import { describe, expect, it, vi } from 'vitest'
import type { ChannelMessage } from '../../../../shared/types/channels'

const msg = (channelId: string, i: number): ChannelMessage =>
  ({
    kind: 'message',
    id: `${channelId}-${i}`,
    channelId,
    authorId: 'self',
    text: `第 ${i} 条`,
    format: 'plain',
    at: 1000 + i,
  }) as ChannelMessage
const all: Record<string, ChannelMessage[]> = {
  c1: Array.from({ length: 250 }, (_, i) => msg('c1', i)),
  c2: Array.from({ length: 3 }, (_, i) => msg('c2', i)),
}

const bridge = {
  onChange: () => () => undefined,
  onMessage: () => () => undefined,
  state: async () => ({
    channels: ['c1', 'c2'].map(id => ({ id, name: id, unread: 0, mentioned: false, memberIds: [] })),
    members: [],
    sessionChannels: {},
  }),
  markRead: async () => undefined,
  messages: async (id: string, _before?: number | null, beforeId?: string | null) => {
    const list = all[id]
    const at = beforeId ? list.findIndex(m => m.id === beforeId) : -1
    const stop = at >= 0 ? at : list.length
    const start = Math.max(0, stop - 200)
    return { messages: list.slice(start, stop), more: start > 0 }
  },
}
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
vi.mock('@/data', () => ({
  isDemo: false,
  channels: [],
  channelMembers: [],
  channelMessages: {},
  channelTeams: [],
}))
;(window as unknown as { pixelsky: unknown }).pixelsky = { channels: bridge }

const { KEEP_ON_LEAVE, channelActions, getChannels, trimOnLeave } = await import('./store')

describe('离开频道后裁掉早的消息', () => {
  it('切走后只留最近 100 条，回来往上翻按最早那条接着读，不漏', async () => {
    await new Promise(r => setTimeout(r, 0))
    channelActions.select('c1')
    await vi.waitFor(() => expect(getChannels().messages.c1).toHaveLength(200))
    channelActions.select('c2')
    await vi.waitFor(() => expect(getChannels().messages.c2).toHaveLength(3))
    expect(getChannels().messages.c1.map(m => m.id)).toEqual(all.c1.slice(-KEEP_ON_LEAVE).map(m => m.id))
    expect(getChannels().more.c1).toBe(true)
    // 没超过 100 条的不动
    channelActions.select('c1')
    expect(getChannels().messages.c2).toHaveLength(3)
    await channelActions.loadOlder('c1')
    await channelActions.loadOlder('c1')
    expect(getChannels().messages.c1.map(m => m.id)).toEqual(all.c1.map(m => m.id))
    expect(getChannels().more.c1).toBe(false)
  })

  it('打开的讨论串、回复对象被裁掉就清掉，留下的照旧', () => {
    const list = Array.from({ length: 150 }, (_, i) => msg('c9', i))
    const base = { messages: { c9: list }, more: { c9: false }, thread: { c9: 'c9-3' }, replyTo: { c9: 'c9-140' } }
    const next = trimOnLeave(base, 'c9')!
    expect(next.messages.c9).toHaveLength(KEEP_ON_LEAVE)
    expect(next.thread.c9).toBeNull()
    expect(next.replyTo.c9).toBe('c9-140')
    expect(trimOnLeave({ ...base, messages: { c9: list.slice(0, 100) } }, 'c9')).toBeNull()
  })
})
