// 第一次进频道读消息期间推过来的消息：先记下，读完和这一页并在一起，不丢
import { describe, expect, it, vi } from 'vitest'
import type { ChannelMessage } from '../../../../shared/types/channels'

const message = (id: string, at: number): ChannelMessage =>
  ({ kind: 'message', id, channelId: 'c1', authorId: 'self', text: id, format: 'plain', at }) as ChannelMessage

let push: ((e: { channelId: string; message: ChannelMessage }) => void) | null = null
let resolvePage: ((page: { messages: ChannelMessage[]; more: boolean }) => void) | null = null
const bridge = {
  onChange: () => () => undefined,
  onMessage: (fn: typeof push) => {
    push = fn
    return () => undefined
  },
  state: async () => ({
    channels: [
      { id: 'c1', name: '首读', unread: 0, mentioned: false, memberIds: [] },
      { id: 'c2', name: '没进过', unread: 0, mentioned: false, memberIds: [] },
    ],
    members: [],
    sessionChannels: {},
  }),
  markRead: async () => undefined,
  messages: () => new Promise(r => (resolvePage = r)),
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

describe('频道第一次读消息', () => {
  it('读的同时推过来的消息并进读到的那一页；没在读的频道照旧不记', async () => {
    await new Promise(r => setTimeout(r, 0))
    channelActions.select('c1')
    expect(getChannels().messages.c1).toBeUndefined()
    push!({ channelId: 'c1', message: message('m3', 3000) })
    push!({ channelId: 'c2', message: message('x1', 3000) })
    resolvePage!({ messages: [message('m1', 1000), message('m2', 2000)], more: false })
    await vi.waitFor(() => expect(getChannels().messages.c1?.map(m => m.id)).toEqual(['m1', 'm2', 'm3']))
    expect(getChannels().messages.c2).toBeUndefined()
  })
})
