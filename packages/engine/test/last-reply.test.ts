// 一轮结束时取「最后一句回复」的条目：从末尾往前，到普通用户消息为止（SessionRecord.lastReply）
import { describe, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import { lastTurnReply } from '../src/host/events'

const user = (id: string, mode?: 'guidance'): Item => ({ kind: 'user', id, text: id, createdAt: 0, mode })
const say = (id: string, text: string, status: 'completed' | 'interrupted' = 'completed'): Item => ({
  kind: 'assistant',
  id,
  text,
  status,
})
const tool = (id: string): Item => ({ kind: 'notice', id, level: 'info', text: id })

describe('lastTurnReply', () => {
  it('取这一轮最后一条 assistant，并去掉 Markdown 记号', () => {
    expect(lastTurnReply([user('u1'), say('a1', '先看看'), tool('t'), say('a2', '## 改好了\n请 **重启**')])).toBe(
      '改好了 请 重启',
    )
  })

  it('只有用户消息、或最后一个普通用户消息之后没有回复：undefined（保留旧值，不拿上一轮的充数）', () => {
    expect(lastTurnReply([])).toBeUndefined()
    expect(lastTurnReply([user('u1')])).toBeUndefined()
    expect(lastTurnReply([user('u1'), say('a1', '旧回复'), user('u2'), tool('t')])).toBeUndefined()
  })

  it('中断的一轮也算；中途的引导消息不是这一轮的起点；空回复往前找', () => {
    expect(lastTurnReply([user('u1'), say('a1', '写到一半', 'interrupted')])).toBe('写到一半')
    expect(lastTurnReply([user('u1'), say('a1', '第一段'), user('g', 'guidance'), say('a2', '改方向了')])).toBe(
      '改方向了',
    )
    expect(lastTurnReply([user('u1'), say('a1', '有内容'), say('a2', '   ')])).toBe('有内容')
  })
})
