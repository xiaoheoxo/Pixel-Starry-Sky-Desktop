import { describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, EngineEvent, SessionRecord } from '@pixelsky/protocol'
import { emptyMemory, ImBridge, ImRejected, PAIR_TTL, splitReply, type BridgeMemory, type SendResult } from './bridge'

const ME = 'me'
const OTHER = 'other'

function setup(over: { window?: boolean; mode?: string; bound?: string | null; project?: string | null } = {}) {
  let memory: BridgeMemory = { ...emptyMemory(), bound: over.bound === undefined ? ME : over.bound }
  const sent: string[] = []
  const box = { result: (over.window ? 'window' : 'sent') as SendResult, reconnecting: false, mode: over.mode ?? 'ask' }
  let now = 1000
  const record = (id: string) => ({ id, title: 'T', permissionMode: box.mode }) as unknown as SessionRecord
  const engine = {
    create: vi.fn(() => record('s1')),
    record: vi.fn((id: string) => record(id)),
    send: vi.fn(async () => {}),
    answer: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    reconnecting: () => box.reconnecting,
  }
  const sender = {
    maxChars: 100,
    send: async (_to: string, text: string): Promise<SendResult> => {
      if (box.result === 'sent') sent.push(text)
      return box.result
    },
  }
  const bridge = new ImBridge({
    sender,
    engine,
    projectId: () => (over.project === undefined ? 'p1' : over.project),
    channelTarget: () => null,
    channels: () => null,
    memory: () => memory,
    save: patch => {
      memory = { ...memory, ...patch }
    },
    say: (key, values) => (values ? `${key}:${JSON.stringify(values)}` : key),
    changed: () => {},
    warn: () => {},
    now: () => now,
  })
  let id = 0
  const from = (who: string, text: string, msgId = `m${++id}`) =>
    bridge.receive({ id: msgId, from: who, text, reply: `r-${msgId}` })
  return {
    bridge,
    engine,
    sender,
    sent,
    box,
    from,
    memory: () => memory,
    tick: (ms: number) => (now += ms),
    event: (e: EngineEvent) => bridge.onEvent(memory.sessionId ?? 's1', e),
  }
}

const command: ApprovalRequest = {
  requestId: 'req1',
  itemId: null,
  kind: 'command',
  title: '运行命令',
  command: 'npm test',
  alwaysScopes: [],
}

async function withSession(s: ReturnType<typeof setup>) {
  await s.from(ME, '开始')
  s.sent.length = 0
}

describe('配对', () => {
  it('没绑定时别人的消息不回复、不转给 AI', async () => {
    const s = setup({ bound: null })
    await s.from(OTHER, '你好')
    expect(s.sent).toEqual([])
    expect(s.engine.send).not.toHaveBeenCalled()
    expect(s.bridge.ignored).toBe(1)
  })

  it('发对配对码才绑定，码只能用一次', async () => {
    const s = setup({ bound: null })
    s.bridge.startPairing()
    const { code } = s.bridge.pairingState()!
    await s.from(OTHER, 'PX-000000')
    expect(s.memory().bound).toBeNull()
    await s.from(ME, code.toLowerCase())
    expect(s.memory().bound).toBe(ME)
    expect(s.bridge.pairingState()).toBeNull()
    expect(s.sent).toEqual(['im.chat.paired'])
  })

  it('错 5 次配对码作废，过期也作废', async () => {
    const s = setup({ bound: null })
    s.bridge.startPairing()
    const { code } = s.bridge.pairingState()!
    for (let i = 0; i < 5; i++) await s.from(OTHER, 'x')
    await s.from(OTHER, code)
    expect(s.memory().bound).toBeNull()

    s.bridge.startPairing()
    const next = s.bridge.pairingState()!.code
    s.tick(PAIR_TTL + 1)
    await s.from(OTHER, next)
    expect(s.memory().bound).toBeNull()
  })

  it('绑定之后别人发配对码也没用，消息被丢掉', async () => {
    const s = setup()
    await s.from(OTHER, '帮我删库')
    expect(s.engine.send).not.toHaveBeenCalled()
    expect(s.sent).toEqual([])
    expect(s.bridge.ignored).toBe(1)
  })

  it('解除绑定：待发内容丢掉，不会发给下一个人', async () => {
    const s = setup({ window: true })
    await s.from(ME, '/状态')
    expect(s.memory().outbox.length).toBe(1)
    s.bridge.unbind()
    expect(s.memory()).toMatchObject({ bound: null, sessionId: null, outbox: [] })
  })
})

