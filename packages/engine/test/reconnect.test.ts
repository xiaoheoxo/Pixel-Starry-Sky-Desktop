import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineInfo, Item, SessionSettings } from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, SessionContext } from '../src/adapter'
import { EngineHost, type EngineHostOptions } from '../src/host'
import type { HostContext } from '../src/host/context'
import { Store } from '../src/store'
import { ENGINES } from '../src/registry'
import { connectionKind, isConnectionError, reconnectDelay, reconnectLimit } from '../src/retry'

let root: string
let hosts: EngineHost[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-reconnect-'))
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
  throw new Error('reconnect timeout')
}

const DROPPED = 'stream disconnected before completion: error sending request'

/** 假引擎会话：send 默认像 Codex 一样确认收到（normal 的 input_ack）；ack=false 模拟还没确认就断 */
class ScriptedSession implements EngineSession {
  active: string | null = null
  inputs: Array<{ text: string; id: string; model: string | null }> = []
  /** 停止时不结束这一轮（模拟用户点了停止、引擎还没来得及收尾） */
  stuck = false
  private outputs = 0
  constructor(
    readonly ctx: SessionContext,
    public ack = true,
  ) {}
  send(text: string, turnId: string, id: string) {
    this.active = turnId
    this.inputs.push({ text, id, model: this.ctx.record().model })
    if (this.ack) this.confirm(id)
  }
  /** 引擎确认收到了用户消息 */
  confirm(id = this.inputs.at(-1)!.id) {
    this.ctx.emit({ type: 'input_ack', id, state: 'consumed', mode: 'normal' })
  }
  /** 引擎开始回复（助手条目） */
  output() {
    this.ctx.emit({
      type: 'item_started',
      item: { kind: 'assistant', id: `out-${++this.outputs}`, text: '', status: 'running' },
    })
  }
  /** 引擎自己在重试这次请求（Claude 的 api_retry） */
  engineRetry() {
    this.ctx.emit({
      type: 'request_retry',
      retry: { turnId: this.active!, attempt: 1, maxRetries: 5, retryAt: null, reason: 'overloaded' },
    })
  }
  finish(outcome: 'completed' | 'failed' | 'interrupted' = 'completed', error: string | null = null) {
    const turnId = this.active!
    this.active = null
    this.ctx.emit({ type: 'turn_completed', turnId, outcome, error })
  }
  drop(error = DROPPED) {
    this.finish('failed', error)
  }
  async interrupt() {
    if (this.stuck) return
    if (this.active) this.finish('interrupted')
  }
  answer() {}
  async update(_patch: Partial<SessionSettings>) {}
  async close() {
    if (this.active) this.finish('interrupted')
  }
}
class ScriptedAdapter implements EngineAdapter {
  sessions: ScriptedSession[] = []
  /** 新会话收到消息后是否确认 */
  ack = true
  async info(): Promise<EngineInfo> {
    return { ...ENGINES.claude, status: 'ready', version: 'fake', path: 'fake', message: null }
  }
  createSession(ctx: SessionContext) {
    const s = new ScriptedSession(ctx, this.ack)
    this.sessions.push(s)
    return s
  }
}
function setup(opts: Partial<EngineHostOptions> = {}) {
  const adapter = new ScriptedAdapter()
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    adapters: { claude: adapter },
    emit: () => {},
    reconnectDelays: [0, 0, 0, 0, 0],
    ...opts,
  })
  hosts.push(host)
  const p = host.addProject(root),
    record = host.createSession({ projectId: p.id, model: 'alpha', effort: 'low' })
  const send = (id: string, text = id) => host.send(record.id, { text, clientMessageId: id })
  const users = () =>
    host
      .open(record.id)
      .items.filter((i): i is Extract<Item, { kind: 'user' }> => i.kind === 'user')
      .map(i => ({ text: i.text, reconnect: i.reconnect, dismissed: i.dismissed }))
  const queue = () => host.open(record.id).queue
  const hostCtx = () => (host as unknown as { ctx: HostContext }).ctx
  return { host, adapter, record, send, users, queue, hostCtx, session: () => adapter.sessions[0] }
}
/** 重启应用：同一份数据目录再起一个宿主（原来的先关掉） */
async function restart(old: EngineHost) {
  await old.shutdown()
  const adapter = new ScriptedAdapter()
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    adapters: { claude: adapter },
    emit: () => {},
    reconnectDelays: [0, 0, 0, 0, 0],
  })
  hosts.push(host)
  return { host, adapter, session: () => adapter.sessions[0] }
}
/** 等得比 until 久（重新排期要 1 秒） */
const untilLong = async (fn: () => boolean, ms = 4000) => {
  for (let i = 0; i < ms / 10; i++) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('reconnect timeout')
}

