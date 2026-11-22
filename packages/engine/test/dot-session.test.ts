import { describe, expect, it, vi } from 'vitest'
import type { EngineEvent, SessionRecord } from '@pixelsky/protocol'
import type { SessionContext } from '../src/adapter'
import { DotSession } from '../src/dot/session'
import type { DotClient, DotIdentity, DotMessage } from '../src/dot/client'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dot: DotIdentity = { id: 'dot', roomId: 'room', threadId: 'root', memberId: 'bot' }
const reply: DotMessage = {
  id: 'reply',
  account_user_id: 'bot',
  created_at: '2026-11-17T00:00:00Z',
  content: { text: 'Done' },
}

function setup() {
  const events: EngineEvent[] = []
  const client = {
    discover: vi.fn().mockResolvedValue(dot),
    send: vi.fn().mockResolvedValue({ id: 'sent' }),
    upload: vi.fn().mockResolvedValue('uploaded'),
    messages: vi.fn().mockResolvedValue([reply]),
    activity: vi.fn().mockResolvedValue('idle'),
    workflow: vi
      .fn()
      .mockResolvedValue({ id: 'task', title: 'Build', status: 'completed', startedAt: 1, updatedAt: 2 }),
  }
  const ctx = {
    record: () => ({ engineSessionId: null }) as SessionRecord,
    setEngineSessionId: vi.fn(),
    emit: (event: EngineEvent) => events.push(event),
  } as unknown as SessionContext
  const session = new DotSession(client as unknown as DotClient, ctx, {
    pollMs: 1,
    retryMs: [1, 1],
  })
  return { session, events, client, ctx }
}

const completed = (events: EngineEvent[]) => events.filter(e => e.type === 'turn_completed')

