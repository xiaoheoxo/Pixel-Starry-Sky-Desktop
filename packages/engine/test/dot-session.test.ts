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
  const session = new DotSession(client as unknown as DotClient, ctx, { pollMs: 1, replyTimeoutMs: 200 })
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
