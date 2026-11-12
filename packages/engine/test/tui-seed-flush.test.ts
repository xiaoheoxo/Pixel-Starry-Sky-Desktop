// 切 TUI 前落实 seed-only（无 pendingRewind/Fork）边角：docs/ui/tui-toggle.md §5.3
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineId, EngineInfo, Item, SessionRecord } from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, SessionContext, TuiLaunch } from '../src/adapter'
import type { ChatSeed } from '../src/chat-log'
import { EngineHost } from '../src/host'
import type { NativeRead, NativeSessionList, NewerTurns } from '../src/native/types'
import { ENGINES } from '../src/registry'

let root: string
let hosts: EngineHost[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-tui-seed-'))
  hosts = []
})
afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  rmSync(root, { recursive: true, force: true })
})

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('timeout')
}

class FakeSession implements EngineSession {
  active: string | null = null
  inputs: string[] = []
  closed = false
  warmed = 0
  queued: ChatSeed | null = null
  flushed: ChatSeed[] = []
  constructor(
    readonly engine: EngineId,
    readonly ctx: SessionContext,
  ) {}
  send(text: string, turnId: string): void {
    this.active = turnId
    this.inputs.push(text)
    if (!this.ctx.record().engineSessionId) this.ctx.setEngineSessionId(`${this.engine}-sid-${this.inputs.length}`)
    setTimeout(() => this.finish(), 0)
  }
  finish(): void {
    const turnId = this.active
    this.active = null
    if (!turnId) return
    this.ctx.emit({
      type: 'item_completed',
      item: { kind: 'assistant', id: `reply-${turnId}`, text: 'ok', status: 'completed' },
    })
    this.ctx.emit({ type: 'turn_completed', turnId, outcome: 'completed', error: null })
  }
  async interrupt(): Promise<void> {
    const turnId = this.active
    this.active = null
    if (turnId) this.ctx.emit({ type: 'turn_completed', turnId, outcome: 'interrupted', error: null })
  }
  answer(): void {}
  async update(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true
  }
  queueSeed(seed: ChatSeed): void {
    this.queued = seed
  }
  hasQueuedSeed(): boolean {
    return this.queued != null
  }
  async warm(): Promise<void> {
    this.warmed++
    if (!this.ctx.record().engineSessionId) this.ctx.setEngineSessionId(`${this.engine}-warm-${this.warmed}`)
    if (this.ctx.record().pendingRewind) this.ctx.clearPendingRewind?.()
    if (this.ctx.record().pendingFork) this.ctx.clearPendingFork?.()
    if (this.queued) {
      this.flushed.push(this.queued)
      this.queued = null
    }
  }
}

class FakeAdapter implements EngineAdapter {
  sessions: FakeSession[] = []
  constructor(
    readonly engine: EngineId,
    readonly seedsHistory = true,
  ) {}
  async info(): Promise<EngineInfo> {
    return { ...ENGINES[this.engine], status: 'ready', version: '0', path: null, message: null }
  }
  createSession(ctx: SessionContext): FakeSession {
    const s = new FakeSession(this.engine, ctx)
    this.sessions.push(s)
    return s
  }
  /** 终端里聊出来的轮次（syncFromTui 读它） */
  native: Item[] = []
  async nativeSessions(): Promise<NativeSessionList> {
    return { sessions: [] } as unknown as NativeSessionList
  }
  /** 终端里一句没说：Claude Code 不建记录文件 */
  noTranscript = false
  async readNativeSession(): Promise<NativeRead | null> {
    if (this.noTranscript) return null
    return { file: 'x', items: this.native, title: '', turns: 1, shown: 1, summary: null } as NativeRead
  }
  async newerNativeTurns(_cwd: string, _id: string, after: string): Promise<NewerTurns | null> {
    return /^[0-9a-f-]{36}$/.test(after)
      ? ({ items: this.native, turns: 1, shown: 1, gap: 0 } as unknown as NewerTurns)
      : null
  }
  tuiLaunch(record: SessionRecord): TuiLaunch {
    const engineSessionId = record.engineSessionId ?? 'tui-new'
    return {
      command: this.engine,
      args: record.engineSessionId ? ['--resume', engineSessionId] : ['--session-id', engineSessionId],
      env: {},
      cwd: record.cwd,
      engineSessionId,
    }
  }
}

function setup() {
  const claude = new FakeAdapter('claude', true)
  const codex = new FakeAdapter('codex', true)
  const host = new EngineHost({ dataDir: join(root, 'data'), adapters: { claude, codex }, emit: () => {} })
  hosts.push(host)
  const project = host.addProject(root)
  const record = host.createSession({ projectId: project.id, engine: 'claude', model: 'm', effort: 'low' })
  const idle = () => host.open(record.id).state === 'idle' && host.open(record.id).queue.length === 0
  let n = 0
  const say = async (text: string, clientMessageId = `m${++n}`) => {
    await host.send(record.id, { text, clientMessageId })
    await until(() => host.open(record.id).items.some(i => i.kind === 'user' && i.id === clientMessageId))
    await until(idle)
    return clientMessageId
  }
  const snap = () => host.open(record.id)
  const handoff = () =>
    (host as unknown as { m: { handoff: { pendingSeed: (id: string) => Promise<ChatSeed | null> } } }).m.handoff
  return { host, claude, codex, record, say, snap, handoff }
}