describe('断线自动重连', () => {
  it('连接中断：不标失败也不暂停，自动发一句「继续」接着做，接上后这条算交付', async () => {
    const { host, record, send, users, session } = setup({ continueText: () => 'Continue' })
    await send('a', '把单测补上')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => session().inputs.length === 2)
    expect(session().inputs.map(i => i.text)).toEqual(['把单测补上', 'Continue'])
    expect(host.open(record.id).queuePaused).toBe(false)
    expect(host.open(record.id).queue[0]).toMatchObject({ id: 'a', status: 'running', reconnect: { attempt: 1 } })
    expect(users()).toEqual([
      { text: '把单测补上', reconnect: undefined, dismissed: undefined },
      { text: 'Continue', reconnect: 1, dismissed: undefined },
    ])
    session().finish()
    await until(() => host.open(record.id).state === 'idle')
    expect(host.open(record.id).queue).toEqual([])
  })

  it('次数用完才算发送失败，记下自动重连了几次；之后可以关掉，对话里那条标「未送达」', async () => {
    const { host, record, send, users, session } = setup()
    host.setRetrySettings(2)
    await send('a')
    for (let n = 1; n <= 3; n++) {
      await until(() => !!session()?.active && session().inputs.length === n)
      session().drop()
    }
    await until(() => host.open(record.id).queue[0]?.status === 'failed')
    expect(host.open(record.id).queue[0]).toMatchObject({ error: DROPPED, reconnected: 2, reconnect: undefined })
    expect(host.open(record.id).queuePaused).toBe(true)
    // 失败的一轮不推进引擎的游标，后面的「继续」前面会带交接材料（handoff.ts）
    expect(session().inputs.map(i => i.text.split('\n').at(-1))).toEqual(['a', '继续', '继续'])
    host.dismissQueued(record.id, 'a')
    expect(host.open(record.id)).toMatchObject({ queue: [], queuePaused: false })
    expect(users()[0]).toEqual({ text: 'a', reconnect: undefined, dismissed: true })
  })

  it('不是连接问题的失败照常失败，不自动重连', async () => {
    const { host, record, send, session } = setup()
    await send('a')
    await until(() => !!session()?.active)
    session().finish('failed', '登录已失效，请重新登录')
    await until(() => host.open(record.id).queue[0]?.status === 'failed')
    expect(session().inputs).toHaveLength(1)
    expect(host.open(record.id).queue[0].reconnected).toBeUndefined()
  })

  it('重连次数设成 0 就是关闭自动重连', async () => {
    const { host, record, send, session } = setup()
    host.setRetrySettings(0)
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => host.open(record.id).queue[0]?.status === 'failed')
    expect(session().inputs).toHaveLength(1)
  })

  it('等重连时：后面的消息也等着；立即重连不等倒计时；停止就算发送失败', async () => {
    const { host, record, send, session } = setup({ reconnectDelays: [60_000, 60_000] })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => host.open(record.id).queue[0]?.reconnect?.attempt === 1)
    await send('b')
    await new Promise(r => setTimeout(r, 30))
    expect(session().inputs).toHaveLength(1)
    await host.runQueuedNow(record.id, 'a')
    await until(() => session().inputs.length === 2)
    expect(session().inputs[1].text).toBe('继续')
    session().drop()
    await until(() => host.open(record.id).queue[0]?.reconnect?.attempt === 2)
    await host.interrupt(record.id)
    expect(host.open(record.id).queue.map(q => [q.id, q.status, q.reconnected ?? null])).toEqual([
      ['a', 'failed', 1],
      ['b', 'queued', null],
    ])
    expect(host.open(record.id).queuePaused).toBe(true)
    expect(session().inputs).toHaveLength(2)
  })

  it('消息还没发出去就连不上：到时原样重发同一条，不多出一条消息', async () => {
    let fail = 1
    const { host, record, send, users, session } = setup({
      validateInput: async () => {
        if (fail-- > 0) throw new Error('fetch failed')
      },
    })
    await send('a', '你好')
    await until(() => session()?.inputs.length === 1)
    expect(session().inputs[0]).toMatchObject({ text: '你好', id: 'a' })
    expect(users()).toEqual([{ text: '你好', reconnect: undefined, dismissed: undefined }])
    expect(() => host.dismissQueued(record.id, 'a')).toThrow()
  })

  it('还没进对话的失败消息不能关掉，只能重试或撤回', async () => {
    const { host, record, send } = setup({
      validateInput: async () => {
        throw new Error('账号已切换')
      },
    })
    await send('a')
    await until(() => host.open(record.id).queue[0]?.status === 'failed')
    expect(() => host.dismissQueued(record.id, 'a')).toThrow('这条消息还没发出去，请重试或撤回')
  })

  it('有发送失败的消息时直接说新的：失败那条自动关掉', async () => {
    const { host, record, send, users, session } = setup()
    await send('a')
    await until(() => !!session()?.active)
    session().finish('failed', '请求无效')
    await until(() => host.open(record.id).state === 'idle')
    await send('b', '继续')
    await until(() => session().inputs.length === 2)
    expect(host.open(record.id).queue.map(q => q.id)).toEqual(['b'])
    expect(users().map(u => [u.text, !!u.dismissed])).toEqual([
      ['a', true],
      ['继续', false],
    ])
  })
})

