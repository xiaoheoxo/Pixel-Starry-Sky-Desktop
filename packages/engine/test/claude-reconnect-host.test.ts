// PR #96 断线自动重连：真实 EngineHost + 假 Claude 子进程，看「送达标记」决定重连发什么
//   回显开着（FAKE_CLAUDE_REPLAY=1）：断线前引擎已确认收到 → delivered，重连只发「继续」
//   回显没开：无法确认 → 没送达，重连原样重发原文，对话里这条用户消息只有一条
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import { ClaudeAdapter, EngineHost } from '../src'
import { helpersExited } from '../src/claude/helper'

const FAKE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))

let root: string
let hosts: EngineHost[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-reconnect-host-'))
  hosts = []
})
afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  await helpersExited()
  rmSync(root, { recursive: true, force: true })
})

function setup(replay: boolean, delay: number) {
  const adapter = new ClaudeAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    projectsDir: join(root, 'claude-projects'),
    env: {
      ...process.env,
      ...(replay ? { FAKE_CLAUDE_REPLAY: '1' } : {}),
      FAKE_CLAUDE_PROJECTS: join(root, 'claude-projects'),
      FAKE_CLAUDE_IMAGES: join(root, 'inputs.log'),
      FAKE_CLAUDE_DROP_FLAG: join(root, 'dropped.flag'),
    },
  })
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    emit: () => {},
    idleMs: 60_000,
    adapters: { claude: adapter },
    reconnectDelays: [delay, delay, delay],
  })
  hosts.push(host)
  const project = host.addProject(root)
  const record = host.createSession({ projectId: project.id, engine: 'claude' })
  const inputs = (): string[] => {
    try {
      return readFileSync(join(root, 'inputs.log'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => (JSON.parse(l) as { text: string }).text)
    } catch {
      return []
    }
  }
  const users = () =>
    host
      .open(record.id)
      .items.filter((i): i is Extract<Item, { kind: 'user' }> => i.kind === 'user')
      .map(i => ({ text: i.text, reconnect: i.reconnect }))
  const queue = () => host.open(record.id).queue
  return { host, record, inputs, users, queue }
}

async function waitFor<T>(pick: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = pick()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 20))
  }
}

describe('Claude 断线自动重连（host + 假 Claude）', () => {
  it('回显开着：断线前已确认收到 → delivered，重连只发「继续」不重发原文', async () => {
    // 延时 600ms：让「等重连」的状态停留一会儿，好读队列项
    const { host, record, inputs, users, queue } = setup(true, 600)
    await host.send(record.id, { text: '断线前的这句话', clientMessageId: 'm1' })
    const waiting = await waitFor(() => queue().find(q => q.id === 'm1' && q.reconnect && q.status === 'queued'))
    expect(waiting.delivered).toBe(true)
    expect(waiting.reconnect).toMatchObject({ attempt: 1 })
    expect(waiting.reconnect?.resend).toBeFalsy()

    await waitFor(() => host.open(record.id).state === 'idle' && queue().length === 0)
    const sent = inputs()
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe('断线前的这句话')
    expect(sent[1].split('\n').at(-1)).toBe('继续')
    expect(sent.filter(t => t.includes('断线前的这句话'))).toHaveLength(1)
    expect(users().filter(u => u.text === '断线前的这句话')).toHaveLength(1)
    expect(users().some(u => u.reconnect === 1)).toBe(true)
  })

  it('不开回显：无输出断线 → 没送达，重连原样重发原文，对话里这条只有一条', async () => {
    const { host, record, inputs, users, queue } = setup(false, 600)
    await host.send(record.id, { text: '断线前的这句话', clientMessageId: 'm1' })
    const waiting = await waitFor(() => queue().find(q => q.id === 'm1' && q.reconnect && q.status === 'queued'))
    expect(waiting.delivered).toBeFalsy()
    expect(waiting.reconnect).toMatchObject({ attempt: 1, resend: true })

    await waitFor(() => host.open(record.id).state === 'idle' && queue().length === 0)
    const sent = inputs()
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe('断线前的这句话')
    expect(sent[1].split('\n').at(-1)).toBe('断线前的这句话')
    expect(sent.some(t => t.split('\n').at(-1) === '继续')).toBe(false)
    expect(users().filter(u => u.text.includes('断线前的这句话'))).toEqual([
      { text: '断线前的这句话', reconnect: undefined },
    ])
    expect(users().some(u => u.reconnect)).toBe(false)
  })
})
