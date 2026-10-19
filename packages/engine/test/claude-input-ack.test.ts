// Claude 回显（--replay-user-messages）发出去的用户消息时，适配器发 normal 的 input_ack（PR #96：宿主据此判断断线时有没有送达）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent, SessionRecord } from '@pixelsky/protocol'
import { ClaudeSession } from '../src/claude/session'

let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function runTurns(replay: boolean, inputs: string[]): Promise<EngineEvent[]> {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-input-ack-'))
  const record: SessionRecord = {
    id: 'sess',
    projectId: 'project',
    cwd: root,
    engine: 'claude',
    engineSessionId: '11111111-1111-4111-8111-111111111111',
    title: 'test',
    model: null,
    effort: null,
    permissionMode: 'ask',
    ultracode: false,
    fast: false,
    thinkingSummaries: true,
    createdAt: 0,
    updatedAt: 0,
    lastOutcome: null,
  }
  const events: EngineEvent[] = []
  const session = new ClaudeSession(
    {
      record: () => record,
      emit: event => events.push(event),
      setEngineSessionId: id => {
        record.engineSessionId = id
      },
      setPermissionMode: vi.fn(),
      setUltracode: vi.fn(),
      setFast: vi.fn(),
    },
    {
      launcher: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))],
      },
      projectsDir: join(root, 'projects'),
      env: { ...process.env, ...(replay ? { FAKE_CLAUDE_REPLAY: '1' } : {}) },
    },
  )
  try {
    for (const [i, id] of inputs.entries()) {
      session.send(`第${i + 1}句`, `turn-${i + 1}`, id)
      await vi.waitFor(
        () =>
          expect(events).toContainEqual(
            expect.objectContaining({ type: 'turn_completed', turnId: `turn-${i + 1}`, outcome: 'completed' }),
          ),
        { timeout: 10_000 },
      )
    }
  } finally {
    await session.close()
  }
  return events
}

describe('Claude 适配器的 input_ack', () => {
  it('开启回显：每轮发一次 normal 的 consumed 确认，id 是这一轮的用户消息', async () => {
    const events = await runTurns(true, ['input-1', 'input-2'])
    const acks = events.filter(e => e.type === 'input_ack')
    expect(acks).toEqual([
      { type: 'input_ack', id: 'input-1', state: 'consumed', mode: 'normal' },
      { type: 'input_ack', id: 'input-2', state: 'consumed', mode: 'normal' },
    ])
  }, 20_000)

  it('没有回显：不发 input_ack', async () => {
    const events = await runTurns(false, ['input-1'])
    expect(events.filter(e => e.type === 'input_ack')).toEqual([])
  }, 20_000)
})