describe('断线自动重连：送达标记（delivered）', () => {
  it('整条发送先记「没送达」，引擎确认收到后记「已送达」；「继续」不再改它', async () => {
    const { adapter, host, record, send, queue, session } = setup()
    adapter.ack = false
    await send('a')
    await until(() => !!session()?.active)
    expect(queue()[0]).toMatchObject({ status: 'running', delivered: false })
    session().confirm()
    expect(queue()[0].delivered).toBe(true)
    session().drop()
    await until(() => session().inputs.length === 2)
    expect(session().inputs[1].text).toBe('继续')
    expect(queue()[0]).toMatchObject({ delivered: true, reconnect: { attempt: 1 } })
    expect(queue()[0].reconnect?.resend).toBeUndefined()
    expect(host.open(record.id).queuePaused).toBe(false)
  })

  it('没有确认但引擎已经有输出，也算送达：断线后发「继续」', async () => {
    const { adapter, send, queue, session } = setup()
    adapter.ack = false
    await send('a')
    await until(() => !!session()?.active)
    session().output()
    expect(queue()[0].delivered).toBe(true)
    session().drop()
    await until(() => session().inputs.length === 2)
    expect(session().inputs[1].text).toBe('继续')
  })

  it('引擎自己在重试（request_retry）也算收到', async () => {
    const { adapter, send, queue, session } = setup()
    adapter.ack = false
    await send('a')
    await until(() => !!session()?.active)
    session().engineRetry()
    expect(queue()[0].delivered).toBe(true)
  })

  it('没送达就断线（网络类错误）：原样重发同一条，对话里只有一条，原条目时间不变，接上后队列清空', async () => {
    const { adapter, host, record, send, users, queue, session } = setup()
    adapter.ack = false
    await send('a', '你好')
    await until(() => !!session()?.active)
    const userA = () => host.open(record.id).items.find(i => i.id === 'a') as Extract<Item, { kind: 'user' }>
    const createdAt = userA().createdAt
    await new Promise(r => setTimeout(r, 15))
    session().drop()
    await until(() => session().inputs.length === 2)
    expect(session().inputs.map(i => [i.text, i.id])).toEqual([
      ['你好', 'a'],
      ['你好', 'a'],
    ])
    expect(queue()[0]).toMatchObject({
      status: 'running',
      delivered: false,
      messageUuid: 'a',
      reconnect: { resend: true },
    })
    expect(users()).toEqual([{ text: '你好', reconnect: undefined, dismissed: undefined }])
    expect(userA().createdAt).toBe(createdAt)
    session().confirm()
    session().finish()
    await until(() => host.open(record.id).state === 'idle')
    expect(queue()).toEqual([])
  })

  it('没送达就意外退出：不自动重连，直接失败；重试时原样重发', async () => {
    const { adapter, host, record, send, queue, session } = setup()
    adapter.ack = false
    await send('a', '你好')
    await until(() => !!session()?.active)
    session().drop('Codex 意外退出（代码 1）')
    await until(() => queue()[0]?.status === 'failed')
    expect(queue()[0]).toMatchObject({ error: 'Codex 意外退出（代码 1）' })
    expect(queue()[0].reconnected).toBeUndefined()
    expect(host.open(record.id).queuePaused).toBe(true)
    expect(session().inputs).toHaveLength(1)
    await host.runQueuedNow(record.id, 'a')
    await until(() => session().inputs.length === 2)
    expect(session().inputs[1].text).toBe('你好')
  })

  it('引擎确认收到后意外退出：发「继续」；原文同时带网络关键词的，没送达也算网络类', async () => {
    const first = setup()
    await first.send('a')
    await until(() => !!first.session()?.active)
    first.session().drop('Codex 意外退出（代码 1）')
    await until(() => first.session().inputs.length === 2)
    expect(first.session().inputs[1].text).toBe('继续')

    const second = setup()
    second.adapter.ack = false
    await second.send('b', '你好')
    await until(() => !!second.session()?.active)
    second.session().drop('Codex 意外退出：stream disconnected before completion')
    await until(() => second.session().inputs.length === 2)
    expect(second.session().inputs[1].text).toBe('你好')
  })

  it('重连前平台连不上：仍只发「继续」，原条目的 id 和时间不变', async () => {
    let calls = 0
    const { host, record, send, users, session } = setup({
      validateInput: async () => {
        if (++calls === 2) throw new Error('fetch failed')
      },
    })
    await send('a', '你好')
    await until(() => !!session()?.active)
    const userA = () => host.open(record.id).items.find(i => i.id === 'a') as Extract<Item, { kind: 'user' }>
    const createdAt = userA().createdAt
    session().drop()
    await until(() => session().inputs.length === 2)
    expect(calls).toBe(3)
    expect(session().inputs.map(i => i.text)).toEqual(['你好', '继续'])
    expect(users().map(u => [u.text, u.reconnect])).toEqual([
      ['你好', undefined],
      ['继续', 2],
    ])
    expect(userA().createdAt).toBe(createdAt)
  })

  it('原消息已经不在对话里：不发「继续」，标发送失败', async () => {
    const { host, record, send, queue, hostCtx, session } = setup({ reconnectDelays: [60_000] })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => queue()[0]?.reconnect?.attempt === 1)
    hostCtx().m.events.apply(record.id, { type: 'items_truncated', fromItemId: 'a' })
    await host.runQueuedNow(record.id, 'a')
    await until(() => queue()[0]?.status === 'failed')
    expect(queue()[0].error).toBe('原消息已不在对话里，请重试或撤回')
    expect(session().inputs).toHaveLength(1)
    expect(host.open(record.id).queuePaused).toBe(true)
  })

  it('斜杠命令断线不自动重连，直接失败可重试', async () => {
    const { host, record, send, queue, session } = setup()
    await send('s', '/compact')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => queue()[0]?.status === 'failed')
    expect(queue()[0]).toMatchObject({ error: DROPPED })
    expect(queue()[0].reconnected).toBeUndefined()
    expect(session().inputs).toHaveLength(1)
    expect(host.open(record.id).queuePaused).toBe(true)
  })

  it('等重连时换了模型：重连用会话现在的设置，不用入队时存的那份', async () => {
    const { host, record, send, queue, session } = setup({ reconnectDelays: [60] })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await host.update(record.id, { model: 'beta' })
    await until(() => session().inputs.length === 2)
    expect(session().inputs.map(i => i.model)).toEqual(['alpha', 'beta'])
    expect(queue()[0].settings.model).toBe('beta')
  })
})

