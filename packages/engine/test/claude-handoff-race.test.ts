import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { EngineEvent, SessionRecord } from '@pixelsky/protocol'
import { ClaudeSession } from '../src/claude/session'
import { encodeCwd } from '../src/claude/transcript'

const gate = vi.hoisted(() => ({ waiting: null as Promise<void> | null, entered: vi.fn() }))
vi.mock('../src/claude/transcript-index', async importOriginal => {
  const original = await importOriginal<typeof import('../src/claude/transcript-index')>()
  return {
    ...original,
    transcriptIndex: async (...args: Parameters<typeof original.transcriptIndex>) => {
      if (gate.waiting) {
        gate.entered()
        await gate.waiting
        gate.waiting = null
      }
      return original.transcriptIndex(...args)
    },
  }
})

it('异步注入旧交接期间停止并重发，保留新一轮的交接材料', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pixelsky-handoff-race-'))
  const projectsDir = join(root, 'projects')
  const sid = '11111111-1111-4111-8111-111111111111'
  const projectDir = join(projectsDir, encodeCwd(root))
  mkdirSync(projectDir, { recursive: true })
  const file = join(projectDir, `${sid}.jsonl`)
  writeFileSync(
    file,
    [
      { type: 'user', uuid: 'u0', parentUuid: null },
      { type: 'assistant', uuid: 'a0', parentUuid: 'u0' },
    ]
      .map(row => JSON.stringify(row))
      .join('\n') + '\n',
  )
  const record: SessionRecord = {
    id: sid,
    projectId: 'project',
    cwd: root,
    engine: 'claude',
    engineSessionId: sid,
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
      projectsDir,
      env: { ...process.env, FAKE_CLAUDE_PROJECTS: projectsDir, FAKE_CLAUDE_CHAIN: '1' },
    },
  )
  let release!: () => void
  gate.waiting = new Promise<void>(resolve => {
    release = resolve
  })
  try {
    session.send('bare-1', 't1', 'input-1', undefined, {
      overview: null,
      turns: [{ id: '22222222-2222-4222-8222-222222222222', user: 'seed-1', assistant: 'reply-1' }],
      fallback: 'FALLBACK-1',
    })
    await vi.waitFor(() => expect(gate.entered).toHaveBeenCalled())
    await session.interrupt()
    session.send('bare-2', 't2', 'input-2', undefined, {
      overview: null,
      turns: [{ id: '33333333-3333-4333-8333-333333333333', user: 'seed-2', assistant: 'reply-2' }],
      fallback: 'FALLBACK-2',
    })
    release()
    await vi.waitFor(
      () =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'turn_completed',
            turnId: 't2',
            outcome: 'completed',
          }),
        ),
      { timeout: 10_000 },
    )
    const users = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { type: string; uuid?: string; text?: string })
      .filter(row => row.type === 'user' && row.uuid?.startsWith('input-'))
    expect(users.map(row => row.text)).toEqual(['FALLBACK-2\n\nbare-2'])
  } finally {
    release()
    await session.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
