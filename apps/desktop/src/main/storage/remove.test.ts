import { describe, expect, it } from 'vitest'
import { removeSessions, type SessionRemover } from './remove'

interface Fake {
  record: { id: string }
  state: string
  background?: boolean
}

const fakeHost = (items: Fake[], onDelete?: (id: string) => void): SessionRemover & { deleted: string[] } => {
  const deleted: string[] = []
  return {
    deleted,
    sessions: () => items.filter(s => !deleted.includes(s.record.id)),
    deleteSession: async id => {
      onDelete?.(id)
      await Promise.resolve()
      deleted.push(id)
    },
  }
}

describe('removeSessions', () => {
  it('rechecks each session right before deleting it', async () => {
    const items: Fake[] = [
      { record: { id: 'a' }, state: 'idle' },
      { record: { id: 'b' }, state: 'idle' },
    ]
    // 删 a 的期间 b 开始跑了
    const host = fakeHost(items, id => {
      if (id === 'a') items[1].state = 'running'
    })
    const result = await removeSessions(host, ['a', 'b'])
    expect(result.done).toEqual(['a'])
    expect(result.failed).toEqual([{ id: 'b', message: '会话正在运行' }])
    expect(host.deleted).toEqual(['a'])
  })

  it('skips missing, busy and background sessions and reports delete errors', async () => {
    const host = fakeHost([
      { record: { id: 'busy' }, state: 'running' },
      { record: { id: 'bg' }, state: 'idle', background: true },
      { record: { id: 'ok' }, state: 'idle' },
      { record: { id: 'bad' }, state: 'idle' },
    ])
    const del = host.deleteSession
    host.deleteSession = async id => {
      if (id === 'bad') throw new Error('boom')
      return del(id)
    }
    const result = await removeSessions(host, ['gone', 'busy', 'bg', 'ok', 'bad'])
    expect(result.done).toEqual(['ok'])
    expect(result.failed).toEqual([
      { id: 'gone', message: '会话不存在' },
      { id: 'busy', message: '会话正在运行' },
      { id: 'bg', message: '会话正在运行' },
      { id: 'bad', message: 'boom' },
    ])
  })
})