describe('断线自动重连：次数', () => {
  it('有进展就从头算：最多 2 次，分开断 4 次也不失败', async () => {
    const { host, record, send, queue, session } = setup()
    host.setRetrySettings(2)
    await send('a')
    for (let n = 1; n <= 4; n++) {
      await until(() => session()?.inputs.length === n && !!session().active)
      session().output()
      session().drop()
    }
    await until(() => session().inputs.length === 5)
    expect(queue()[0]).toMatchObject({ status: 'running', reconnect: { attempt: 1, max: 2 } })
    expect(host.open(record.id).queuePaused).toBe(false)
  })

  it('一直没进展就累加，次数用完才失败', async () => {
    const { host, record, send, queue, session } = setup()
    host.setRetrySettings(2)
    await send('a')
    for (let n = 1; n <= 3; n++) {
      await until(() => session()?.inputs.length === n && !!session().active)
      session().drop()
    }
    await until(() => queue()[0]?.status === 'failed')
    expect(queue()[0].reconnected).toBe(2)
    expect(host.open(record.id).queuePaused).toBe(true)
  })

  it('引擎自己重试过（request_retry）：宿主不再叠加一层重连，直接失败', async () => {
    const { host, record, send, queue, session } = setup()
    await send('a')
    await until(() => !!session()?.active)
    session().engineRetry()
    session().drop()
    await until(() => queue()[0]?.status === 'failed')
    expect(session().inputs).toHaveLength(1)
    expect(queue()[0].reconnected).toBeUndefined()
    expect(host.open(record.id).queuePaused).toBe(true)
  })

  it('等待中把次数改成 0：到点不再重连，按上次断开的原因标失败', async () => {
    const { host, record, send, queue, session } = setup({ reconnectDelays: [80] })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => queue()[0]?.reconnect?.attempt === 1)
    host.setRetrySettings(0)
    await until(() => queue()[0]?.status === 'failed')
    expect(queue()[0]).toMatchObject({ error: DROPPED, reconnect: undefined })
    // 到点时这次并没有发出去：只算前面已经重连的 0 次
    expect(queue()[0].reconnected).toBe(0)
    expect(session().inputs).toHaveLength(1)
    expect(host.open(record.id).queuePaused).toBe(true)
  })

  it('每次有输出都从头算，但累计超过 max 的 3 倍也不再重连（上游每次出几个字就断）', async () => {
    const { host, record, send, queue, session } = setup()
    host.setRetrySettings(2)
    await send('a')
    for (let n = 1; n <= 7; n++) {
      await until(() => session()?.inputs.length === n && !!session().active)
      session().output()
      session().drop()
      if (n < 7) await until(() => session().inputs.length === n + 1)
    }
    await until(() => queue()[0]?.status === 'failed')
    expect(session().inputs).toHaveLength(7)
    expect(queue()[0]).toMatchObject({ error: DROPPED, reconnected: 6 })
    expect(host.open(record.id).queuePaused).toBe(true)
  })

  it('引擎重试之后又有输出：说明接上了，之后再断由宿主重连', async () => {
    const { send, session } = setup()
    await send('a')
    await until(() => !!session()?.active)
    session().engineRetry()
    session().output()
    session().drop()
    await until(() => session().inputs.length === 2)
    expect(session().inputs[1].text).toBe('继续')
  })
})