describe('转给 AI', () => {
  it('第一条消息建对话，第二条接着发', async () => {
    const s = setup()
    await s.from(ME, '第一条')
    await s.from(ME, '第二条')
    expect(s.engine.create).toHaveBeenCalledTimes(1)
    expect(s.engine.send).toHaveBeenCalledWith('s1', '第二条')
  })

  it('同时来两条也只建一个对话', async () => {
    const s = setup()
    await Promise.all([s.from(ME, 'a'), s.from(ME, 'b')])
    expect(s.engine.create).toHaveBeenCalledTimes(1)
    expect(s.engine.send).toHaveBeenCalledTimes(2)
  })

  it('同一条消息推送两次只处理一次', async () => {
    const s = setup()
    await s.from(ME, '只发一次', 'dup')
    await s.from(ME, '只发一次', 'dup')
    expect(s.engine.send).toHaveBeenCalledTimes(1)
  })

  it('不是询问模式不发，并说明', async () => {
    const s = setup({ mode: 'full' })
    await s.from(ME, '继续')
    expect(s.engine.send).not.toHaveBeenCalled()
    expect(s.sent).toEqual(['im.chat.modeChanged'])
  })

  it('没选项目时说明', async () => {
    const s = setup({ project: null })
    await s.from(ME, '继续')
    expect(s.engine.create).not.toHaveBeenCalled()
    expect(s.sent).toEqual(['im.chat.noProject'])
  })

  it('斜杠命令原样发给 AI，自己的命令不转发', async () => {
    const s = setup()
    await s.from(ME, '/compact')
    expect(s.engine.send).toHaveBeenCalledWith('s1', '/compact')
    await s.from(ME, '/新对话')
    expect(s.memory().sessionId).toBeNull()
    await s.from(ME, '/状态')
    expect(s.engine.send).toHaveBeenCalledTimes(1)
  })
})

describe('审批', () => {
  it('带编号，同意和拒绝都只给 allow / deny', async () => {
    const s = setup()
    await withSession(s)
    await s.event({ type: 'approval_request', request: command })
    expect(s.sent[0]).toContain('npm test')
    await s.from(ME, '同意 1')
    expect(s.engine.answer).toHaveBeenCalledWith('s1', 'req1', { type: 'allow' })

    await s.event({ type: 'approval_request', request: { ...command, requestId: 'req2' } })
    await s.from(ME, '拒绝2')
    expect(s.engine.answer).toHaveBeenCalledWith('s1', 'req2', { type: 'deny' })
  })

  it('旧回复批不了新请求', async () => {
    const s = setup()
    await withSession(s)
    await s.event({ type: 'approval_request', request: command })
    await s.from(ME, '同意 1')
    await s.event({ type: 'approval_request', request: { ...command, requestId: 'req2' } })
    await s.from(ME, '同意 1')
    expect(s.engine.answer).toHaveBeenCalledTimes(1)
    expect(s.sent.at(-1)).toContain('im.chat.expired')
  })

  it('电脑上处理过的编号失效', async () => {
    const s = setup()
    await withSession(s)
    await s.event({ type: 'approval_request', request: command })
    await s.event({ type: 'approval_resolved', requestId: 'req1' })
    await s.from(ME, '同意 1')
    expect(s.engine.answer).not.toHaveBeenCalled()
  })

  it('回答问题：序号换成选项文字，序号不对不回答', async () => {
    const s = setup()
    await withSession(s)
    const request: ApprovalRequest = {
      ...command,
      kind: 'question',
      questions: [
        {
          question: '用哪个？',
          header: '选',
          multiSelect: false,
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
        },
      ],
    }
    await s.event({ type: 'approval_request', request })
    await s.from(ME, '同意 1')
    expect(s.engine.answer).not.toHaveBeenCalled()
    await s.from(ME, '回答 1 3')
    expect(s.engine.answer).not.toHaveBeenCalled()
    await s.from(ME, '回答 1 2')
    expect(s.engine.answer).toHaveBeenCalledWith('s1', 'req1', { type: 'answer', answers: { '用哪个？': 'B' } })
  })

  it('要填密码的问题和表单只能在电脑上处理', async () => {
    const s = setup()
    await withSession(s)
    await s.event({
      type: 'approval_request',
      request: {
        ...command,
        kind: 'question',
        questions: [{ question: '密码', header: '', secret: true, multiSelect: false, options: [] }],
      },
    })
    expect(s.sent).toEqual(['im.chat.onDesktop'])
    await s.from(ME, '回答 1 1')
    expect(s.engine.answer).not.toHaveBeenCalled()
  })
})

