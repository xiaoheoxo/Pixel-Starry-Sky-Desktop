// 跨引擎接力：换引擎、交接、游标、回退 / 分叉（两个假引擎：claude 和 codex）
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  EngineId,
  EngineInfo,
  EngineModel,
  ImageAttachment,
  Item,
  SessionRecord,
  SessionSettings,
} from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, SessionContext } from '../src/adapter'
import type { ChatSeed } from '../src/chat-log'
import type { EngineHostOptions } from '../src/host/context'
import { ClaudeAdapter } from '../src'
import { EngineHost } from '../src/host'
import { derivedSeen } from '../src/host/handoff'
import { NATIVE_TEXT } from '../src/claude/native'
import { ENGINES } from '../src/registry'

const NATIVE = '11111111-1111-4111-8111-111111111111'
const NATIVE_USER = '33333333-3333-4333-8333-333333333333'
const FAKE_CLAUDE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))

let root: string
let hosts: EngineHost[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-handoff-'))
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
  throw new Error('handoff timeout')
}

class FakeSession implements EngineSession {
  active: string | null = null
  inputs: string[] = []
  /** 每次 send 收到的聊天回放（没有为 undefined） */
  seeds: (ChatSeed | undefined)[] = []
  /** 每次 send 收到的当前消息自己的图片和文字交接带的更早消息的图片 */
  attachments: (ImageAttachment[] | undefined)[] = []
  handoffImages: (ImageAttachment[] | undefined)[] = []
  closed = false
  /** 创建时记录里的引擎会话 id（验证换回来时用的是原来的） */
  readonly startId: string | null
  constructor(
    readonly engine: EngineId,
    readonly ctx: SessionContext,
    public auto: boolean,
  ) {
    this.startId = ctx.record().engineSessionId
  }
  send(
    text: string,
    turnId: string,
    _userItemId: string,
    attachments?: ImageAttachment[],
    seed?: ChatSeed,
    handoffImages?: ImageAttachment[],
  ): void {
    this.active = turnId
    this.inputs.push(text)
    this.seeds.push(seed)
    this.attachments.push(attachments)
    this.handoffImages.push(handoffImages)
    if (!this.ctx.record().engineSessionId) this.ctx.setEngineSessionId(`${this.engine}-sid-${this.inputs.length}`)
    if (this.auto) setTimeout(() => this.finish(), 0)
  }
  finish(outcome: 'completed' | 'failed' = 'completed'): void {
    const turnId = this.active
    this.active = null
    if (!turnId) return
    this.ctx.emit({
      type: 'item_completed',
      item: {
        kind: 'assistant',
        id: `reply-${turnId}`,
        text: `${this.engine} 的回复：${this.inputs.at(-1)!.slice(-12)}`,
        status: 'completed',
      },
    })
    this.ctx.emit({
      type: 'turn_completed',
      turnId,
      outcome,
      // 不是连接类的错误：这里测手动重试，不让宿主自动重连
      error: outcome === 'failed' ? 'invalid request' : null,
    })
  }
  /** 这一轮只报错、没有任何输出（消息还没送到引擎就断了） */
  drop(error: string): void {
    const turnId = this.active
    this.active = null
    if (turnId) this.ctx.emit({ type: 'turn_completed', turnId, outcome: 'failed', error })
  }
  async interrupt(): Promise<void> {
    const turnId = this.active
    this.active = null
    if (turnId) this.ctx.emit({ type: 'turn_completed', turnId, outcome: 'interrupted', error: null })
  }
  async close(): Promise<void> {
    this.closed = true
    await this.interrupt()
  }
  answer(): void {}
  async update(_patch: Partial<SessionSettings>): Promise<void> {}
  async stopTask(): Promise<void> {}
  async taskOutput() {
    return { output: '', truncated: false }
  }
}

class FakeAdapter implements EngineAdapter {
  sessions: FakeSession[] = []
  auto = true
  /** 引擎那边的原生会话记录还在不在（hasNativeSession） */
  exists = true
  /** 目录里的模型（catalog）；没给就是空目录，当前模型能不能看图按引擎能力 */
  models: EngineModel[] | undefined
  catalog = async () => ({ models: this.models, currentModel: null, outputStyles: [], currentOutputStyle: null })
  hasNativeSession(): boolean {
    return this.exists
  }
  /** 接着引擎自己的会话：固定有一个会话、一轮对话 */
  nativeSessions = async () =>
    ({
      sessions: [
        {
          id: NATIVE,
          file: '',
          size: 1,
          mtimeMs: 1,
          updatedAt: 1,
          cwd: root,
          subdir: null,
          title: '终端会话',
          firstPrompt: '导入的话',
          lastPrompt: null,
          branch: null,
          source: 'terminal',
          model: null,
        },
      ],
      budget: { left: 0 },
      details: async function* () {},
    }) as unknown as Awaited<ReturnType<NonNullable<EngineAdapter['nativeSessions']>>>
  readNativeSession = async () => ({
    file: '',
    items: [
      { kind: 'user' as const, id: NATIVE_USER, text: '导入的话', createdAt: 1, engine: 'claude' as const },
      { kind: 'assistant' as const, id: 'imp-' + NATIVE_USER + '-0', text: '导入的回复', status: 'completed' as const },
    ],
    title: '终端会话',
    turns: 1,
    shown: 1,
    summary: null,
    source: 'terminal' as const,
    model: 'claude-opus-4-5',
    leafUuid: 'leaf',
    at: 'native-at',
    earliestShownUuid: NATIVE_USER,
    hasEarlier: false,
    compacted: false,
  })
  /** 终端里又聊了几轮（newerNativeTurns 报多少轮新的） */
  newerTurns = 0
  newerNativeTurns = async (_cwd: string, _id: string, after: string) => ({
    items: [],
    turns: this.newerTurns,
    shown: this.newerTurns,
    gap: 0,
    leafUuid: null,
    at: 'newer-at',
    base: after,
  })
  /** 回退时的截断点：返回 null 表示记录里找不到 */
  anchor: ((ids: string[]) => { at: string | null } | null) | null = (ids: string[]) => ({ at: `at-${ids[0]}` })
  constructor(
    readonly engine: EngineId,
    readonly enginePicksSessionId?: boolean,
    readonly seedsHistory?: boolean,
  ) {}
  async info(): Promise<EngineInfo> {
    return { ...ENGINES[this.engine], status: 'ready', version: 'fake', path: 'fake', message: null }
  }
  createSession(ctx: SessionContext): FakeSession {
    const s = new FakeSession(this.engine, ctx, this.auto)
    this.sessions.push(s)
    return s
  }
  rewindAnchor(_record: SessionRecord, ids: string[]) {
    return this.anchor ? this.anchor(ids) : null
  }
}

function setup(options: Partial<EngineHostOptions> = {}, seeds = false) {
  const claude = new FakeAdapter('claude', false, seeds),
    codex = new FakeAdapter('codex', true, seeds)
  const host = new EngineHost({ dataDir: join(root, 'data'), adapters: { claude, codex }, emit: () => {}, ...options })
  hosts.push(host)
  const project = host.addProject(root)
  const record = host.createSession({ projectId: project.id, engine: 'claude', model: 'm', effort: 'low' })
  const idle = () => host.open(record.id).state === 'idle' && host.open(record.id).queue.length === 0
  let n = 0
  const say = async (text: string, clientMessageId = `m${++n}`, attachments?: ImageAttachment[]) => {
    await host.send(record.id, { text, clientMessageId, ...(attachments ? { attachments } : {}) })
    await until(() => host.open(record.id).items.some(i => i.kind === 'user' && i.id === clientMessageId))
    await until(idle)
    return clientMessageId
  }
  const snap = () => host.open(record.id)
  const users = () => snap().items.flatMap(i => (i.kind === 'user' ? [i] : [])) as Extract<Item, { kind: 'user' }>[]
  return { host, claude, codex, record, say, snap, users }
}

