import { describe, expect, it } from 'vitest'
import type { QueuedMessage, SessionSnapshot } from '@pixelsky/protocol'
import {
  canSteer,
  isPending,
  isReconnecting,
  queueErrorText,
  queueItems,
  queueLabel,
  queueMoveArg,
  queueMoveTarget,
  queueTitle,
} from './queue'

const q = (id: string, patch: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id,
  text: id,
  createdAt: 0,
  settings: {} as QueuedMessage['settings'],
  status: 'queued',
  error: null,
  mode: 'normal',
  ...patch,
})

describe('消息队列面板', () => {
  it('不显示正在执行的，也不显示空闲时直接发送、正在启动的（那些在对话里）', () => {
    const queue = [
      q('run', { status: 'running' }),
      q('direct', { direct: true }),
      q('wait'),
      q('fail', { direct: true, status: 'failed' }),
    ]
    expect(queueItems({ queue, queuePaused: false }).map(i => i.id)).toEqual(['wait', 'fail'])
    // 队列暂停时，直接发送的也留在队列里等「继续队列」
    expect(queueItems({ queue, queuePaused: true }).map(i => i.id)).toEqual(['direct', 'wait', 'fail'])
  })

  it('每条的状态和面板标题', () => {
    expect(queueLabel(q('a'))).toBe('排队中')
    expect(queueLabel(q('a', { held: true }))).toBe('已暂停')
    expect(queueLabel(q('a', { direct: true, status: 'failed' }))).toBe('发送失败')
    expect(queueLabel(q('a', { status: 'failed' }))).toBe('执行失败')
    expect(queueLabel(q('a', { status: 'uncertain' }))).toBe('待核对')
    expect(queueTitle([q('a', { direct: true, status: 'failed' })], false)).toBe('发送失败')
    expect(queueTitle([q('a')], true)).toBe('队列已暂停')
    expect(queueTitle([q('a', { held: true })], false)).toBe('队列已暂停')
    expect(queueTitle([q('a')], false)).toBe('排队中')
    expect(isPending(q('a', { status: 'delivering' }))).toBe(true)
  })

  it('自动重连中的那条：单独暂停的不算，整个队列暂停时写「重连已暂停」', () => {
    const reconnect = { attempt: 2, max: 5, at: 10, since: 0, reason: '', resend: false }
    expect(isReconnecting(q('a', { reconnect }))).toBe(true)
    expect(isReconnecting(q('a', { reconnect, held: true }))).toBe(false)
    expect(queueLabel(q('a', { reconnect }))).toBe('正在重连 2/5')
    expect(queueLabel(q('a', { reconnect }), true)).toBe('重连已暂停 2/5')
    expect(queueLabel(q('a', { reconnect, held: true }))).toBe('已暂停')
  })

  it('引导：要排队中、引擎支持、正在跑一轮', () => {
    const running = { state: 'running', turnId: 't1', flags: { steerAvailable: true } } as SessionSnapshot
    expect(canSteer(q('a'), running)).toBe(true)
    expect(canSteer(q('a', { status: 'failed' }), running)).toBe(false)
    expect(canSteer(q('a'), { ...running, flags: { ...running.flags, steerAvailable: false } })).toBe(false)
    expect(canSteer(q('a'), { ...running, state: 'idle', turnId: null })).toBe(false)
  })
})

describe('队列调序', () => {
  const list = ['a', 'b', 'c'].map(id => q(id))
  it('按邻居的消息 id 算目标，不用下标', () => {
    expect(queueMoveTarget(list, 'b', -1)).toEqual({ before: 'a' })
    expect(queueMoveTarget(list, 'a', 1)).toEqual({ before: 'c' })
    expect(queueMoveTarget(list, 'b', 1)).toEqual({ before: null })
    expect(queueMoveTarget(list, 'a', -1)).toBeNull()
    expect(queueMoveTarget(list, 'c', 1)).toBeNull()
    expect(queueMoveTarget([q('a', { status: 'delivering' }), q('b')], 'b', -1)).toBeNull()
  })
  it('电脑回「队列已变化」（带代码的错误）时写成中文，别的错误原样', () => {
    expect(queueErrorText('PIXELSKY_ERR:{"code":"queue.changed"}')).toBe('队列已变化，排序未保存')
    expect(queueErrorText('Error: PIXELSKY_ERR:{"code":"queue.changed"}')).toBe('Error: 队列已变化，排序未保存')
    expect(queueErrorText('只有排队中的消息可以调序')).toBe('只有排队中的消息可以调序')
  })
})

describe('queueMoveArg：按电脑能力选调序参数', () => {
  const queue = [q('a', { status: 'running' }), q('b'), q('c'), q('d')]
  const items = queue.slice(1)
  it('电脑认得 queueMoveBefore：发 { before }', () => {
    expect(queueMoveArg(queue, items, 'c', -1, true)).toEqual({ before: 'b' })
    expect(queueMoveArg(queue, items, 'c', 1, true)).toEqual({ before: null })
  })
  it('旧版电脑：和旧版手机一样发整个队列里的下标 ±1', () => {
    expect(queueMoveArg(queue, items, 'c', -1, false)).toBe(1)
    expect(queueMoveArg(queue, items, 'c', 1, false)).toBe(3)
    expect(queueMoveArg(queue, items, 'b', -1, false)).toBe(0)
    expect(queueMoveArg(queue, items, 'd', 1, false)).toBeNull()
    expect(queueMoveArg(queue, items, 'a', -1, false)).toBeNull()
  })
  it('重连中的那条不当锚点', () => {
    const r = [q('r', { reconnect: { attempt: 1, max: 3, at: 0 } as QueuedMessage['reconnect'] }), q('b'), q('c')]
    expect(queueMoveTarget(r, 'b', -1)).toBeNull()
    expect(queueMoveTarget(r, 'b', 1)).toEqual({ before: null })
  })
})