describe('断线自动重连：停止就是结算', () => {
  it('派发中点停止：那条算发送失败，带已自动重连的次数；之后启动完成也不再发', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { host, record, send, queue, session } = setup({
      validateInput: async () => {
        if (++calls === 2) await gate
      },
    })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => queue()[0]?.status === 'dispatching')
    await host.interrupt(record.id)
    expect(queue()[0]).toMatchObject({ status: 'failed', error: DROPPED, reconnected: 0, reconnect: undefined })
    expect(host.open(record.id).queuePaused).toBe(true)
    release()
    await until(() => host.open(record.id).state === 'idle')
    expect(session().inputs).toHaveLength(1)
    expect(queue()[0].status).toBe('failed')
  })

  it('停止之后引擎才报连接错误：不重连，直接失败', async () => {
    const { host, record, send, queue, session } = setup()
    await send('a')
    await until(() => !!session()?.active)
    session().stuck = true
    await host.interrupt(record.id)
    session().drop()
    await until(() => queue()[0]?.status === 'failed')
    expect(session().inputs).toHaveLength(1)
    expect(queue()[0].reconnected).toBeUndefined()
    expect(host.open(record.id).queuePaused).toBe(true)
  })

  it('归档会话时停掉等着的重连', async () => {
    const { host, record, send, queue, session } = setup({ reconnectDelays: [40] })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => queue()[0]?.reconnect?.attempt === 1)
    await host.archiveSession(record.id, true)
    expect(queue()[0]).toMatchObject({ status: 'failed', reconnected: 0, reconnect: undefined })
    await new Promise(r => setTimeout(r, 120))
    expect(session().inputs).toHaveLength(1)
  })

  it('重启时在等重连：恢复后整体暂停，点「继续重连」才发「继续」', async () => {
    const first = setup({ reconnectDelays: [60_000] })
    await first.send('a')
    await until(() => !!first.session()?.active)
    first.session().drop()
    await until(() => first.queue()[0]?.reconnect?.attempt === 1)
    const second = await restart(first.host)
    const snap = second.host.open(first.record.id)
    expect(snap.queuePaused).toBe(true)
    expect(snap.queue[0]).toMatchObject({ id: 'a', status: 'queued', delivered: true, reconnect: { attempt: 1 } })
    await new Promise(r => setTimeout(r, 40))
    expect(second.adapter.sessions).toHaveLength(0)
    await second.host.runQueuedNow(first.record.id, 'a')
    await until(() => second.session()?.inputs.length === 1)
    expect(second.session().inputs[0].text).toBe('继续')
  })

  it('暂停着的重连项遇到空闲时发新消息：先结算成发送失败（那条自动关掉），新消息直接发', async () => {
    const first = setup({ reconnectDelays: [60_000] })
    await first.send('a')
    await until(() => !!first.session()?.active)
    first.session().drop()
    await until(() => first.queue()[0]?.reconnect?.attempt === 1)
    const second = await restart(first.host)
    await second.host.send(first.record.id, { text: 'b', clientMessageId: 'b' })
    await until(() => second.session()?.inputs.length === 1)
    expect(second.session().inputs[0].text).toBe('b')
    const snap = second.host.open(first.record.id)
    expect(snap.queue.map(q => [q.id, q.status])).toEqual([['b', 'running']])
    // 引擎收到过 a（delivered）：从队列拿掉，但对话里那条不标「未送达」
    const a = snap.items.find(i => i.id === 'a')
    expect(a).toMatchObject({ kind: 'user', text: 'a' })
    expect(a?.kind === 'user' && a.dismissed).toBeFalsy()
  })

  it('引擎没收到的重连项被这样结算后关掉：对话里那条照旧标「未送达」', async () => {
    const first = setup({ reconnectDelays: [60_000] })
    first.adapter.ack = false
    await first.send('a')
    await until(() => !!first.session()?.active)
    first.session().drop()
    await until(() => first.queue()[0]?.reconnect?.attempt === 1)
    const second = await restart(first.host)
    await second.host.send(first.record.id, { text: 'b', clientMessageId: 'b' })
    await until(() => second.session()?.inputs.length === 1)
    expect(second.host.open(first.record.id).items.find(i => i.id === 'a')).toMatchObject({
      kind: 'user',
      dismissed: true,
    })
  })
})

