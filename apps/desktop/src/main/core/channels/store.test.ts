import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChannelTask } from '../../../shared/types/channels'
import { ChannelStore } from './store'

let dir: string
beforeEach(async () => {
  const scratch = resolve('../../scratch')
  await mkdir(scratch, { recursive: true })
  dir = await mkdtemp(join(scratch, 'channel-store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('ChannelStore', () => {
  it('整理 messages.jsonl 时任务卡也不写只在内存里的字段（和 patchTask 一致）', async () => {
    const store = new ChannelStore(dir)
    await store.init()
    await store.saveChannel({
      id: 'c1',
      name: '频道',
      topic: null,
      projectId: null,
      memberIds: [],
      createdAt: 1,
      readAt: 0,
    })
    const task: ChannelTask = {
      kind: 'task',
      id: 't1',
      channelId: 'c1',
      at: 1,
      authorId: 'you',
      assigneeId: 'm1',
      title: '改设置页',
      status: 'running',
    }
    await store.append(task)
    store.patchTask('c1', 't1', {
      progress: { done: 1, total: 2 },
      request: null,
      waitingCount: 2,
      activity: null,
      ahead: 3,
      disconnected: true,
    })
    // 写够多行触发整理
    for (let i = 0; i < 60; i++) store.patchTask('c1', 't1', { summary: `第 ${i} 次` })
    await store.flush()
    const lines = (await readFile(join(dir, 'c1', 'messages.jsonl'), 'utf8')).trim().split('\n')
    expect(lines.length).toBeLessThan(20)
    for (const line of lines)
      for (const key of ['progress', 'request', 'activity']) expect(JSON.parse(line)).not.toHaveProperty(key)
    const again = new ChannelStore(dir)
    await again.init()
    expect(again.task('t1')).toMatchObject({ status: 'running', summary: '第 59 次' })
    expect(again.task('t1')).not.toHaveProperty('progress')
    // 排队位置、机器断开、待确认项数照旧写盘（追加时就写，整理不改变这一点）
    expect(again.task('t1')).toMatchObject({ ahead: 3, disconnected: true, waitingCount: 2 })
  })
})