describe('跨引擎接力：换引擎', () => {
  it('没开始过的会话换引擎照旧：只改引擎，没有 engineSessions', async () => {
    const { host, record, snap } = setup()
    await host.update(record.id, { engine: 'codex' })
    expect(snap().record.engine).toBe('codex')
    expect(snap().record.engineSessions).toBeUndefined()
  })

  it('开始过的空闲会话可以换引擎：关进程、存旧引擎的会话 id、给新引擎新会话', async () => {
    const { host, claude, record, say, snap, users } = setup()
    await say('第一句')
    const oldId = snap().record.engineSessionId
    expect(oldId).toBeTruthy()
    // 第一轮结束后旧记录也有了 engineSessions
    expect(snap().record.engineSessions?.claude).toMatchObject({ id: oldId })
    await host.update(record.id, { engine: 'codex', model: 'gpt-x' })
    expect(claude.sessions[0].closed).toBe(true)
    expect(snap().record).toMatchObject({ engine: 'codex', nextEngine: null, model: 'gpt-x' })
    expect(snap().record.engineSessions?.claude?.id).toBe(oldId)
    expect(snap().record.engineSessions?.codex).toEqual({ id: null, seen: null })
    expect(snap().record.engineSessionId).toBeNull()
    expect(users()[0].engine).toBe('claude')
  })

  it('同步通知里不知道是哪个引擎处理的那段（游标已在那条用户消息之后）：写「其他引擎」', async () => {
    const { host, record, say, snap } = setup()
    await say('第一句')
    await host.update(record.id, { engine: 'codex' })
    const second = await say('第二句')
    await host.update(record.id, { engine: 'claude' })
    // 模拟 claude 的游标停在 codex 那条用户消息上：交接里只剩 codex 的回复，没有带引擎标记的用户消息
    const rt = (host as unknown as { runtimes: Map<string, { snapshot: { record: SessionRecord } }> }).runtimes.get(
      record.id,
    )!
    const sessions = rt.snapshot.record.engineSessions!
    rt.snapshot.record = {
      ...rt.snapshot.record,
      engineSessions: { ...sessions, claude: { ...sessions.claude!, seen: second } },
    }
    await say('第三句')
    const notice = snap().items.findLast(i => i.kind === 'notice')
    expect(notice?.kind === 'notice' && notice.text).toBe('已把其他引擎期间的进展同步给 Claude Code')
  })

  it('旧记录（没有 engineSessions、用户消息没标引擎）换引擎：补标记，旧引擎读到全部对话', async () => {
    const { host, record, say, snap, users } = setup()
    await say('第一句')
    // 模拟升级前的记录
    const rt = (
      host as unknown as { runtimes: Map<string, { snapshot: { record: SessionRecord; items: Item[] } }> }
    ).runtimes.get(record.id)!
    delete rt.snapshot.record.engineSessions
    rt.snapshot.items = rt.snapshot.items.map(i => (i.kind === 'user' ? { ...i, engine: undefined } : i))
    await host.update(record.id, { engine: 'codex' })
    expect(users()[0].engine).toBe('claude')
    const lastId = snap().items.at(-1)!.id
    expect(snap().record.engineSessions?.claude?.seen).toBe(lastId)
  })

  it('换引擎后下一条消息带交接：引擎收到的文字以交接开头，用户消息条目不变，前面有带详情的提示', async () => {
    const { host, codex, record, say, snap, users } = setup()
    await say('第一句')
    await host.update(record.id, { engine: 'codex' })
    const second = await say('第二句')
    const sent = codex.sessions[0].inputs[0]
    expect(sent.startsWith('<pixelsky-handoff')).toBe(true)
    expect(sent).toContain('用户：第一句')
    expect(sent.endsWith('\n\n第二句')).toBe(true)
    expect(users()[1]).toMatchObject({ text: '第二句', engine: 'codex' })
    const items = snap().items
    const at = items.findIndex(i => i.id === second)
    const notice = items[at - 1]
    expect(notice).toMatchObject({ kind: 'notice', level: 'info' })
    expect(notice.kind === 'notice' && notice.text).toContain('已把之前的对话交接给 Codex')
    expect(notice.kind === 'notice' && notice.detail).toContain('<pixelsky-handoff')
    // 游标推进：再发一条不带交接
    await say('第三句')
    expect(codex.sessions[0].inputs[1]).toBe('第三句')
    expect(snap().items.filter(i => i.kind === 'notice')).toHaveLength(1)
  })

  it('能注入聊天的引擎：消息原样发，之前的聊天作为回放交给适配器，文字交接只当兜底', async () => {
    const { host, codex, record, say, snap } = setup({}, true)
    await say('第一句')
    await host.update(record.id, { engine: 'codex' })
    await say('第二句')
    const session = codex.sessions[0]
    expect(session.inputs[0]).toBe('第二句')
    const seed = session.seeds[0]!
    expect(seed.turns).toEqual([{ id: 'm1', user: '第一句', assistant: 'claude 的回复：第一句' }])
    expect(seed.overview).toBeNull()
    expect(seed.fallback.startsWith('<pixelsky-handoff')).toBe(true)
    const notice = snap().items.findLast(i => i.kind === 'notice')
    expect(notice).toMatchObject({ kind: 'notice', level: 'info', text: '已把之前的聊天带给 Codex（1 轮）' })
    expect(notice?.kind === 'notice' && notice.detail).toBe('用户：第一句\n助手：claude 的回复：第一句')
    // 游标推进：再发一条不带回放
    await say('第三句')
    expect(session.inputs[1]).toBe('第三句')
    expect(session.seeds[1]).toBeUndefined()
  })

  it('能注入聊天的引擎换回来：回放只含另一个引擎期间的轮次', async () => {
    const { host, claude, record, say, snap } = setup({}, true)
    await say('第一句')
    await host.update(record.id, { engine: 'codex' })
    await say('第二句')
    await host.update(record.id, { engine: 'claude' })
    await say('第三句')
    const session = claude.sessions[1]
    expect(session.inputs[0]).toBe('第三句')
    expect(session.seeds[0]!.turns.map(t => t.user)).toEqual(['第二句'])
    const notice = snap().items.findLast(i => i.kind === 'notice')
    expect(notice?.kind === 'notice' && notice.text).toBe('已把 Codex 期间的聊天同步给 Claude Code（1 轮）')
  })

  it.each([false, true])('同一引擎报错后重试：保留上下文恢复，不显示换引擎提示（聊天回放：%s）', async seeds => {
    const { host, claude, record, say, snap } = setup({}, seeds)
    await say('第一句')
    const session = claude.sessions[0]
    const seen = snap().record.engineSessions?.claude?.seen
    session.auto = false
    await host.send(record.id, { text: '失败的一轮', clientMessageId: 'failed' })
    await until(() => session.inputs.length === 2)
    session.finish('failed')
    expect(snap().record.engineSessions?.claude?.seen).toBe(seen)
    await host.runQueuedNow(record.id, 'failed')
    await until(() => session.inputs.length === 3)
    expect(snap().record.engine).toBe('claude')
    expect(snap().items.filter(i => i.kind === 'notice')).toHaveLength(0)
    if (seeds) expect(session.seeds[2]?.turns.map(t => t.user)).toContain('失败的一轮')
    else expect(session.inputs[2]).toContain('用户：失败的一轮')
    session.finish()
    await until(() => snap().state === 'idle' && snap().queue.length === 0)
    expect(snap().record.engineSessions?.claude?.seen).toBe(snap().items.at(-1)!.id)
  })

  it.each([false, true])(
    '换引擎后的首轮报错：重试继续补发交接，但不重复显示换引擎提示（聊天回放：%s）',
    async seeds => {
      const { host, codex, record, say, snap } = setup({}, seeds)
      await say('第一句')
      await host.update(record.id, { engine: 'codex' })
      codex.auto = false
      await host.send(record.id, { text: '第二句', clientMessageId: 'failed' })
      await until(() => codex.sessions[0]?.inputs.length === 1)
      const session = codex.sessions[0]
      expect(snap().items.filter(i => i.kind === 'notice')).toHaveLength(1)
      session.finish('failed')
      await host.runQueuedNow(record.id, 'failed')
      await until(() => session.inputs.length === 2)
      expect(snap().record.engine).toBe('codex')
      expect(snap().items.filter(i => i.kind === 'notice')).toHaveLength(1)
      if (seeds) expect(session.seeds[1]?.turns.map(t => t.user)).toContain('第一句')
      else expect(session.inputs[1]).toContain('用户：第一句')
      session.finish()
      await until(() => snap().state === 'idle' && snap().queue.length === 0)
    },
  )

  it.each([false, true])(
    '换引擎后的首轮没送达就断线：自动原样重发，交接材料不含这条消息自己，对话里也只有一条（聊天回放：%s）',
    async seeds => {
      const { host, codex, record, say, snap, users } = setup({ reconnectDelays: [0] }, seeds)
      await say('第一句')
      await host.update(record.id, { engine: 'codex' })
      codex.auto = false
      await host.send(record.id, { text: '第二句', clientMessageId: 'second' })
      await until(() => codex.sessions[0]?.inputs.length === 1)
      const session = codex.sessions[0]
      session.drop('stream disconnected before completion')
      await until(() => session.inputs.length === 2)
      expect(snap().queue[0]).toMatchObject({ id: 'second', messageUuid: 'second', delivered: false })
      expect(users().filter(u => u.text === '第二句')).toHaveLength(1)
      // 游标没动（失败的一轮），重发时带的交接是第一句，不含刚写进对话的这一条
      if (seeds) expect(session.seeds[1]?.turns.map(t => t.user)).toEqual(['第一句'])
      else {
        expect(session.inputs[1]).toContain('用户：第一句')
        expect(session.inputs[1]).not.toContain('用户：第二句')
        expect(session.inputs[1].endsWith('第二句')).toBe(true)
      }
      session.finish()
      await until(() => snap().state === 'idle' && snap().queue.length === 0)
    },
  )

  it('historyTool 为真时交接里点名历史工具，并按记录判断；为假或没给时不提', async () => {
    const seen: SessionRecord[] = []
    const { host, codex, record, say } = setup({
      historyTool: r => {
        seen.push(r)
        return true
      },
    })
    await say('第一句')
    await host.update(record.id, { engine: 'codex' })
    await say('第二句')
    expect(codex.sessions[0].inputs[0]).toContain('mcp__pixelsky_history__outline')
    expect(seen.at(-1)).toMatchObject({ id: record.id, engine: 'codex' })
    expect(Object.keys(seen.at(-1)!.engineSessions ?? {})).toHaveLength(2)
    const plain = setup()
    await plain.say('第一句')
    await plain.host.update(plain.record.id, { engine: 'codex' })
    await plain.say('第二句')
    expect(plain.codex.sessions[0].inputs[0]).not.toContain('pixelsky_history')
  })

  it('historyItems 返回会话的全部条目（已有运行时直接用内存里的），会话不存在时报错', async () => {
    const { host, record, say, snap } = setup()
    await say('第一句')
    const items = await host.historyItems(record.id)
    expect(items.map(i => i.id)).toEqual(snap().items.map(i => i.id))
    await expect(host.historyItems('nope')).rejects.toThrow()
  })

  it('换回来：恢复原来的会话 id，交接只含另一个引擎期间的内容', async () => {
    const { host, claude, record, say, snap } = setup()
    await say('第一句')
    const claudeId = snap().record.engineSessionId
    await host.update(record.id, { engine: 'codex' })
    await say('第二句')
    await host.update(record.id, { engine: 'claude' })
    expect(snap().record.engineSessionId).toBe(claudeId)
    await say('第三句')
    expect(claude.sessions[1].startId).toBe(claudeId)
    const sent = claude.sessions[1].inputs[0]
    expect(sent.startsWith('<pixelsky-handoff')).toBe(true)
    expect(sent).toContain('用户：第二句')
    expect(sent).toContain('Codex')
    expect(sent).not.toContain('用户：第一句')
    expect(sent.endsWith('\n\n第三句')).toBe(true)
    const notice = snap().items.findLast(i => i.kind === 'notice')
    expect(notice?.kind === 'notice' && notice.text).toContain('期间的进展同步给 Claude Code')
  })

  it('旧记录没有 engineSessions 时不带交接，第一轮结束后才建立游标', async () => {
    const { host, claude, record, say, snap } = setup()
    await say('第一句')
    const rt = (host as unknown as { runtimes: Map<string, { snapshot: { record: SessionRecord } }> }).runtimes.get(
      record.id,
    )!
    delete rt.snapshot.record.engineSessions
    await say('第二句')
    expect(claude.sessions[0].inputs).toEqual(['第一句', '第二句'])
    expect(snap().record.engineSessions?.claude?.seen).toBe(snap().items.at(-1)!.id)
  })

  it('运行中选别的引擎：只记 nextEngine，正在执行的不动，下一条派发的消息才真正切换', async () => {
    const { host, claude, codex, record, snap } = setup()
    claude.auto = false
    await host.send(record.id, { text: '先做', clientMessageId: 'a' })
    await until(() => !!claude.sessions[0]?.active)
    await host.update(record.id, { engine: 'codex', model: 'gpt-x' })
    expect(snap().record).toMatchObject({ engine: 'claude', nextEngine: 'codex', model: 'gpt-x' })
    expect(claude.sessions[0].closed).toBe(false)
    expect(host.record(record.id)).toMatchObject({ engine: 'claude', nextEngine: null })
    expect(snap().execution?.engine).toBe('claude')
    // 之前排的消息仍用 claude，选了之后发的用 codex
    await host.send(record.id, {
      text: '还是 claude',
      clientMessageId: 'b',
      settings: { model: 'm', effort: 'low', platform: null, engine: 'claude' },
    })
    await host.send(record.id, { text: '换 codex', clientMessageId: 'c' })
    expect(snap().queue.map(q => q.settings.engine)).toEqual(['claude', 'claude', 'codex'])
    claude.sessions[0].finish()
    await until(() => claude.sessions[0].inputs.length === 2)
    expect(snap().record.engine).toBe('claude')
    claude.sessions[0].finish()
    await until(() => codex.sessions[0]?.inputs.length === 1)
    expect(snap().record).toMatchObject({ engine: 'codex', nextEngine: null })
    expect(claude.sessions[0].closed).toBe(true)
    expect(codex.sessions[0].inputs[0].startsWith('<pixelsky-handoff')).toBe(true)
    expect(codex.sessions[0].inputs[0].endsWith('\n\n换 codex')).toBe(true)
  })

  it('运行中改回当前引擎会清掉 nextEngine', async () => {
    const { host, claude, record, snap } = setup()
    claude.auto = false
    await host.send(record.id, { text: '先做', clientMessageId: 'a' })
    await until(() => !!claude.sessions[0]?.active)
    await host.update(record.id, { engine: 'codex' })
    await host.update(record.id, { engine: 'claude' })
    expect(snap().record.nextEngine).toBeNull()
  })

  it('斜杠命令不带交接，也不推进游标；下一条普通消息再带', async () => {
    const { host, codex, record, say, snap } = setup()
    await say('第一句')
    await host.update(record.id, { engine: 'codex' })
    await say('/compact')
    expect(codex.sessions[0].inputs[0]).toBe('/compact')
    expect(snap().items.filter(i => i.kind === 'notice')).toHaveLength(0)
    expect(snap().record.engineSessions?.codex?.seen).toBeNull()
    await say('正式的问题')
    expect(codex.sessions[0].inputs[1].startsWith('<pixelsky-handoff')).toBe(true)
    expect(codex.sessions[0].inputs[1]).toContain('用户：第一句')
  })

  it('目标引擎没有的开关会被清掉', async () => {
    const { host, record, say, snap } = setup()
    await host.update(record.id, { ultracode: true })
    await say('第一句')
    expect(snap().record.ultracode).toBe(true)
    await host.update(record.id, { engine: 'codex' })
    expect(snap().record.ultracode).toBe(false)
  })
})

