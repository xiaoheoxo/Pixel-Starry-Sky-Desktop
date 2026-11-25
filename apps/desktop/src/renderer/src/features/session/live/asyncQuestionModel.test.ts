import { describe, expect, it } from 'vitest'
import type { Item, Question } from '@pixelsky/protocol'
import { findActiveAsyncQuestion, formatAsyncAnswer } from './asyncQuestionModel'

const qChoice: Question = {
  id: 'aq-0',
  question: '选择哪种数据库？',
  header: '',
  multiSelect: false,
  allowOther: true,
  options: [
    { label: 'PostgreSQL (Recommended)', description: '' },
    { label: 'SQLite', description: '' },
  ],
}

const qFree: Question = {
  id: 'aq-1',
  question: '补充说明？',
  header: '',
  multiSelect: false,
  allowOther: false,
  options: [],
}

describe('findActiveAsyncQuestion', () => {
  it('在本轮结束后仍保留未作答的异步提问，不因后续普通助手回复或自动重连消息消失', () => {
    const items: Item[] = [
      { kind: 'user', id: 'u1', text: '帮我搭服务', createdAt: 1 },
      { kind: 'assistant', id: 'a-ask', text: '选择哪种数据库？', status: 'completed', questions: [qChoice] },
      { kind: 'assistant', id: 'a-follow', text: '我先把目录结构建好，等你确认数据库。', status: 'completed' },
      { kind: 'user', id: 'u-reconn', text: '继续', createdAt: 2, reconnect: 1 },
    ]
    expect(findActiveAsyncQuestion(items, new Set())).toEqual({
      itemId: 'a-ask',
      questions: [qChoice],
    })
  })

  it('一旦后续出现真实用户消息（非重连、非已丢弃失败项）或被用户跳过，立即收起', () => {
    const items: Item[] = [
      { kind: 'user', id: 'u1', text: '帮我搭服务', createdAt: 1 },
      { kind: 'assistant', id: 'a-ask', text: '选择哪种数据库？', status: 'completed', questions: [qChoice] },
    ]
    expect(findActiveAsyncQuestion(items, new Set(['a-ask']))).toBeNull()

    // 发送失败后被点「关掉」的未送达消息不算已回复
    const withDismissed: Item[] = [
      ...items,
      { kind: 'user', id: 'u-fail', text: 'PostgreSQL', createdAt: 2, dismissed: true },
    ]
    expect(findActiveAsyncQuestion(withDismissed, new Set())?.itemId).toBe('a-ask')

    // 真实发出的用户消息使之前的异步提问自动收起
    const withReply: Item[] = [...items, { kind: 'user', id: 'u2', text: 'PostgreSQL', createdAt: 3 }]
    expect(findActiveAsyncQuestion(withReply, new Set())).toBeNull()
  })

  it('已中断 / 拒绝的条目不挂出提问卡；队列中已有待发送用户消息时自动收起，撤回或失败后恢复', () => {
    const interrupted: Item[] = [
      { kind: 'user', id: 'u1', text: '帮我搭服务', createdAt: 1 },
      { kind: 'assistant', id: 'a-int', text: '选择哪种数据库？', status: 'interrupted', questions: [qChoice] },
    ]
    expect(findActiveAsyncQuestion(interrupted, new Set())).toBeNull()

    const active: Item[] = [
      { kind: 'user', id: 'u1', text: '帮我搭服务', createdAt: 1 },
      { kind: 'assistant', id: 'a-ask', text: '选择哪种数据库？', status: 'completed', questions: [qChoice] },
    ]
    const baseQueue = {
      id: 'q1',
      text: 'SQLite',
      createdAt: 2,
      settings: { model: null, effort: null, platform: null },
      error: null,
      mode: 'normal' as const,
    }
    expect(findActiveAsyncQuestion(active, new Set(), [{ ...baseQueue, status: 'queued' }])).toBeNull()
    expect(findActiveAsyncQuestion(active, new Set(), [{ ...baseQueue, status: 'delivering' }])).toBeNull()
    // 当前轮自身的 running 队列项（发起本轮的那条消息）在整轮运行期间都在队里，不能把运行中的异步提问卡藏掉
    expect(findActiveAsyncQuestion(active, new Set(), [{ ...baseQueue, status: 'running' }])?.itemId).toBe('a-ask')
    // 失败项、单独暂停项或断线重连项不算已回复
    expect(findActiveAsyncQuestion(active, new Set(), [{ ...baseQueue, status: 'failed' }])?.itemId).toBe('a-ask')
    expect(findActiveAsyncQuestion(active, new Set(), [{ ...baseQueue, status: 'queued', held: true }])?.itemId).toBe(
      'a-ask',
    )
  })
})

describe('formatAsyncAnswer', () => {
  it('单题直接发答案正文，多题按题面分段拼接', () => {
    expect(formatAsyncAnswer([qChoice], { [qChoice.question]: 'PostgreSQL (Recommended)' })).toBe(
      'PostgreSQL (Recommended)',
    )
    expect(
      formatAsyncAnswer([qChoice, qFree], {
        [qChoice.question]: 'SQLite',
        [qFree.question]: '本地单机运行即可',
      }),
    ).toBe('选择哪种数据库？\nSQLite\n\n补充说明？\n本地单机运行即可')
  })
})