describe('Dot session', () => {
  it('does not send text alone or mark delivery uncertain when attachment upload fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dot-upload-'))
    const { session, events, client } = setup()
    try {
      const path = join(root, 'file.txt')
      await writeFile(path, 'file')
      client.upload.mockRejectedValue(new Error('Dot HTTP 413'))
      session.send('with attachment', 'turn', 'user', undefined, undefined, undefined, [
        { id: 'file', name: 'file.txt', bytes: 4, lines: 0, encoding: 'utf-8', text: '', path },
      ])
      await vi.waitFor(() => expect(completed(events)).toHaveLength(1))
      expect(client.send).not.toHaveBeenCalled()
      expect(completed(events)[0]).toMatchObject({ outcome: 'failed', error: 'Dot HTTP 413' })
      expect(events.some(e => e.type === 'input_ack')).toBe(false)
    } finally {
      await session.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('acknowledges confirmed sends and maps Dot replies to standard events', async () => {
    const { session, events, ctx } = setup()
    session.send('hello', 'turn', 'user')
    await vi.waitFor(() => expect(completed(events)).toHaveLength(1))
    expect(ctx.setEngineSessionId).toHaveBeenCalledWith('root')
    expect(events).toContainEqual({ type: 'input_ack', id: 'user', state: 'consumed' })
    expect(events).toContainEqual({
      type: 'item_completed',
      item: {
        id: 'dot-reply',
        kind: 'assistant',
        text: 'Done',
        status: 'completed',
      },
    })
    expect(completed(events)[0]).toMatchObject({ outcome: 'completed' })
    await session.close()
  })

  it('maps attached work to workflows independently of the chat reply', async () => {
    const { session, events, client } = setup()
    client.messages.mockResolvedValue([
      {
        ...reply,
        content: {
          text: 'Done',
          attachments: [{ type: 'thread', thread_id: 'task' }],
        },
      },
    ])
    session.send('build', 'turn', 'user')
    await vi.waitFor(() => expect(completed(events)).toHaveLength(1))
    expect(events.find(e => e.type === 'runs')).toMatchObject({
      runs: { workflows: [{ id: 'task', name: 'Build', status: 'completed' }] },
    })
    await session.close()
  })

  it('marks an ambiguous send uncertain and never replays it', async () => {
    const { session, events, client } = setup()
    client.send.mockRejectedValue(new Error('Dot delivery unknown'))
    session.send('hello', 'turn', 'user')
    await vi.waitFor(() => expect(completed(events)).toHaveLength(1))
    expect(events).toContainEqual({ type: 'input_ack', id: 'user', state: 'uncertain' })
    expect(client.send).toHaveBeenCalledTimes(1)
    expect(completed(events)[0]).toMatchObject({ outcome: 'failed' })
    await session.close()
  })

  it('continues tracking delegated work after the conversational turn ends', async () => {
    const { session, events, client } = setup()
    client.messages.mockResolvedValue([
      {
        ...reply,
        content: {
          text: 'Working on it',
          attachments: [{ type: 'thread', thread_id: 'task' }],
        },
      },
    ])
    client.workflow.mockResolvedValueOnce({
      id: 'task',
      title: 'Build',
      status: 'inProgress',
      startedAt: 1,
      updatedAt: 2,
    })
    session.send('build', 'turn', 'user')
    await vi.waitFor(() => expect(client.workflow).toHaveBeenCalledTimes(2))
    expect(completed(events)[0]).toMatchObject({ outcome: 'completed', background: 1 })
    expect(events.filter(e => e.type === 'runs').at(-1)).toMatchObject({
      runs: { workflows: [{ status: 'completed' }] },
    })
    expect(events.filter(e => e.type === 'background').at(-1)).toMatchObject({ count: 0 })
    await session.close()
  })

  it('a workflow metadata failure does not fail an already received chat reply', async () => {
    const { session, events, client } = setup()
    client.messages.mockResolvedValue([
      {
        ...reply,
        content: {
          text: 'Done',
          attachments: [{ type: 'thread', thread_id: 'task' }],
        },
      },
    ])
    client.workflow.mockRejectedValue(new Error('Dot HTTP 403'))
    session.send('build', 'turn', 'user')
    await vi.waitFor(() => expect(completed(events)).toHaveLength(1))
    expect(completed(events)[0]).toMatchObject({ outcome: 'completed' })
    expect(events.some(e => e.type === 'item_completed' && e.item.kind === 'notice')).toBe(true)
    await session.close()
  })

  // docs/ui/dot-optimize.md §7 #2：读取出错隔一会儿再试，消息已经送达，不能因为一次轮询失败就报整轮失败
  it('retries a failed read while waiting for the reply; the turn still completes', async () => {
    const { session, events, client } = setup()
    client.messages.mockRejectedValueOnce(new Error('Dot network request failed'))
    client.activity.mockRejectedValueOnce(new Error('Dot network request failed'))
    session.send('hello', 'turn', 'user')
    await vi.waitFor(() => expect(completed(events)).toHaveLength(1))
    expect(completed(events)[0]).toMatchObject({ outcome: 'completed', error: null })
    expect(client.messages).toHaveBeenCalledTimes(2)
    expect(client.activity).toHaveBeenCalledTimes(2)
    expect(client.send).toHaveBeenCalledTimes(1)
    await session.close()
  })

  it('gives up after the retries run out, and does not retry errors that retrying cannot fix', async () => {
    const down = setup()
    down.client.messages.mockRejectedValue(new Error('Dot network request failed'))
    down.session.send('hello', 'turn', 'user')
    await vi.waitFor(() => expect(completed(down.events)).toHaveLength(1))
    expect(completed(down.events)[0]).toMatchObject({ outcome: 'failed', error: 'Dot network request failed' })
    expect(down.client.messages).toHaveBeenCalledTimes(3)
    await down.session.close()

    const changed = setup()
    changed.client.messages.mockRejectedValue(new Error('Dot protocol identity or response changed'))
    changed.session.send('hello', 'turn', 'user')
    await vi.waitFor(() => expect(completed(changed.events)).toHaveLength(1))
    expect(changed.client.messages).toHaveBeenCalledTimes(1)
    await changed.session.close()
  })

  it('keeps watching delegated work across a failed status read, and records which message started it', async () => {
    const { session, events, client } = setup()
    client.messages.mockResolvedValue([
      { ...reply, content: { text: 'Working on it', attachments: [{ type: 'thread', thread_id: 'task' }] } },
    ])
    client.workflow
      .mockResolvedValueOnce({ id: 'task', title: 'Build', status: 'inProgress', startedAt: 1, updatedAt: 2 })
      .mockRejectedValueOnce(new Error('Dot network request failed'))
    session.send('build', 'turn', 'user')
    await vi.waitFor(() => expect(client.workflow).toHaveBeenCalledTimes(3))
    await vi.waitFor(() =>
      expect(events.filter(e => e.type === 'runs').at(-1)).toMatchObject({
        runs: { workflows: [{ status: 'completed', toolUseId: 'dot-reply' }] },
      }),
    )
    expect(events.some(e => e.type === 'item_completed' && e.item.kind === 'notice')).toBe(false)
    await session.close()
  })

  // docs/ui/dot-optimize.md §9：回完话后 Dot 怎样算忙完，排队的消息才能接着发
  it('回复后状态不是 active（如 notLoaded）就结束这一轮', async () => {
    const { session, events, client } = setup()
    client.activity.mockResolvedValue('notLoaded')
    session.send('hello', 'turn', 'user')
    await vi.waitFor(() => expect(completed(events)).toHaveLength(1))
    expect(completed(events)[0]).toMatchObject({ outcome: 'completed', error: null })
  })

  it('Dot 在 ChatGPT 里等你处理：结束这一轮并提示一次（回复里已带询问时不重复）', async () => {
    const { session, events, client } = setup()
    client.activity.mockResolvedValue('waiting')
    session.send('hello', 'turn', 'user')
    await vi.waitFor(() => expect(completed(events)).toHaveLength(1))
    expect(completed(events)[0]).toMatchObject({ outcome: 'completed' })
    const notices = (list: EngineEvent[]) =>
      list.flatMap(e => (e.type === 'item_completed' && e.item.kind === 'notice' ? [e.item.text] : []))
    expect(notices(events)).toEqual(['Dot needs your input in ChatGPT'])

    const asked = setup()
    asked.client.messages.mockResolvedValue([{ ...reply, content: { text: '确认一下？', elicitation: {} } }])
    asked.client.activity.mockResolvedValue('waiting')
    asked.session.send('hello', 'turn', 'user')
    await vi.waitFor(() => expect(completed(asked.events)).toHaveLength(1))
    expect(notices(asked.events)).toEqual(['Dot needs your input in ChatGPT'])
  })

  it('回复后 Dot 一直在忙：超过等回复的时限也不报错，忙完照常结束', async () => {
    const { session, events, client } = setup()
    const start = Date.now()
    // A working Dot can deliver several updates before the room becomes idle.
    client.activity.mockImplementation(async () => (Date.now() - start < 400 ? 'active' : 'idle'))
    session.send('hello', 'turn', 'user')
    await vi.waitFor(() => expect(completed(events)).toHaveLength(1), { timeout: 3000 })
    expect(completed(events)[0]).toMatchObject({ outcome: 'completed', error: null })
  })

  it('回复后忙满上限：按完成结束并提示去 ChatGPT 跟进', async () => {
    const events: EngineEvent[] = []
    const client = {
      discover: vi.fn().mockResolvedValue(dot),
      send: vi.fn().mockResolvedValue({ id: 'sent' }),
      messages: vi.fn().mockResolvedValue([reply]),
      activity: vi.fn().mockResolvedValue('active'),
    }
    const ctx = {
      record: () => ({ engineSessionId: null }) as SessionRecord,
      setEngineSessionId: vi.fn(),
      emit: (event: EngineEvent) => events.push(event),
    } as unknown as SessionContext
    const session = new DotSession(client as unknown as DotClient, ctx, { pollMs: 1, busyTimeoutMs: 100 })
    session.send('hello', 'turn', 'user')
    await vi.waitFor(() => expect(completed(events)).toHaveLength(1), { timeout: 3000 })
    expect(completed(events)[0]).toMatchObject({ outcome: 'completed', error: null })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'item_completed',
        item: expect.objectContaining({ text: 'Dot is still working; follow up in ChatGPT' }),
      }),
    )
  })

  it('keeps waiting silently after one minute and accepts a late reply without resending', async () => {
    const { session, events, client } = setup()
    const now = vi.spyOn(Date, 'now')
    const clock = Date.now()
    now.mockReturnValue(clock)
    client.messages.mockResolvedValue([])
    try {
      session.send('hello', 'turn', 'user')
      await vi.waitFor(() => expect(client.messages).toHaveBeenCalled())
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'flags',
          flags: expect.objectContaining({ dotReplyWaitingSince: clock }),
        }),
      )
      now.mockReturnValue(clock + 61_000)
      await vi.waitFor(() => expect(client.messages.mock.calls.length).toBeGreaterThan(1))
      expect(completed(events)).toEqual([])
      expect(client.send).toHaveBeenCalledTimes(1)
      expect(events.filter(e => e.type === 'item_completed')).toEqual([])
      client.messages.mockResolvedValue([reply])
      await vi.waitFor(() => expect(completed(events)).toHaveLength(1))
      expect(completed(events)[0]).toMatchObject({ outcome: 'completed', error: null })
      expect(client.send).toHaveBeenCalledTimes(1)
    } finally {
      now.mockRestore()
      await session.close()
    }
  })

  it('close aborts pending reads and completes a turn exactly once', async () => {
    const { session, events, client } = setup()
    client.messages.mockImplementation(
      (_dot, _after, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    session.send('hello', 'turn', 'user')
    await vi.waitFor(() => expect(client.messages).toHaveBeenCalled())
    await session.close()
    expect(completed(events)).toHaveLength(1)
    expect(completed(events)[0]).toMatchObject({ outcome: 'interrupted' })
  })
})