describe('回复和待发队列', () => {
  const finish = (s: ReturnType<typeof setup>, text: string) => [
    s.event({ type: 'item_completed', item: { kind: 'assistant', id: 'i', text, status: 'completed' } as never }),
    s.event({ type: 'turn_completed', turnId: 't', outcome: 'completed', error: null }),
  ]

  it('一轮结束才发最后一段，过程不发', async () => {
    const s = setup()
    await withSession(s)
    await s.event({
      type: 'item_completed',
      item: { kind: 'assistant', id: 'a', text: '过程', status: 'completed' } as never,
    })
    expect(s.sent).toEqual([])
    await Promise.all(finish(s, '结果'))
    expect(s.sent).toEqual(['结果'])
  })

  it('窗口过了留在队列，下一条消息时先补发', async () => {
    const s = setup()
    await withSession(s)
    s.box.result = 'window'
    await Promise.all(finish(s, '结果'))
    expect(s.memory().outbox).toEqual(['结果'])
    s.box.result = 'sent'
    await s.from(ME, '在吗')
    expect(s.sent[0]).toBe('结果')
    expect(s.memory().outbox).toEqual([])
  })

  it('断线自动重连时的失败不算结束，回复留到真正结束', async () => {
    const s = setup()
    await withSession(s)
    s.box.reconnecting = true
    await s.event({
      type: 'item_completed',
      item: { kind: 'assistant', id: 'a', text: '做了一半', status: 'completed' } as never,
    })
    await s.event({ type: 'turn_completed', turnId: 't', outcome: 'failed', error: '断线' })
    expect(s.sent).toEqual([])
    s.box.reconnecting = false
    await s.event({ type: 'turn_completed', turnId: 't2', outcome: 'completed', error: null })
    expect(s.sent).toEqual(['做了一半'])
  })

  it('引擎没启动起来：队列里的失败也要说，同样的错只说一次', async () => {
    const s = setup()
    await withSession(s)
    const queue = { type: 'queue', paused: true, items: [{ id: 'q', status: 'failed', error: '没登录' }] } as never
    await s.event(queue)
    await s.event(queue)
    expect(s.sent.length).toBe(1)
    expect(s.sent[0]).toContain('没登录')
  })

  it('失败的那条留在队列里，下一条消息时不重复说', async () => {
    const s = setup()
    await withSession(s)
    const queue = { type: 'queue', paused: true, items: [{ id: 'q', status: 'failed', error: '没登录' }] } as never
    await s.event(queue)
    await s.from(ME, '再试试')
    await s.event(queue)
    expect(s.sent.filter(t => t.includes('没登录')).length).toBe(1)
  })

  it('/停止：没有在跑的任务也有回应，有任务时等引擎说结束', async () => {
    const s = setup()
    await withSession(s)
    await s.from(ME, '/停止')
    expect(s.engine.interrupt).toHaveBeenCalledWith('s1')
    expect(s.sent).toEqual(['im.chat.stopped'])
    s.sent.length = 0
    await s.event({ type: 'turn_started', turnId: 't' })
    await s.from(ME, '/停止')
    expect(s.sent).toEqual([])
    await s.event({ type: 'turn_completed', turnId: 't', outcome: 'interrupted', error: null })
    expect(s.sent).toEqual(['im.chat.stopped'])
  })

  it('平台不收的一条不堵后面的', async () => {
    const s = setup()
    await withSession(s)
    vi.spyOn(s.sender, 'send').mockRejectedValue(new ImRejected('内容不允许'))
    await s.from(ME, '/状态')
    expect(s.memory().outbox).toEqual([])
  })

  it('别的对话的事件不发', async () => {
    const s = setup()
    await withSession(s)
    await s.bridge.onEvent('other-session', { type: 'approval_request', request: command })
    expect(s.sent).toEqual([])
  })
})

describe('splitReply', () => {
  it('短的不切', () => {
    expect(splitReply('hi', 100, 'NOTE')).toEqual(['hi'])
  })
  it('优先在换行处切，放不下的丢掉并说明', () => {
    const text = `${'a'.repeat(60)}\n${'b'.repeat(90)}\n${'c'.repeat(200)}`
    const chunks = splitReply(text, 100, 'NOTE')
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toBe('a'.repeat(60))
    expect(chunks[1].endsWith('NOTE')).toBe(true)
    expect(chunks.every(c => c.length <= 100)).toBe(true)
  })
  it('不切开代理对', () => {
    const chunks = splitReply('😀'.repeat(200), 101, 'N')
    expect(chunks[0].length % 2).toBe(0)
  })
})