describe('断线自动重连：插队执行别的消息', () => {
  it('等重连时插队执行后面的消息：重连项先算发送失败，插队的跑完后不会再自己发「继续」', async () => {
    const { host, record, send, queue, session } = setup({ reconnectDelays: [60_000] })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => queue()[0]?.reconnect?.attempt === 1)
    await send('b')
    await host.runQueuedNow(record.id, 'b')
    await until(() => session().inputs.length === 2)
    expect(session().inputs[1].text).toBe('b')
    expect(queue().find(q => q.id === 'a')).toMatchObject({ status: 'failed', reconnected: 0 })
    expect(queue().find(q => q.id === 'a')?.reconnect).toBeUndefined()
    session().finish()
    await until(() => host.open(record.id).state === 'idle')
    await new Promise(r => setTimeout(r, 40))
    expect(session().inputs).toHaveLength(2)
    expect(queue().map(q => [q.id, q.status])).toEqual([['a', 'failed']])
  })

  it('派发重连时插队执行后面的消息：重连项算发送失败，不会被改回排队', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const { host, record, send, queue, session } = setup({
      validateInput: async () => {
        if (++calls === 2) await gate
      },
    })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => queue()[0]?.status === 'dispatching')
    await send('b')
    const run = host.runQueuedNow(record.id, 'b')
    await new Promise(r => setTimeout(r, 20))
    release()
    await run
    await until(() => session().inputs.length === 2)
    expect(session().inputs[1].text).toBe('b')
    expect(queue().find(q => q.id === 'a')).toMatchObject({ status: 'failed', reconnected: 0 })
    expect(queue().find(q => q.id === 'a')?.reconnect).toBeUndefined()
    session().finish()
    await until(() => host.open(record.id).state === 'idle')
    await new Promise(r => setTimeout(r, 40))
    expect(session().inputs).toHaveLength(2)
  })

  it('立即重连（选中的就是重连项）不受影响', async () => {
    const { host, record, send, queue, session } = setup({ reconnectDelays: [60_000] })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => queue()[0]?.reconnect?.attempt === 1)
    await host.runQueuedNow(record.id, 'a')
    await until(() => session().inputs.length === 2)
    expect(session().inputs[1].text).toBe('继续')
  })
})