/** 合法的 PNG 图片附件（只有文件头，其余补零） */
const png = (name: string, bytes = 64): ImageAttachment => ({
  id: name.replace(/\W/g, '-'),
  name,
  mediaType: 'image/png',
  bytes,
  width: 1,
  height: 1,
  dataBase64: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(bytes - 8)]).toString(
    'base64',
  ),
})
const ASKED = '这个地方显示的内容不对'

describe('跨引擎接力：图片', () => {
  /** claude 先收到一条带图的消息，被打断没有回复，再换成 codex */
  async function interruptedWithImages(seeds: boolean, images = [png('a.png')]) {
    const t = setup({}, seeds)
    t.claude.auto = false
    await t.host.send(t.record.id, { text: ASKED, clientMessageId: 'first', attachments: images })
    await until(() => !!t.claude.sessions[0]?.active)
    await t.claude.sessions[0].interrupt()
    await until(() => t.snap().state === 'idle' && t.snap().queue.length === 0)
    await t.host.update(t.record.id, { engine: 'codex' })
    return t
  }
  const notice = (items: readonly Item[]) => items.findLast(i => i.kind === 'notice')

  it('能注入聊天的引擎：回放里带上图片，用户话写明附了什么，提示里写张数', async () => {
    const a = png('a.png')
    const { codex, say, snap } = await interruptedWithImages(true, [a])
    await say('怎么样')
    const session = codex.sessions[0]
    expect(session.inputs[0]).toBe('怎么样')
    const seed = session.seeds[0]!
    expect(seed.turns).toEqual([{ id: 'first', user: `${ASKED}（附：a.png）`, assistant: null, images: [a] }])
    expect(seed.omittedImages).toBeUndefined()
    // 注入失败退回文字交接：图片随当前消息发，材料里说明是哪条消息的
    expect(seed.fallbackImages).toEqual([a])
    expect(seed.fallback).toContain(`下面第 1 张图是之前「${ASKED}」那条消息附的 a.png`)
    expect(session.attachments[0]).toBeUndefined()
    expect(session.handoffImages[0]).toBeUndefined()
    const n = notice(snap().items)
    expect(n).toMatchObject({ level: 'info', text: '已把之前的聊天带给 Codex（1 轮，含 1 张图片）' })
    expect(n?.kind === 'notice' && n.detail).toBe(`用户：${ASKED}（附：a.png）\n助手：（这一轮没有回复，可能被中断了）`)
  })

  it('换回来同步另一个引擎期间的聊天时也带图', async () => {
    const images = Array.from({ length: 5 }, (_, i) => png(`${i}.png`))
    const { host, claude, codex, record, say, snap } = await interruptedWithImages(true, images)
    await say('第二轮', 'm2', [png('x.png'), png('y.png')])
    // 当前消息自己带 2 张，回放只剩 3 张的额度
    expect(codex.sessions[0].seeds[0]!.turns[0].images).toHaveLength(3)
    claude.auto = true
    await host.update(record.id, { engine: 'claude' })
    await say('第三轮', 'm3', [png('z.png')])
    // 换回 claude：codex 期间的一轮带 2 张图
    expect(snap().items.findLast(i => i.kind === 'notice')).toMatchObject({
      text: '已把 Codex 期间的聊天同步给 Claude Code（1 轮，含 2 张图片）',
    })
  })

  it('回放里图片超过 5 张：最早的未带上，提示里说没带上几张', async () => {
    const t = setup({}, true)
    for (const [i, name] of ['1.png', '2.png', '3.png'].entries())
      await t.say(`问${i}`, `q${i}`, [png(name), png(`${name}-b`)])
    await t.host.update(t.record.id, { engine: 'codex' })
    await t.say('接着')
    const seed = t.codex.sessions[0].seeds[0]!
    expect(seed.omittedImages).toBe(1)
    expect(seed.turns[0].user).toBe('问0（附：1.png-b）（附图 1.png，未带上）')
    expect(notice(t.snap().items)).toMatchObject({
      text: '已把之前的聊天带给 Codex（3 轮，含 5 张图片，1 张图片未带上）',
    })
  })

  it('不能注入聊天的引擎：更早消息的图片随这条消息发，排在消息自己的图片前面，文字里说明各是哪条消息的', async () => {
    const a = png('a.png'),
      b = png('b.png')
    const { codex, say, snap } = await interruptedWithImages(false, [a])
    await say('怎么样', 'm2', [b])
    const session = codex.sessions[0]
    expect(session.handoffImages[0]).toEqual([a])
    expect(session.attachments[0]).toEqual([b])
    expect(session.seeds[0]).toBeUndefined()
    expect(session.inputs[0]).toContain('这条消息附带的图片里，前 1 张是之前消息里的图')
    expect(session.inputs[0]).toContain(`下面第 1 张图是之前「${ASKED}」那条消息附的 a.png`)
    expect(session.inputs[0].endsWith('\n\n怎么样')).toBe(true)
    // 用户消息条目里只有用户自己发的图
    expect(snap().items.findLast(i => i.kind === 'user')).toMatchObject({ attachments: [b] })
    expect(notice(snap().items)).toMatchObject({ text: '已把之前的对话交接给 Codex（1 条，含 1 张图片）' })
  })

  it('当前消息自己的图片先占额度：只带得下的最近几张，没带上的说明', async () => {
    const earlier = [1, 2, 3, 4].map(i => png(`e${i}.png`))
    const own = [1, 2, 3].map(i => png(`c${i}.png`))
    const { codex, say, snap } = await interruptedWithImages(false, earlier)
    await say('怎么样', 'm2', own)
    const session = codex.sessions[0]
    expect(session.handoffImages[0]).toEqual(earlier.slice(2))
    expect(session.attachments[0]).toEqual(own)
    const text = session.inputs[0]
    expect(text.indexOf('下面第 1 张图是之前「')).toBeLessThan(text.indexOf('下面第 2 张图是之前「'))
    expect(text).toMatch(/下面第 1 张图是之前「.*」那条消息附的 e3\.png/)
    expect(text).toMatch(/下面第 2 张图是之前「.*」那条消息附的 e4\.png/)
    expect(text).toContain('另有 2 张之前消息里的图片没有带过来，只留下了文件名。')
    expect(notice(snap().items)).toMatchObject({
      text: '已把之前的对话交接给 Codex（1 条，含 2 张图片，2 张图片未带上）',
    })
  })

  it('当前消息自己的图片也占回放的额度：回放少带，没带上的记进张数和提示', async () => {
    const earlier = [1, 2, 3].map(i => png(`e${i}.png`))
    const own = [1, 2, 3, 4].map(i => png(`c${i}.png`))
    const { codex, say, snap } = await interruptedWithImages(true, earlier)
    await say('怎么样', 'm2', own)
    const seed = codex.sessions[0].seeds[0]!
    expect(seed.turns[0].images).toEqual([earlier[2]])
    expect(seed.omittedImages).toBe(2)
    expect(seed.fallbackImages).toEqual([earlier[2]])
    expect(notice(snap().items)).toMatchObject({
      text: '已把之前的聊天带给 Codex（1 轮，含 1 张图片，2 张图片未带上）',
    })
  })

  it.each([false, true])('当前消息已经有 5 张图：更早的一张都不带，并说明（聊天回放：%s）', async seeds => {
    const own = [1, 2, 3, 4, 5].map(i => png(`c${i}.png`))
    const { codex, say } = await interruptedWithImages(seeds)
    await say('怎么样', 'm2', own)
    const session = codex.sessions[0]
    expect(session.handoffImages[0]).toBeUndefined()
    expect(session.attachments[0]).toEqual(own)
    const seed = session.seeds[0]
    expect(seed?.fallbackImages).toBeUndefined()
    const text = seed ? seed.fallback : session.inputs[0]
    expect(text).not.toContain('下面第')
    expect(text).toContain('另有 1 张之前消息里的图片没有带过来，只留下了文件名。')
  })

  it.each([false, true])(
    '带图的一轮失败后重试：这张图只出现一次，更早的图照旧带上，失败那轮的文字照旧重发（聊天回放：%s）',
    async seeds => {
      const old = png('old.png'),
        cur = png('cur.png')
      const { host, claude, codex, record, say, snap } = setup({}, seeds)
      claude.auto = true
      await say('更早的话', 'q0', [old])
      await host.update(record.id, { engine: 'codex' })
      codex.auto = false
      await host.send(record.id, { text: '失败的一轮', clientMessageId: 'failed', attachments: [cur] })
      await until(() => codex.sessions[0]?.inputs.length === 1)
      const session = codex.sessions[0]
      // 失败两次：每次重试都不能多带一份
      for (const n of [2, 3]) {
        session.finish('failed')
        await host.runQueuedNow(record.id, 'failed')
        await until(() => session.inputs.length === n)
        expect(session.attachments[n - 1]).toEqual([cur])
        const seed = session.seeds[n - 1]
        if (seed) {
          const images = seed.turns.flatMap(t => t.images ?? [])
          expect(images).toEqual([old])
          expect(seed.omittedImages).toBeUndefined()
          // 每次失败的那一轮的文字都留着（游标没动），图片都只写文件名
          expect(seed.turns.map(t => t.user)).toEqual([
            '更早的话（附：old.png）',
            ...Array<string>(n - 1).fill('失败的一轮（附：cur.png）'),
          ])
          expect(seed.fallbackImages).toEqual([old])
          expect(seed.fallback).toContain('前 1 张是之前消息里的图')
          expect(seed.fallback).not.toContain('另有')
        } else {
          expect(session.handoffImages[n - 1]).toEqual([old])
          expect(session.inputs[n - 1]).toContain('用户：失败的一轮（附：cur.png）')
          expect(session.inputs[n - 1]).toContain('前 1 张是之前消息里的图')
          expect(session.inputs[n - 1]).not.toContain('另有')
        }
      }
      session.finish()
      await until(() => snap().state === 'idle' && snap().queue.length === 0)
    },
  )

  it.each([false, true])('同引擎带图的一轮失败后重试：没有更早的图可带（聊天回放：%s）', async seeds => {
    const cur = png('cur.png')
    const { host, claude, record, say, snap } = setup({}, seeds)
    await say('第一句')
    const session = claude.sessions[0]
    session.auto = false
    await host.send(record.id, { text: '失败的一轮', clientMessageId: 'failed', attachments: [cur] })
    await until(() => session.inputs.length === 2)
    session.finish('failed')
    await host.runQueuedNow(record.id, 'failed')
    await until(() => session.inputs.length === 3)
    expect(session.attachments[2]).toEqual([cur])
    expect(session.handoffImages[2]).toBeUndefined()
    const seed = session.seeds[2]
    if (seed) {
      expect(seed.turns.flatMap(t => t.images ?? [])).toEqual([])
      expect(seed.turns.at(-1)?.user).toBe('失败的一轮（附：cur.png）')
      expect(seed.omittedImages).toBeUndefined()
      expect(seed.fallbackImages).toBeUndefined()
    } else {
      expect(session.inputs[2]).toContain('用户：失败的一轮（附：cur.png）')
      expect(session.inputs[2]).not.toContain('前 1 张')
    }
    session.finish()
    await until(() => snap().state === 'idle' && snap().queue.length === 0)
  })

  it.each([false, true])('单张太大或边长超限的图不带，算没带上（聊天回放：%s）', async seeds => {
    // 4 MB 的图：数据本身合法，只是单张超过交接的上限
    const big = png('big.png', 4 * 1024 * 1024)
    const wide = { ...png('wide.png'), width: 8001 }
    const ok = png('ok.png')
    const { codex, say, snap } = await interruptedWithImages(seeds, [big, wide, ok])
    await say('怎么样')
    const session = codex.sessions[0]
    const seed = session.seeds[0]
    if (seed) {
      expect(seed.turns[0].images).toEqual([ok])
      expect(seed.omittedImages).toBe(2)
      expect(seed.turns[0].user).toBe(`${ASKED}（附：ok.png）（附图 big.png、wide.png，未带上）`)
    } else {
      expect(session.handoffImages[0]).toEqual([ok])
      expect(session.inputs[0]).toContain('另有 2 张之前消息里的图片没有带过来')
    }
    expect(notice(snap().items)).toMatchObject({
      text: expect.stringContaining('含 1 张图片，2 张图片未带上'),
    })
  })

  const model = (id: string, inputModalities: string[]): EngineModel => ({
    id,
    label: id,
    efforts: [],
    defaultEffort: null,
    inputModalities,
    isDefault: false,
  })

  it.each([true, false])(
    '引擎能看图但当前模型不能（目录里查得到）：不带图，只写「未带上」，不会又说带了又说没带（聊天回放：%s）',
    async seeds => {
      const t = setup({}, seeds)
      t.codex.models = [model('m', ['text'])]
      t.claude.auto = false
      await t.host.send(t.record.id, { text: ASKED, clientMessageId: 'first', attachments: [png('a.png')] })
      await until(() => !!t.claude.sessions[0]?.active)
      await t.claude.sessions[0].interrupt()
      await until(() => t.snap().state === 'idle' && t.snap().queue.length === 0)
      await t.host.update(t.record.id, { engine: 'codex' })
      await t.say('怎么样')
      const session = t.codex.sessions[0]
      expect(session.attachments[0]).toBeUndefined()
      expect(session.handoffImages[0]).toBeUndefined()
      const seed = session.seeds[0]
      if (seed) {
        expect(seed.turns[0].images).toBeUndefined()
        expect(seed.fallbackImages).toBeUndefined()
        expect(seed.omittedImages).toBe(1)
      }
      const shown = notice(t.snap().items)
      expect(shown).toMatchObject({
        text: seeds
          ? '已把之前的聊天带给 Codex（1 轮，1 张图片未带上）'
          : '已把之前的对话交接给 Codex（1 条，1 张图片未带上）',
      })
      expect(shown?.kind === 'notice' && shown.text).not.toContain('含')
    },
  )

  it('目录里的模型能看图、或查不到当前模型：照常带图', async () => {
    for (const models of [[model('m', ['text', 'image'])], [model('other', ['text'])], undefined]) {
      const t = await interruptedWithImages(true)
      t.codex.models = models
      await t.say('怎么样')
      expect(t.codex.sessions[0].seeds[0]!.turns[0].images).toHaveLength(1)
      expect(notice(t.snap().items)).toMatchObject({ text: '已把之前的聊天带给 Codex（1 轮，含 1 张图片）' })
    }
  })

  it('读目录失败：按引擎能力，照常带图', async () => {
    const t = await interruptedWithImages(true)
    t.codex.catalog = async () => {
      throw new Error('catalog down')
    }
    await t.say('怎么样')
    expect(t.codex.sessions[0].seeds[0]!.turns[0].images).toHaveLength(1)
  })

  it.each([true, false])('目标引擎不能看图：一张都不带，写明未带上（聊天回放：%s）', async seeds => {
    const caps = ENGINES.codex.caps
    const saved = caps.imageInput
    caps.imageInput = false
    try {
      const { codex, say, snap } = await interruptedWithImages(seeds)
      await say('怎么样')
      const session = codex.sessions[0]
      expect(session.handoffImages[0]).toBeUndefined()
      const seed = session.seeds[0]
      if (seed) {
        expect(seed.turns[0]).toMatchObject({ user: `${ASKED}（附图 a.png，未带上）` })
        expect(seed.turns[0].images).toBeUndefined()
        expect(seed.fallbackImages).toBeUndefined()
      }
      expect(notice(snap().items)).toMatchObject({
        text: seeds
          ? '已把之前的聊天带给 Codex（1 轮，1 张图片未带上）'
          : '已把之前的对话交接给 Codex（1 条，1 张图片未带上）',
      })
    } finally {
      caps.imageInput = saved
    }
  })
})

