import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { Channel, ChannelMessage } from '@/data/types'
import { hitPlace, searchLoaded } from './search'

// 频道消息搜索（docs/ui/channels-local-ai.md §3.1 #8）

const channel = (id: string, patch: Partial<Channel> = {}): Channel => ({
  id,
  name: id === 'c1' ? '网页版' : '旧项目',
  topic: null,
  scope: 'local',
  memberIds: [],
  unread: 0,
  createdAt: 0,
  ...patch,
})
const text = (id: string, channelId: string, at: number, body: string): ChannelMessage => ({
  kind: 'message',
  id,
  channelId,
  at,
  authorId: 'you',
  text: body,
  format: 'plain',
})
const messages: Record<string, ChannelMessage[]> = {
  c1: [
    text('m1', 'c1', 1, '首页的 Banner 要换'),
    { kind: 'task', id: 't1', channelId: 'c1', at: 2, title: '换掉首页 banner', assigneeId: 'a1' } as ChannelMessage,
    { kind: 'event', id: 'e1', channelId: 'c1', at: 3, event: 'renamed', actorId: 'you', value: '首页 banner' },
  ],
  c2: [text('m2', 'c2', 4, 'banner 尺寸 1200×400，首页用'), text('m3', 'c2', 5, '无关')],
}

describe('searchLoaded', () => {
  it('搜文字消息和任务卡标题（不搜事件）：每个词都要出现、不分大小写，新的在前', () => {
    const { hits, truncated } = searchLoaded([channel('c1'), channel('c2')], messages, '首页 BANNER', { limit: 10 })
    expect(truncated).toBe(false)
    expect(hits.map(h => [h.messageId, h.kind, h.authorId])).toEqual([
      ['m2', 'message', 'you'],
      ['t1', 'task', 'a1'],
      ['m1', 'message', 'you'],
    ])
    expect(hits[0].snippet.filter(f => f.match).map(f => f.text)).toEqual(['banner', '首页'])
  })
  it('空搜索词没有结果；超过上限标出来；按默认项目筛；团队频道不搜', () => {
    const all = [channel('c1', { projectId: 'p1' }), channel('c2')]
    expect(searchLoaded(all, messages, '  ', { limit: 10 }).hits).toEqual([])
    expect(searchLoaded(all, messages, 'banner', { limit: 2 })).toMatchObject({ truncated: true, hits: [{}, {}] })
    expect(searchLoaded(all, messages, 'banner', { limit: 10, projectId: 'p1' }).hits.map(h => h.channelId)).toEqual([
      'c1',
      'c1',
    ])
    expect(searchLoaded([channel('c1', { scope: 'team' })], messages, 'banner', { limit: 10 }).hits).toEqual([])
  })
})

describe('hitPlace', () => {
  it('频道名、作者名，归档的频道注明；找不到的写 ?', () => {
    const names = new Map([['you', '林夏']])
    const [hit] = searchLoaded([channel('c2', { archivedAt: 9 })], messages, '尺寸', { limit: 10 }).hits
    expect(hitPlace(hit, [channel('c2', { archivedAt: 9 })], names)).toEqual({
      channel: '旧项目',
      archived: true,
      author: '林夏',
    })
    expect(hitPlace(hit, [], new Map())).toEqual({ channel: '?', archived: false, author: '?' })
  })
})
