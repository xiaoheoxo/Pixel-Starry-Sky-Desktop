import { describe, expect, it } from 'vitest'
import type { ChannelMember, ChannelMessage } from '@/data/types'
import { messageWorkspace } from './format'

describe('messageWorkspace', () => {
  const agent = { id: 'a1', kind: 'agent', config: { projectId: 'p1' } } as unknown as ChannelMember
  const human = { id: 'u1', kind: 'human' } as ChannelMember
  const members = new Map([
    ['a1', agent],
    ['u1', human],
  ])
  const task = (land?: unknown) =>
    new Map([['t1', { kind: 'task', id: 't1', assigneeId: 'a1', sessionId: 's1', land } as unknown as ChannelMessage]])
  it('任务结果按卡片的会话；合并过的卡按成员项目；AI 消息按作者项目；真人是 null', () => {
    expect(messageWorkspace({ taskId: 't1', authorId: 'a1' }, task(), members)).toEqual({
      sessionId: 's1',
      projectId: null,
    })
    expect(messageWorkspace({ taskId: 't1', authorId: 'a1' }, task({ kind: 'merged' }), members)).toEqual({
      sessionId: null,
      projectId: 'p1',
    })
    expect(messageWorkspace({ authorId: 'a1' }, new Map(), members)).toEqual({ sessionId: null, projectId: 'p1' })
    expect(messageWorkspace({ authorId: 'u1' }, new Map(), members)).toBeNull()
  })
})