describe('跨引擎接力：回退、撤销、分叉', () => {
  async function threeTurns() {
    const t = setup()
    await t.say('一', 'a')
    await t.host.update(t.record.id, { engine: 'codex' })
    await t.say('二', 'b')
    await t.host.update(t.record.id, { engine: 'claude' })
    await t.say('三', 'c')
    return t
  }

  it('回退：当前引擎的游标退到它最后处理的那一轮末尾，其他引擎的原生会话作废', async () => {
    const { host, record, snap } = await threeTurns()
    // 回退到 b：保留到 b 之前一条（claude 处理的第一轮末尾，后面是交接给 codex 的提示）
    const before = snap().items[snap().items.findIndex(i => i.id === 'b') - 1].id
    expect(snap().record.engineSessions?.codex?.id).toBeTruthy()
    await host.rewind(record.id, 'b')
    expect(snap().items.map(i => i.id)).not.toContain('b')
    expect(snap().items.map(i => i.id)).not.toContain('c')
    expect(snap().record.engineSessions?.claude?.seen).toBe(before)
    expect(snap().record.engineSessions?.codex).toEqual({ id: null, seen: null })
  })

  it('回退只涉及另一个引擎处理的消息：当前引擎的会话不动', async () => {
    const { host, claude, record, say, snap } = setup()
    await say('一', 'a')
    await host.update(record.id, { engine: 'codex' })
    await say('二', 'b')
    const codexId = snap().record.engineSessionId
    await host.rewind(record.id, 'b')
    // 被回退的是 codex 自己的消息：用它的截断点
    expect(snap().record.pendingRewind).toBe('at-b')
    expect(snap().record.engineSessionId).toBe(codexId)
    expect(claude.sessions).toHaveLength(1)
  })

  it('找不到截断点：当前引擎换新会话，提示下一条消息带交接，下一条消息带完整交接', async () => {
    const { host, claude, record, say, snap } = setup()
    await say('一', 'a')
    await say('二', 'b')
    claude.anchor = null
    const oldId = snap().record.engineSessionId
    await host.rewind(record.id, 'b')
    expect(snap().record.engineSessionId).not.toBe(oldId)
    expect(snap().record.engineSessions?.claude).toMatchObject({ id: snap().record.engineSessionId, seen: null })
    const notice = snap().items.findLast(i => i.kind === 'notice')
    expect(notice).toMatchObject({ level: 'info' })
    expect(notice?.kind === 'notice' && notice.text).toContain('交接')
    await say('新的')
    const sent = claude.sessions.at(-1)!.inputs.at(-1)!
    expect(sent.startsWith('<pixelsky-handoff')).toBe(true)
    expect(sent).toContain('用户：一')
    expect(sent).not.toContain('用户：二')
  })

  it('撤销回退：engineSessions 一并恢复', async () => {
    const { host, record, snap } = await threeTurns()
    const before = JSON.stringify(snap().record.engineSessions)
    await host.rewind(record.id, 'b')
    expect(JSON.stringify(snap().record.engineSessions)).not.toBe(before)
    await host.undoRewind(record.id)
    expect(JSON.stringify(snap().record.engineSessions)).toBe(before)
    expect(snap().items.map(i => i.id)).toContain('c')
  })

  it('真实 Claude 记录里有接力写进去的轮次：回退到其他引擎期间的消息，下次启动的截断点把接力轮次一起剪掉', async () => {
    const projectsDir = join(root, 'claude-projects')
    const claude = new ClaudeAdapter({
      launcher: { command: process.execPath, args: [FAKE_CLAUDE] },
      projectsDir,
      env: {
        ...process.env,
        FAKE_CLAUDE_PROJECTS: projectsDir,
        FAKE_CLAUDE_LOG: join(root, 'argv.log'),
        FAKE_CLAUDE_CHAIN: '1',
      },
    })
    const codex = new FakeAdapter('codex', true, true)
    const host = new EngineHost({ dataDir: join(root, 'data'), adapters: { claude, codex }, emit: () => {} })
    hosts.push(host)
    const cwd = mkdtempSync(join(root, 'proj-'))
    const project = host.addProject(cwd)
    const record = host.createSession({ projectId: project.id, engine: 'claude', model: 'm', effort: 'low' })
    const snap = () => host.open(record.id)
    const say = async (text: string, clientMessageId: string) => {
      await host.send(record.id, { text, clientMessageId })
      await until(() => snap().items.some(i => i.kind === 'user' && i.id === clientMessageId))
      await until(() => snap().state === 'idle' && snap().queue.length === 0)
    }
    // 接力写记录时只认 UUID 形式的条目 id
    const [a, b, c] = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]
    await say('一', a)
    await host.update(record.id, { engine: 'codex' })
    await say('二', b)
    await host.update(record.id, { engine: 'claude' })
    await say('三', c)
    const sid = snap().record.engineSessionId!
    const file = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`)
    const rows = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { type?: string; uuid?: string; parentUuid?: string | null })
    // 第二轮是接力写进来的，用户行的 uuid 就是我们的条目 id
    const relayed = rows.find(r => r.uuid === b)
    expect(relayed?.type).toBe('user')
    const before = rows.find(r => r.uuid === relayed!.parentUuid)
    expect(before?.type).toBe('assistant')

    await host.rewind(record.id, b)
    expect(snap().record.pendingRewind).toBe(before!.uuid)
    await say('四', '44444444-4444-4444-8444-444444444444')
    const spawns = readFileSync(join(root, 'argv.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as string[])
    expect(spawns.at(-1)).toContain(`--resume-session-at=${before!.uuid}`)
  })

  it('分叉：新会话只带当前引擎的原生会话；找不到截断点时游标为空，第一条消息带交接', async () => {
    const { host, claude, record, say, snap } = setup()
    await say('一', 'a')
    await host.update(record.id, { engine: 'codex' })
    await say('二', 'b')
    const forked = await host.forkSession(record.id, 'b')
    expect(Object.keys(forked.record.engineSessions ?? {})).toEqual(['codex'])
    expect(forked.record.nextEngine).toBeNull()
    expect(forked.record.engineSessions?.codex?.id).toBe(forked.record.engineSessionId)
    expect(snap().record.engineSessions?.claude).toBeTruthy()
    // 回到 claude 的分叉：截断点找不到
    await host.update(record.id, { engine: 'claude' })
    claude.anchor = null
    await say('三', 'c')
    const f2 = await host.forkSession(record.id, 'c')
    expect(f2.record.engineSessions?.claude?.seen).toBeNull()
    const notice = host.open(f2.record.id).items.findLast(i => i.kind === 'notice')
    expect(notice?.kind === 'notice' && notice.text).toContain('交接')
  })

  /** claude 一，切 codex 二，切回 claude 发 /compact（暂缓交接）再发三 */
  async function heldSlashThenTurn() {
    const t = setup()
    await t.say('一', 'a')
    await t.host.update(t.record.id, { engine: 'codex' })
    await t.say('二', 'b')
    await t.host.update(t.record.id, { engine: 'claude' })
    await t.say('/compact', 's')
    await t.say('三', 'c')
    return t
  }

  it('回退：重建游标时跳过暂缓交接的斜杠命令那一轮，下一条消息仍带交接', async () => {
    const { host, claude, record, say, snap } = await heldSlashThenTurn()
    const before = snap().items[snap().items.findIndex(i => i.id === 'b') - 1].id
    await host.rewind(record.id, 'c')
    expect(snap().items.map(i => i.id)).toContain('s')
    expect(snap().items.map(i => i.id)).not.toContain('c')
    expect(snap().record.engineSessions?.claude?.seen).toBe(before)
    await say('四')
    const sent = claude.sessions.at(-1)!.inputs.at(-1)!
    expect(sent.startsWith('<pixelsky-handoff')).toBe(true)
    expect(sent).toContain('用户：二')
  })

  it('分叉：重建游标时跳过暂缓交接的斜杠命令那一轮，分叉里第一条消息仍带交接', async () => {
    const { host, claude, snap } = await heldSlashThenTurn()
    const before = snap().items[snap().items.findIndex(i => i.id === 'b') - 1].id
    const forked = await host.forkSession(snap().record.id, 'c')
    expect(forked.record.engineSessions?.claude?.seen).toBe(before)
    const forkId = forked.record.id
    await host.send(forkId, { text: '四', clientMessageId: 'd' })
    await until(() => host.open(forkId).items.some(i => i.kind === 'user' && i.id === 'd'))
    await until(() => host.open(forkId).state === 'idle' && host.open(forkId).queue.length === 0)
    const sent = claude.sessions.at(-1)!.inputs.at(-1)!
    expect(sent.startsWith('<pixelsky-handoff')).toBe(true)
    expect(sent).toContain('用户：二')
  })

  it('回退：没有可交接的内容时斜杠命令那一轮正常推进游标，下一条消息不带交接', async () => {
    const { host, claude, record, say, snap } = setup()
    await say('a1', 'a')
    await say('/compact', 's')
    await say('b1', 'b')
    const before = snap().items[snap().items.findIndex(i => i.id === 'b') - 1].id
    await host.rewind(record.id, 'b')
    expect(snap().record.engineSessions?.claude?.seen).toBe(before)
    await say('四')
    expect(claude.sessions.at(-1)!.inputs.at(-1)).toBe('四')
  })
})

describe('derivedSeen', () => {
  const user = (id: string, engine?: EngineId, text = id, mode?: 'guidance'): Item => ({
    kind: 'user',
    id,
    text,
    createdAt: 0,
    ...(engine ? { engine } : {}),
    ...(mode ? { mode } : {}),
  })
  const reply = (id: string): Item => ({ kind: 'assistant', id, text: id, status: 'completed' })

  it('没有该引擎的用户消息为 null', () => {
    expect(derivedSeen([user('u1', 'codex'), reply('r1')], 'claude', 'claude')).toBeNull()
  })

  it('普通消息：游标是它所在一轮的末尾', () => {
    const items = [user('u1', 'claude'), reply('r1'), user('u2', 'codex'), reply('r2')]
    expect(derivedSeen(items, 'claude', 'claude')).toBe('r1')
  })

  it('斜杠命令前面有没交接的内容：不推进游标', () => {
    const items = [
      user('u1', 'claude'),
      reply('r1'),
      user('u2', 'codex'),
      reply('r2'),
      user('u3', 'claude', '/compact'),
    ]
    expect(derivedSeen(items, 'claude', 'claude')).toBe('r1')
  })

  it('斜杠命令前面没有可交接的内容：照常推进', () => {
    const items = [user('u1', 'claude'), reply('r1'), user('u2', 'claude', '/compact'), reply('r2')]
    expect(derivedSeen(items, 'claude', 'claude')).toBe('r2')
  })

  it('开头就是斜杠命令且前面没有内容：推进；只有暂缓的斜杠命令时为 null', () => {
    expect(derivedSeen([user('u1', 'claude', '/init'), reply('r1')], 'claude', 'claude')).toBe('r1')
    const held = [user('u1', 'codex'), reply('r1'), user('u2', 'claude', '/compact')]
    expect(derivedSeen(held, 'claude', 'claude')).toBeNull()
  })

  it('中途补充以斜杠开头不算斜杠命令；没标引擎的消息按 fallback 算', () => {
    const items = [user('u1', 'codex'), reply('r1'), user('u2', undefined, '/x', 'guidance')]
    expect(derivedSeen(items, 'claude', 'claude')).toBe('u2')
  })
})

describe('接着引擎自己的会话（docs/ui/claude-resume.md）', () => {
  /** 导入一个原生会话成新对话，返回对它发消息的小工具 */
  async function imported(mode: 'inplace' | 'copy' = 'inplace') {
    const t = setup({}, true)
    const res = await t.host.importNativeSession(t.host.projects()[0].id, 'claude', NATIVE, { mode })
    if (!('sessionId' in res)) throw new Error('没有建对话')
    const id = res.sessionId
    const snap = () => t.host.open(id)
    let n = 0
    const say = async (text: string) => {
      const clientMessageId = `n${++n}`
      await t.host.send(id, { text, clientMessageId })
      await until(() => snap().items.some(i => i.kind === 'user' && i.id === clientMessageId))
      await until(() => snap().state === 'idle' && snap().queue.length === 0)
    }
    return { ...t, id, snap, say }
  }

  it('导入后换到 Codex：第一条消息的回放是导入的聊天；再换回 Claude：回放只含 Codex 期间的轮次，引擎会话 id 还是原来的', async () => {
    const { host, claude, codex, id, snap, say } = await imported()
    expect(snap().record).toMatchObject({ engineSessionId: NATIVE, imported: { sessionId: NATIVE, turns: 1 } })
    await host.update(id, { engine: 'codex' })
    await say('给 Codex')
    expect(codex.sessions[0].seeds[0]!.turns.map(t => t.user)).toEqual(['导入的话'])
    const brought = snap().items.findLast(i => i.kind === 'notice')
    expect(brought).toMatchObject({ kind: 'notice', text: '已把之前的聊天带给 Codex（1 轮）' })
    await host.update(id, { engine: 'claude' })
    expect(snap().record.engineSessionId).toBe(NATIVE)
    await say('回到 Claude')
    expect(claude.sessions[0].startId).toBe(NATIVE)
    expect(claude.sessions[0].seeds[0]!.turns.map(t => t.user)).toEqual(['给 Codex'])
    // 原生会话还在，不会被当成「没了」
    expect(snap().items.some(i => i.kind === 'notice' && i.level === 'warn')).toBe(false)
  })

  it('换了引擎后 check / sync 仍按导入的那个引擎判断：终端里新聊的能发现、能补上；换引擎后回退找不到截断点则是 0', async () => {
    const { host, claude, id, snap, say } = await imported()
    await host.update(id, { engine: 'codex' })
    await say('给 Codex')
    // 当前引擎是 Codex，它的会话 id 不是原会话的；原会话 id 记在 engineSessions.claude 里
    expect(snap().record.engineSessionId).not.toBe(NATIVE)
    expect(snap().record.engineSessions?.claude?.id).toBe(NATIVE)
    claude.newerTurns = 2
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 2 })
    await expect(host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 2 })
    expect(snap().record.imported).toMatchObject({ turns: 3 })
    // 原引擎那边还有待执行的回退：和回退了还没发消息一样，不算新聊的
    const claudeEntry = snap().record.engineSessions!.claude!
    const patch = (host as unknown as { m: { events: { patchRecord(id: string, p: Partial<SessionRecord>): void } } }).m
    patch.events.patchRecord(id, {
      engineSessions: { ...snap().record.engineSessions, claude: { ...claudeEntry, pendingRewind: 'p' } },
    })
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    // 原引擎换了新线程（回退找不到截断点）：同样是 0
    patch.events.patchRecord(id, {
      engineSessions: { ...snap().record.engineSessions, claude: { ...claudeEntry, id: null } },
    })
    await expect(host.nativeSessionAction(id, 'check')).resolves.toEqual({ added: 0 })
    await expect(host.nativeSessionAction(id, 'sync')).resolves.toEqual({ added: 0 })
  })

  it('复制一份只对现在还接着原会话的对话：换了引擎、或原引擎的线程 id 变了都拒绝，回到原引擎且 id 没变则放行', async () => {
    const { host, id, snap, say } = await imported()
    await host.update(id, { engine: 'codex' })
    await say('给 Codex')
    await expect(host.nativeSessionAction(id, 'copy')).rejects.toThrow(NATIVE_TEXT.notFollowing)
    // 回到 Claude，线程 id 还是原来的：放行（分叉点用导入时的最后位置）
    await host.update(id, { engine: 'claude' })
    expect(snap().record.engineSessionId).toBe(NATIVE)
    await expect(host.nativeSessionAction(id, 'copy')).resolves.toEqual({ added: 0 })
    expect(snap().record.imported).toMatchObject({ forked: true })
    expect(snap().record.pendingFork).toMatchObject({ from: NATIVE })
  })

  it('原地导入的对话回退换了新线程后也不能再复制一份', async () => {
    const { host, claude, id, snap, say } = await imported()
    await say('一句')
    claude.anchor = null
    await host.rewind(id, 'n1')
    expect(snap().record.engineSessionId).not.toBe(NATIVE)
    await expect(host.nativeSessionAction(id, 'copy')).rejects.toThrow(NATIVE_TEXT.notFollowing)
    expect(snap().record.imported?.forked).toBeUndefined()
  })

  it('原生会话记录没了：整段聊天当没看过，回放给适配器，单独一条带详情的 warn 提示；之后游标照常推进', async () => {
    const { host, claude, id, snap, say } = await imported()
    claude.exists = false
    await say('还在吗')
    const session = claude.sessions[0]
    expect(session.seeds[0]!.turns.map(t => t.user)).toEqual(['导入的话'])
    const warn = snap().items.find(i => i.kind === 'notice' && i.level === 'warn')
    expect(warn).toMatchObject({ kind: 'notice', text: NATIVE_TEXT.recreated(1) })
    expect(warn?.kind === 'notice' && warn.detail).toContain('导入的话')
    // 回放带着「记录没了」的标记，引擎据此不再重复报「没能恢复」；之后正常轮次的回放没有这个标记
    expect(session.seeds[0]!.recreated).toBe(true)
    // 记录又有了（接力已经写进去）：不再重复
    claude.exists = true
    await say('再来')
    expect(session.seeds[1]).toBeUndefined()
    expect(snap().items.filter(i => i.kind === 'notice' && i.level === 'warn')).toHaveLength(1)
    expect(host.record(id)?.engineSessions?.claude?.seen).toBe(snap().items.at(-1)!.id)
  })

  it('Codex 的线程记录没了：提示带 Codex 的名字，回放带 recreated；平常换引擎的回放没有这个标记', async () => {
    const { host, codex, id, snap, say } = await imported()
    await host.update(id, { engine: 'codex' })
    await say('给 Codex')
    expect(codex.sessions[0].seeds[0]!.turns.map(t => t.user)).toEqual(['导入的话'])
    expect(codex.sessions[0].seeds[0]!.recreated).toBeUndefined()
    codex.exists = false
    await say('还在吗')
    const seed = codex.sessions[0].seeds[1]!
    expect(seed.recreated).toBe(true)
    const warn = snap().items.findLast(i => i.kind === 'notice' && i.level === 'warn')
    expect(warn).toMatchObject({ kind: 'notice', text: NATIVE_TEXT.recreated(2, 'Codex') })
  })

  it('还没启动的分叉（复制一份接着聊）本来就没有文件：不触发「记录没了」', async () => {
    const { claude, snap, say } = await imported('copy')
    expect(snap().record.pendingFork).toBeTruthy()
    claude.exists = false
    await say('第一句')
    expect(claude.sessions[0].seeds[0]).toBeUndefined()
    expect(snap().items.some(i => i.kind === 'notice' && i.level === 'warn')).toBe(false)
  })

  it('有待执行的回退时也不触发', async () => {
    const { host, claude, id, snap, say } = await imported()
    await say('第一句')
    await say('第二句')
    await host.rewind(id, 'n2')
    expect(snap().record.pendingRewind).toBeTruthy()
    claude.exists = false
    await say('改')
    expect(claude.sessions.at(-1)!.seeds.at(-1)).toBeUndefined()
  })

  it('适配器没有原生会话方法：列出和导入报「不支持」，普通对话不能做导入的操作', async () => {
    const t = setup()
    t.claude.nativeSessions = undefined as never
    await expect(t.host.nativeSessions(t.host.projects()[0].id, 'claude')).rejects.toThrow('不支持')
    await expect(t.host.nativeSessionAction(t.record.id, 'check')).rejects.toThrow('不是接着')
  })
})