describe('TUI seed-only flush (§5.3)', () => {
  it('pendingSeed：换回 Claude 后、尚未发消息时有待写入的接力 seed', async () => {
    const { host, record, say, snap, handoff } = setup()
    await say('claude 一轮')
    await host.update(record.id, { engine: 'codex' })
    await say('codex 一轮')
    await host.update(record.id, { engine: 'claude' })
    expect(snap().record.pendingRewind ?? null).toBeNull()
    expect(snap().record.pendingFork ?? null).toBeNull()
    const seed = await handoff().pendingSeed(record.id)
    expect(seed).not.toBeNull()
    expect(seed!.turns.length).toBeGreaterThan(0)
  })

  it('pendingSeed：无 engineSessions / 无增量时为 null', async () => {
    const { record, say, handoff } = setup()
    expect(await handoff().pendingSeed(record.id)).toBeNull()
    await say('第一句')
    expect(await handoff().pendingSeed(record.id)).toBeNull()
  })

  it('pendingSeed：有 pendingRewind 时返回 null（交给回退 warm 路径）', async () => {
    const { host, record, say, snap, handoff } = setup()
    await say('claude 一轮')
    await host.update(record.id, { engine: 'codex' })
    await say('codex 一轮')
    await host.update(record.id, { engine: 'claude' })
    const rt = (
      host as unknown as { m: { sessions: { runtime: (id: string) => { snapshot: { record: SessionRecord } } } } }
    ).m.sessions.runtime(record.id)
    rt.snapshot.record = { ...rt.snapshot.record, pendingRewind: 'u1' }
    expect(await handoff().pendingSeed(record.id)).toBeNull()
    expect(snap().record.pendingRewind).toBe('u1')
  })

  it('prepareTui：seed-only 会 warm + queueSeed，并推进 engineSessions.seen', async () => {
    const { host, claude, record, say, snap } = setup()
    await say('claude 一轮')
    await host.update(record.id, { engine: 'codex' })
    await say('codex 一轮')
    await host.update(record.id, { engine: 'claude' })
    const beforeSeen = snap().record.engineSessions?.claude?.seen ?? null
    expect(beforeSeen).toBeTruthy()

    const launch = await host.prepareTui(record.id)
    expect(launch.engineSessionId).toBeTruthy()
    expect(claude.sessions.some(s => s.warmed > 0)).toBe(true)
    expect(claude.sessions.some(s => s.flushed.length > 0)).toBe(true)
    const last = snap().items.at(-1)?.id ?? null
    expect(snap().record.engineSessions?.claude?.seen).toBe(last)
    expect(snap().record.tui).toMatchObject({ terminalId: '' })
  })

  it('prepareTui：无待办时不 warm', async () => {
    const { host, claude, record, say } = setup()
    await say('只有 claude')
    const warmedBefore = claude.sessions.reduce((n, s) => n + s.warmed, 0)
    await host.prepareTui(record.id)
    const warmedAfter = claude.sessions.reduce((n, s) => n + s.warmed, 0)
    expect(warmedAfter).toBe(warmedBefore)
  })

  it('切到终端后再打开会话（切标签、重连）不清标记；重启后打开才当作已切回（§3.4）', async () => {
    const { host, record, say } = setup()
    await say('先聊一轮')
    await host.prepareTui(record.id)
    host.setTuiTerminal(record.id, 'term-1')
    expect(host.openSession(record.id).snapshot.record.tui?.terminalId).toBe('term-1')
    await host.shutdown()
    // 重启：同一个数据目录起一个新宿主，终端早没了
    const restarted = new EngineHost({
      dataDir: join(root, 'data'),
      adapters: { claude: new FakeAdapter('claude', true), codex: new FakeAdapter('codex', true) },
      emit: () => {},
    })
    hosts.push(restarted)
    expect(restarted.openSession(record.id).snapshot.record.tui ?? null).toBeNull()
  })

  it('切回补轮次：锚在最近一条 uuid 用户条目后面接上，标上来自终端', async () => {
    const { host, claude, record, say, snap } = setup()
    await say('界面里一轮', '11111111-1111-4111-8111-111111111111')
    claude.native = [{ kind: 'user', id: 'tui-u', text: '终端里一轮', attachments: [], createdAt: 0, mode: 'normal' }]
    expect(await host.syncFromTui(record.id)).toEqual({ added: 1, mismatched: false })
    expect(snap().items.at(-1)).toMatchObject({ id: 'tui-u', source: 'tui' })
    expect(snap().record.engineSessions?.claude?.seen).toBe('tui-u')
  })

  it('回归：用户条目只有重试这类非 uuid id 时按对不上处理，不把整段记录再读一遍（会重复）', async () => {
    const { host, claude, record, say, snap } = setup()
    await say('只有一轮，id 不是 uuid')
    claude.native = [
      { kind: 'user', id: 'dup', text: '只有一轮，id 不是 uuid', attachments: [], createdAt: 0, mode: 'normal' },
    ]
    const before = snap().items.length
    expect(await host.syncFromTui(record.id)).toEqual({ added: 0, mismatched: true })
    expect(snap().items.length).toBe(before)
  })

  it('自动同步（native-sync.md §3）：自己开的会话 sync 补上终端里聊的；在终端模式里不补；一句没说的新对话不读', async () => {
    const { host, claude, record, say, snap } = setup()
    expect(await host.nativeSessionAction(record.id, 'sync')).toEqual({ added: 0 })
    await say('界面里一轮', '22222222-2222-4222-8222-222222222222')
    if (!snap().record.engineSessionId) return expect.fail('假引擎应当记下 engineSessionId')
    claude.native = [{ kind: 'user', id: 'tui-a', text: '终端里一轮', attachments: [], createdAt: 0, mode: 'normal' }]
    await host.prepareTui(record.id)
    expect(await host.nativeSessionAction(record.id, 'sync')).toEqual({ added: 0 })
    host.clearTui(record.id)
    expect(await host.nativeSessionAction(record.id, 'sync')).toEqual({ added: 1 })
    expect(snap().items.at(-1)).toMatchObject({ id: 'tui-a', source: 'tui' })
  })

  it('回归（审查 1）：补上之后关掉空闲开着的引擎进程，下一条消息重新启动、从记录接着', async () => {
    const { host, claude, record, say } = setup()
    await say('界面里一轮', '44444444-4444-4444-8444-444444444444')
    const first = claude.sessions.at(-1)!
    expect(first.closed).toBe(false)
    claude.native = [{ kind: 'user', id: 'tui-b', text: '终端里一轮', attachments: [], createdAt: 0, mode: 'normal' }]
    expect(await host.nativeSessionAction(record.id, 'sync')).toEqual({ added: 1 })
    expect(first.closed).toBe(true)
    await say('接着聊')
    expect(claude.sessions.at(-1)).not.toBe(first)
  })

  it('回归（审查 3）：换过引擎、它还没看完的对话，补上时不把它读到的位置挪到最后（中间的轮次还要交接）', async () => {
    const { host, claude, record, say, snap } = setup()
    await say('claude 一轮', '55555555-5555-4555-8555-555555555555')
    await host.update(record.id, { engine: 'codex' })
    await say('codex 一轮', '66666666-6666-4666-8666-666666666666')
    await host.update(record.id, { engine: 'claude' })
    const seenBefore = snap().record.engineSessions?.claude?.seen ?? null
    expect(seenBefore).toBeTruthy()
    claude.native = [{ kind: 'user', id: 'tui-c', text: '终端里一轮', attachments: [], createdAt: 0, mode: 'normal' }]
    expect((await host.nativeSessionAction(record.id, 'sync')).added).toBe(1)
    expect(snap().items.at(-1)).toMatchObject({ id: 'tui-c' })
    expect(snap().record.engineSessions?.claude?.seen).toBe(seenBefore)
  })

  it('重试的消息（id 是 x-retry-y，原生记录里原样有）也当锚点：不会从更早的一条算起', async () => {
    const { host, claude, record, say, snap } = setup()
    await say('第一轮', '33333333-3333-4333-8333-333333333333')
    await say('重试的那一轮', '33333333-3333-4333-8333-333333333333-retry-1')
    const seen: string[] = []
    claude.newerNativeTurns = async (_cwd: string, _id: string, after: string) => {
      seen.push(after)
      return { items: [], turns: 0, shown: 0, gap: 0 } as unknown as NewerTurns
    }
    expect(await host.syncFromTui(record.id)).toEqual({ added: 0, mismatched: false })
    expect(seen[0]).toBe('33333333-3333-4333-8333-333333333333-retry-1')
    expect(snap().items.filter(i => i.kind === 'user')).toHaveLength(2)
  })

  it('回归：新对话切到终端一句没说就切回（没有记录文件）：没有可补的，不提示对不上', async () => {
    const { host, claude, record, snap } = setup()
    await host.prepareTui(record.id)
    claude.noTranscript = true
    const before = snap().items.length
    expect(await host.syncFromTui(record.id)).toEqual({ added: 0, mismatched: false })
    expect(snap().items.length).toBe(before)
  })
})
