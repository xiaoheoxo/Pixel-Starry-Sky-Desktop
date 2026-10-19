// 频道消息分页：同一毫秒的几条消息跨在两页之间时，往上翻和搜索结果点进来都不漏（游标带消息 id）
import { describe, expect, it, vi } from 'vitest'
import type { ChannelMessage } from '../../../../shared/types/channels'

const AT = 2000
// 202 条：m0 早一点，m1 和 m2 同一毫秒；最新一页 200 条从 m2 开始，m1 落在上一页
const all: ChannelMessage[] = Array.from({ length: 202 }, (_, i) => ({
  kind: 'message',
  id: `m${i}`,
  channelId: 'c1',
  authorId: 'self',
  text: `第 ${i} 条`,
  format: 'plain',
  at: i === 0 ? 1000 : i <= 2 ? AT : AT + i,
})) as ChannelMessage[]

const calls: { before: number | null; beforeId: string | null }[] = []
/** 和主进程同样的取法：有 beforeId 按位置，没有按时间 */
const bridge = {
  onChange: () => () => undefined,
  onMessage: () => () => undefined,
  state: async () => ({
    channels: [{ id: 'c1', name: '分页', unread: 0, mentioned: false, memberIds: [] }],
    members: [],
    sessionChannels: {},
  }),
  markRead: async () => undefined,
  messages: async (_id: string, before?: number | null, beforeId?: string | null) => {
    calls.push({ before: before ?? null, beforeId: beforeId ?? null })
    const at = beforeId ? all.findIndex(m => m.id === beforeId) : -1
    const end = at >= 0 ? at : before == null ? all.length : all.findIndex(m => m.at >= before)
    const stop = end < 0 ? all.length : end
    const start = Math.max(0, stop - 200)
    return { messages: all.slice(start, stop), more: start > 0 }
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

const { channelActions, getChannels } = await import('./store')

describe('频道消息分页', () => {
  it('搜索结果点进上一页里同一毫秒的消息：接着往前读（游标带最早那条的 id），读到后停', async () => {
    await new Promise(r => setTimeout(r, 0))
    channelActions.select('c1')
    await vi.waitFor(() => expect(getChannels().messages.c1).toHaveLength(200))
    expect(getChannels().messages.c1[0].id).toBe('m2')

    await channelActions.focusMessage('c1', 'm1', AT)
    const ids = getChannels().messages.c1.map(m => m.id)
    expect(ids).toEqual(all.map(m => m.id))
    expect(getChannels().more.c1).toBe(false)
    expect(getChannels().focus).toEqual({ channelId: 'c1', messageId: 'm1' })
    expect(calls.at(-1)).toEqual({ before: AT, beforeId: 'm2' })
  })
})