describe('断线自动重连：回退与重新排期', () => {
  it('等重连时回退 / 撤销回退被拒绝；停止后回退，不再发「继续」', async () => {
    const { host, record, send, queue, session } = setup({ reconnectDelays: [60_000] })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => queue()[0]?.reconnect?.attempt === 1)
    await expect(host.rewind(record.id, 'a')).rejects.toThrow('正在自动重连，请先停止再回退')
    await expect(host.undoRewind(record.id)).rejects.toThrow('正在自动重连，请先停止再回退')
    await host.interrupt(record.id)
    await host.rewind(record.id, 'a')
    expect(host.open(record.id).items.some(i => i.id === 'a')).toBe(false)
    await new Promise(r => setTimeout(r, 40))
    expect(session().inputs).toHaveLength(1)
  })

  it('held 的重连项（旧版本存盘可能留下）界面不显示卡片，回退也不拦', async () => {
    const { host, record, send, queue, hostCtx, session } = setup({ reconnectDelays: [60_000] })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    await until(() => queue()[0]?.reconnect?.attempt === 1)
    hostCtx().m.queue.changeQueue(record.id, 'a', { held: true })
    await host.rewind(record.id, 'a')
    expect(host.open(record.id).items.some(i => i.id === 'a')).toBe(false)
  })

  it('到点时会话正忙：1 秒后再排，不会一直卡住', async () => {
    const { host, record, send, queue, hostCtx, session } = setup({ reconnectDelays: [30] })
    await send('a')
    await until(() => !!session()?.active)
    session().drop()
    // drop 同步安排了 30 毫秒后的重连，这里在它到点之前把会话标成「正在处理」，pump 会直接返回
    hostCtx().changingSessions.add(record.id)
    await new Promise(r => setTimeout(r, 120))
    expect(session().inputs).toHaveLength(1)
    expect(queue()[0]).toMatchObject({ status: 'queued', reconnect: { attempt: 1 } })
    hostCtx().changingSessions.delete(record.id)
    await untilLong(() => session().inputs.length === 2)
    expect(session().inputs[1].text).toBe('继续')
    expect(host.open(record.id).queuePaused).toBe(false)
  })
})

