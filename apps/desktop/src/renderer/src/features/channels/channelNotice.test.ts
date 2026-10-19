import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { Channel, ChannelMember, ChannelMessage, ChannelTask } from '@/data/types'
import { channelNotice, taskOfNotice } from './channelNotice'

// 频道派出去的会话的提醒（docs/ui/channels-local-ai.md §3.1 #12、#13）

const channel = (notify?: Channel['notify']): Channel => ({
  id: 'c1',
  name: '网页版改版',
  topic: null,
  scope: 'local',
  memberIds: ['you', 'a1'],
  unread: 0,
  createdAt: 0,
  ...(notify ? { notify } : {}),
})
const member = { id: 'a1', kind: 'agent', name: '前端助手' } as ChannelMember
const task = { kind: 'task', id: 't1', channelId: 'c1', title: '迁移设置页表单' } as ChannelTask
const state = (notify?: Channel['notify'], loaded = true) => ({
  sessionTasks: { s1: { channelId: 'c1', taskId: 't1', memberId: 'a1' } },
  channels: [channel(notify)],
  members: [member],
  messages: (loaded ? { c1: [task] } : {}) as Record<string, ChannelMessage[]>,
})
const intent = (kind: 'completed' | 'failed' | 'waiting', sessionId = 's1') => ({
  kind,
  sessionId,
  dedupeKey: `${kind}:x`,
})

describe('channelNotice', () => {
  it('频道派出去的会话：标题写「#频道 · 成员」，正文写做完 / 没做成 / 等你确认', () => {
    const done = channelNotice(intent('completed'), '', state(), '会话标题')!
    expect(done).toMatchObject({
      title: '#网页版改版 · 前端助手',
      body: '做完了：迁移设置页表单',
      channelId: 'c1',
      taskId: 't1',
    })
    expect(channelNotice(intent('failed'), '额度不足', state(), null)!.body).toBe('没做成：额度不足')
    expect(channelNotice(intent('waiting'), '运行 pnpm  test', state(), null)!.body).toBe('等你确认：运行 pnpm test')
    expect(channelNotice(intent('waiting'), '', state(), null)!.body).toBe('等你确认：迁移设置页表单')
  })
  it('任务卡还没读进来：用会话标题（频道开的会话用任务标题命名）', () => {
    expect(channelNotice(intent('completed'), '', state(undefined, false), '迁移设置页表单')!.body).toBe(
      '做完了：迁移设置页表单',
    )
  })
  it('不是频道开的会话、频道已经删了：null，照会话的提醒发', () => {
    expect(channelNotice(intent('completed', 's2'), '', state(), null)).toBeNull()
    expect(channelNotice(intent('completed'), '', { ...state(), channels: [] }, null)).toBeNull()
  })
  it('提醒级别：全部都发；只提醒要我处理的不发「做完」；不提醒都不发', () => {
    const muted = (notify: Channel['notify'] | undefined, kind: 'completed' | 'failed' | 'waiting') =>
      channelNotice(intent(kind), '', state(notify), null)!.muted
    expect([muted(undefined, 'completed'), muted('all', 'completed')]).toEqual([false, false])
    expect([muted('important', 'completed'), muted('important', 'failed'), muted('important', 'waiting')]).toEqual([
      true,
      false,
      false,
    ])
    expect([muted('mute', 'waiting'), muted('mute', 'failed')]).toEqual([true, true])
  })
  it('点了提醒：从 id 认出频道和任务卡；别的提醒不认', () => {
    const { id } = channelNotice(intent('waiting'), '', state(), null)!
    expect(taskOfNotice(id)).toEqual({ channelId: 'c1', taskId: 't1' })
    // 同一张卡的提醒用同一个 id（新的顶替旧的）；真实 id 是 UUID，合计不超过主进程的 100 字
    expect(channelNotice(intent('completed'), '', state(), null)!.id).toBe(id)
    const uuid = '0b6f4c1e-7d2a-4f5b-9c3d-2e8a1f6b7c9d'
    const real = {
      ...state(),
      sessionTasks: { s1: { channelId: uuid, taskId: uuid, memberId: 'a1' } },
      channels: [{ ...channel(), id: uuid }],
    }
    expect(channelNotice(intent('completed'), '', real, null)!.id.length).toBeLessThanOrEqual(100)
    expect(taskOfNotice('waiting:s1:r1')).toBeNull()
    expect(taskOfNotice('feedback|x')).toBeNull()
  })
})