describe('持久化：旧队列的兼容（store.loadQueue）', () => {
  it('排队中的重连项保留并整体暂停；派发中的转待核对；没有 delivered 的由 resend 推出来', () => {
    const { host, record } = setup()
    const settings = { model: 'alpha', effort: 'low', platform: null, provider: null }
    const base = { text: 'x', createdAt: 1, settings, error: null, mode: 'normal' }
    const reconnect = { attempt: 2, max: 5, since: 1, at: 2, reason: '断了' }
    const items = [
      { ...base, id: 'q1', status: 'queued', messageUuid: 'q1', reconnect },
      { ...base, id: 'q2', status: 'queued', messageUuid: 'q2', reconnect: { ...reconnect, resend: true } },
      { ...base, id: 'q3', status: 'dispatching', messageUuid: 'q3', reconnect: { ...reconnect, attempt: 3 } },
      { ...base, id: 'q4', status: 'running', messageUuid: 'q4' },
      { ...base, id: 'q5', status: 'queued', reconnect },
      { ...base, id: 'q6', status: 'queued', messageUuid: 'q6', delivered: false, reconnect },
      { ...base, id: 'q7', status: 'queued', messageUuid: 'q7', held: true, reconnect },
      { ...base, id: 'q8', status: 'queued', held: true },
    ]
    const dir = join(root, 'data', 'sessions', record.id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'queue.json'), JSON.stringify({ version: 1, items, paused: false, receipts: [] }))
    const loaded = new Store(join(root, 'data')).loadQueue(host.open(record.id).record)
    expect(loaded.paused).toBe(true)
    const by = Object.fromEntries(loaded.items.map(q => [q.id, q]))
    expect(by.q1).toMatchObject({ status: 'queued', delivered: true, reconnect: { attempt: 2 } })
    expect(by.q2).toMatchObject({ status: 'queued', delivered: false, reconnect: { resend: true } })
    expect(by.q3).toMatchObject({ status: 'uncertain', delivered: true, reconnect: undefined, reconnected: 2 })
    expect(by.q3.error).toBe('上次退出前已开始交付，请核对后再重试')
    expect(by.q4.status).toBe('uncertain')
    expect(by.q4.reconnect).toBeUndefined()
    expect('delivered' in by.q4).toBe(false)
    expect(by.q5).toMatchObject({ status: 'queued', delivered: false })
    expect(by.q6).toMatchObject({ status: 'queued', delivered: false })
    // 旧版本可能把重连项存成 held：去掉，整体已暂停，界面显示「已暂停」卡片；普通排队项的 held 不动
    expect(by.q7.held).toBe(false)
    expect(by.q8.held).toBe(true)
  })
})

describe('retry.ts 自动重连规则', () => {
  it('只认连接类错误', () => {
    for (const text of [
      DROPPED,
      'ECONNRESET',
      'socket hang up',
      'API Error: 503 Service Unavailable',
      'Overloaded',
      '连不上模型服务',
      'Codex 意外退出（代码 1）',
    ])
      expect(isConnectionError(text), text).toBe(true)
    for (const text of [
      null,
      '',
      '登录已失效，请重新登录',
      '余额不足',
      'API Error: 401 Unauthorized',
      '429 rate limit exceeded',
      '找不到所选模型',
      'Prompt is too long',
    ])
      expect(isConnectionError(text), String(text)).toBe(false)
  })

  it('connectionKind：网络类和退出类分开，原文带网络关键词的算网络类，isConnectionError 是它不为 null', () => {
    for (const text of [
      DROPPED,
      'ECONNRESET',
      'API Error: 503 Service Unavailable',
      'HTTP 503',
      '连不上模型服务',
      'Overloaded',
    ])
      expect(connectionKind(text), text).toBe('network')
    for (const text of ['Codex 意外退出（代码 1）', 'process exited with code 1'])
      expect(connectionKind(text), text).toBe('exit')
    for (const text of ['Codex 意外退出：stream disconnected before completion', '意外退出 ECONNRESET'])
      expect(connectionKind(text), text).toBe('network')
    for (const text of [
      null,
      undefined,
      '',
      '登录已失效，请重新登录',
      '429 rate limit exceeded',
      '意外退出，余额不足',
      'invalid request',
      'code 15031 failed',
      'HTTP 401',
    ])
      expect(connectionKind(text), String(text)).toBeNull()
    for (const text of ['Codex 意外退出（代码 1）', DROPPED, '余额不足', null])
      expect(isConnectionError(text), String(text)).toBe(connectionKind(text) !== null)
  })

  it('等待时间 1 秒起翻倍、封顶 30 秒、±20% 抖动；次数跟随请求重试设置', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(n => reconnectDelay(n, () => 0.5))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ])
    expect(reconnectDelay(1, () => 0)).toBe(800)
    expect(reconnectDelay(1, () => 1)).toBe(1200)
    expect(reconnectLimit(null)).toBe(5)
    expect(reconnectLimit(3)).toBe(3)
  })
})
