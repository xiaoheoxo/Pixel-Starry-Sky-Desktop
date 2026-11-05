import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '@pixelsky/protocol'
import type {
  ChannelFlow,
  ChannelMessage,
  ChannelTask,
  ChannelTextMessage,
  FlowStep,
} from '../../shared/types/channels'
import { emptyMemory, ImBridge, type BridgeEngine, type BridgeMemory, type SendResult } from './bridge'
import { pickAnswers, type BridgeChannels, type ChatMemberAccess } from './route'

const chat = (root: string) => ({ via: 'qq' as const, root })
const task = (id: string, root: string, patch: Partial<ChannelTask> = {}): ChannelTask => ({
  kind: 'task',
  id,
  channelId: 'c1',
  at: 1,
  authorId: 'me',
  assigneeId: 'ming',
  title: `活 ${id}`,
  status: 'running',
  chat: chat(root),
  ...patch,
})
const step = (id: string, patch: Partial<FlowStep> = {}): FlowStep => ({
  id,
  title: `步骤 ${id}`,
  memberId: 'ming',
  deps: [],
  kind: 'work',
  taskId: null,
  status: 'pending',
  rejects: 0,
  ...patch,
})
const flow = (id: string, root: string, patch: Partial<ChannelFlow> = {}): ChannelTextMessage => ({
  kind: 'message',
  id,
  channelId: 'c1',
  at: 1,
  authorId: 'me',
  text: '计划',
  format: 'plain',
  chat: chat(root),
  flow: {
    title: '计划',
    status: 'draft',
    steps: [],
    maxRejects: 2,
    planner: { memberId: 'ming', request: 'x', taskId: null },
    ...patch,
  },
})
const approval = (requestId: string): ApprovalRequest =>
  ({ requestId, kind: 'tool', title: '运行命令', command: 'pnpm test' }) as ApprovalRequest

function setup() {
  let memory: BridgeMemory = { ...emptyMemory(), bound: 'u1', reply: 'r0' }
  const sent: string[] = []
  const members: Record<string, ChatMemberAccess> = {
    ming: { name: '小明', allowed: true, local: true },
    hong: { name: '小红', allowed: true, local: true },
    qiang: { name: '阿强', allowed: false, local: true },
    zhou: { name: '老周', allowed: true, local: false },
  }
  const items: ChannelMessage[] = []
  const posted: { text: string }[] = []
  const box = { root: 'root1' as string | null, target: 'c1' as string | null, ready: true }
  const port: BridgeChannels = {
    info: id => (id === 'c1' ? { name: '前端', members: Object.values(members) } : null),
    access: id => members[id] ?? { name: '?', allowed: false, local: false },
    mentions: (_id, text) => Object.keys(members).filter(k => text.includes(`@${members[k].name}`)),
    post: async (_id, text) => {
      posted.push({ text })
      return { root: box.root }
    },
    items: () => items,
    stopTask: vi.fn(async () => undefined),
    flow: vi.fn(async () => undefined),
  }
  const engine: BridgeEngine = {
    create: vi.fn(),
    record: () => null,
    send: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    reconnecting: () => false,
  }
  const bridge = new ImBridge({
    sender: {
      maxChars: 1000,
      send: async (_to, text): Promise<SendResult> => {
        sent.push(text)
        return 'sent'
      },
    },
    engine,
    projectId: () => 'p1',
    channelTarget: () => box.target,
    channels: () => (box.ready ? port : null),
    memory: () => memory,
    save: patch => {
      memory = { ...memory, ...patch }
    },
    say: (key, values) => (values ? `${key}:${JSON.stringify(values)}` : key),
    changed: () => {},
    warn: () => {},
  })
  let id = 0
  const say = (text: string) => bridge.receive({ id: `m${++id}`, from: 'u1', text, reply: `r${id}` })
  const replace = (next: ChannelMessage) => {
    const i = items.findIndex(x => x.id === next.id)
    if (i >= 0) items[i] = next
    else items.push(next)
  }
  return { bridge, engine, port, sent, posted, items, box, say, replace, memory: () => memory }
}

describe('消息通道 · 频道模式：发进频道', () => {
  let s: ReturnType<typeof setup>
  beforeEach(() => {
    s = setup()
  })

  it('@ 了放宽模式的成员：整条不发（连同一条里能派的也不发），说明是谁', async () => {
    await s.say('@小明 修页面，@阿强 升依赖')
    expect(s.posted).toEqual([])
    expect(s.sent[0]).toContain('im.chat.blocked')
    expect(s.sent[0]).toContain('阿强')
    expect(s.memory().roots).toEqual([])
  })

  it('没 @、也没牵头：只发到频道，回一句没人接并列出成员', async () => {
    s.box.root = null
    await s.say('大家看一下')
    expect(s.posted).toEqual([{ text: '大家看一下' }])
    expect(s.sent[0]).toContain('im.chat.unrouted')
    expect(s.sent[0]).toContain('@小明')
    expect(s.memory().roots).toEqual([])
  })

  it('还没选频道、频道服务没就绪：不发，说明原因；不会落到新对话', async () => {
    s.box.target = ''
    await s.say('@小明 修页面')
    s.box.target = 'c1'
    s.box.ready = false
    await s.say('@小明 修页面')
    expect(s.posted).toEqual([])
    expect(s.engine.create).not.toHaveBeenCalled()
    expect(s.sent).toEqual(['im.chat.noChannel', 'im.chat.noChannel'])
  })

  it('斜杠命令之外的 / 开头原样发；/新对话 只提示现在进哪个频道', async () => {
    await s.say('/compact 一下')
    expect(s.posted).toEqual([{ text: '/compact 一下' }])
    await s.say('/新对话')
    expect(s.sent.at(-1)).toContain('im.chat.inChannel')
    expect(s.sent.at(-1)).toContain('前端')
  })
})

describe('消息通道 · 频道模式：跟进', () => {
  let s: ReturnType<typeof setup>
  beforeEach(async () => {
    s = setup()
    await s.say('@小明 修页面')
    expect(s.memory().roots.map(r => r.id)).toEqual(['root1'])
  })

  it('审批带成员名和编号，同意走引擎；同一项只发一次', async () => {
    s.replace(task('t1', 'root1', { status: 'waiting', sessionId: 's1', request: approval('q1') }))
    await s.bridge.syncChannels()
    await s.bridge.syncChannels()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('"who":"小明"')
    expect(s.sent[0]).toContain('pnpm test')
    const n = JSON.parse(s.sent[0].split('\n')[0].replace('im.chat.approvalHeadWho:', '')).n as number
    await s.say(`同意 ${n}`)
    expect(s.engine.answer).toHaveBeenCalledWith('s1', 'q1', { type: 'allow' })
  })

  it('SSH 成员要确认：一句话，不给编号', async () => {
    s.replace(task('t1', 'root1', { assigneeId: 'zhou', status: 'waiting', sessionId: 's1', request: approval('q1') }))
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('im.chat.memberWaiting')
    await s.say('同意 1')
    expect(s.engine.answer).not.toHaveBeenCalled()
  })

  it('几个成员都结束才合并发一条；发完不再跟', async () => {
    s.replace(task('t1', 'root1', { status: 'done', summary: '修好了' }))
    s.replace(task('t2', 'root1', { assigneeId: 'hong' }))
    await s.bridge.syncChannels()
    expect(s.sent).toEqual([])
    s.replace(task('t2', 'root1', { assigneeId: 'hong', status: 'failed', error: '超时' }))
    await s.bridge.syncChannels()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('im.chat.resultSome')
    expect(s.sent[0]).toContain('小明：修好了')
    expect(s.sent[0]).toContain('小红：im.chat.lineFailed')
    expect(s.memory().roots).toEqual([])
    s.replace(task('t2', 'root1', { assigneeId: 'hong', status: 'done', summary: '重试好了' }))
    await s.bridge.syncChannels()
    expect(s.sent).toHaveLength(1)
  })

  it('别的成员还在做时失败的先说一句，同一轮不重复；收尾时合并结果里还有', async () => {
    s.replace(task('t1', 'root1', { status: 'failed', error: '额度不够', round: 1 }))
    s.replace(task('t2', 'root1', { assigneeId: 'hong' }))
    await s.bridge.syncChannels()
    await s.bridge.syncChannels()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('im.chat.taskFailed')
    expect(s.sent[0]).toContain('额度不够')
    s.replace(task('t2', 'root1', { assigneeId: 'hong', status: 'done', summary: '好了' }))
    await s.bridge.syncChannels()
    expect(s.sent).toHaveLength(2)
    expect(s.sent[1]).toContain('im.chat.resultSome')
  })

  it('只有一项活：发完整回复，不截断成摘要', async () => {
    const long = '结'.repeat(600)
    s.replace(task('t1', 'root1', { status: 'done', summary: '短摘要' }))
    s.replace({
      kind: 'message',
      id: 'r1',
      channelId: 'c1',
      at: 2,
      authorId: 'ming',
      text: long,
      format: 'markdown',
      taskId: 't1',
    })
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain(long)
    expect(s.sent[0]).not.toContain('短摘要')
  })

  it('电脑上派的活（没有 chat）不发回聊天', async () => {
    s.replace({
      ...task('t9', 'root1', { status: 'waiting', sessionId: 's9', request: approval('q9') }),
      chat: undefined,
    })
    await s.bridge.syncChannels()
    expect(s.sent).toEqual([])
  })

  it('接力被拦下发一句，同一跳不重复；根没收尾', async () => {
    s.replace(task('t1', 'root1', { status: 'done' }))
    s.replace(
      task('t2', 'root1', { assigneeId: 'qiang', status: 'queued', relay: { chain: 't1', hop: 1, held: 'chat' } }),
    )
    await s.bridge.syncChannels()
    await s.bridge.syncChannels()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('im.chat.heldChat')
    expect(s.memory().roots).toHaveLength(1)
  })

  it('两个成员都交给同一个放宽模式的成员：只说一次', async () => {
    s.replace(
      task('t2', 'root1', { assigneeId: 'qiang', status: 'queued', relay: { chain: 'a', hop: 1, held: 'chat' } }),
    )
    s.replace(
      task('t3', 'root1', { assigneeId: 'qiang', status: 'queued', relay: { chain: 'b', hop: 1, held: 'chat' } }),
    )
    await s.bridge.syncChannels()
    expect(s.sent.filter(x => x.includes('im.chat.heldChat'))).toHaveLength(1)
  })

  it('流程卡异步才建：只有根消息时不算收尾', async () => {
    s.replace({
      kind: 'message',
      id: 'root1',
      channelId: 'c1',
      at: 1,
      authorId: 'me',
      text: '@小明 修页面',
      format: 'plain',
      chat: chat('root1'),
    })
    await s.bridge.syncChannels()
    expect(s.sent).toEqual([])
    expect(s.memory().roots).toHaveLength(1)
  })

  it('/状态 只列聊天派的；/停止 只停聊天派的', async () => {
    s.replace(task('t1', 'root1', { status: 'waiting' }))
    s.replace(task('t2', 'root1', { assigneeId: 'hong', status: 'queued' }))
    s.replace({ ...task('t9', 'x', { status: 'running' }), chat: undefined })
    await s.say('/状态')
    const text = s.sent.at(-1)!
    expect(text).toContain('小明：活 t1（im.chat.stateWaiting）')
    expect(text).toContain('小红：活 t2（im.chat.stateQueued）')
    expect(text).not.toContain('t9')
    await s.say('/停止')
    expect(s.port.stopTask).toHaveBeenCalledWith('t1', 'stop')
    expect(s.port.stopTask).toHaveBeenCalledWith('t2', 'cancel')
    expect(s.port.stopTask).toHaveBeenCalledTimes(2)
  })
})

describe('消息通道 · 频道模式：审查修过的', () => {
  let s: ReturnType<typeof setup>
  const planner = { messageId: 'f1', stepId: '' }
  beforeEach(async () => {
    s = setup()
    await s.say('@小明 做一下')
  })

  it('问完问题后直接回答：发回答，不说计划已放弃', async () => {
    s.replace(task('p', 'root1', { status: 'done', summary: '答案是 42', flow: planner }))
    s.replace(flow('f1', 'root1', { questions: [{ q: '哪个？', options: [], answer: 'foo' }] }))
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('答案是 42')
    expect(s.sent[0]).not.toContain('im.chat.planDropped')
  })

  it('问题还没答就放弃：说计划已放弃', async () => {
    s.replace(task('p', 'root1', { status: 'done', summary: '先问一件事', flow: planner }))
    s.replace(flow('f1', 'root1', { status: 'stopped', questions: [{ q: '哪个？', options: [] }] }))
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('im.chat.planDropped')
  })

  it('放行后再接力给同一个成员又被拦：再说一次', async () => {
    const held = (id: string, hop: number) =>
      task(id, 'root1', { assigneeId: 'qiang', status: 'queued', relay: { chain: 'a', hop, held: 'chat' } })
    s.replace(held('t2', 1))
    await s.bridge.syncChannels()
    expect(s.sent).toHaveLength(1)
    s.replace({ ...held('t2', 1), status: 'done', relay: { chain: 'a', hop: 1, held: null } })
    s.replace(held('t3', 3))
    await s.bridge.syncChannels()
    expect(s.sent).toHaveLength(2)
    expect(s.sent[1]).toContain('im.chat.heldChat')
  })

  it('前一张还停着时又来一张交给同一个成员：不重复说', async () => {
    const held = (id: string) =>
      task(id, 'root1', { assigneeId: 'qiang', status: 'queued', relay: { chain: id, hop: 1, held: 'chat' } })
    s.replace(held('t2'))
    await s.bridge.syncChannels()
    s.replace(held('t3'))
    await s.bridge.syncChannels()
    expect(s.sent).toHaveLength(1)
  })

  it.each([
    [
      '流程停下',
      { status: 'paused', paused: { reason: 'failed', stepId: 'a' }, steps: [step('a', { status: 'failed' })] },
      'im.chat.stateFlowPaused',
    ],
    ['等人工确认', { status: 'running', steps: [step('a', { status: 'gated' }), step('b')] }, 'im.chat.stateWaiting'],
    [
      '等回答',
      { status: 'running', steps: [step('a', { status: 'asking', question: { text: '？', at: 5 } })] },
      'im.chat.stateAsking',
    ],
    [
      '两步之间',
      { status: 'running', steps: [step('a', { status: 'delivered' }), step('b')] },
      'im.chat.stateFlowRunning',
    ],
    ['拟计划中', { status: 'planning' }, 'im.chat.stateFlowRunning'],
  ] as const)('/状态：%s 不说都做完了', async (_name, patchFlow, expected) => {
    s.replace(flow('f1', 'root1', patchFlow as Partial<ChannelFlow>))
    await s.say('/状态')
    expect(s.sent.at(-1)).toContain(expected)
    expect(s.sent.at(-1)).not.toContain('im.chat.routeIdle')
  })

  it('接着商量时拟计划的成员失败：先说失败，再发原来的计划', async () => {
    s.replace(task('p', 'root1', { status: 'done', round: 1, flow: planner }))
    s.replace(flow('f1', 'root1', { planner: { memberId: 'ming', request: 'x', taskId: 'p' }, steps: [step('a')] }))
    await s.bridge.syncChannels()
    s.replace(task('p', 'root1', { status: 'failed', error: '额度不够', round: 2, flow: planner }))
    await s.bridge.syncChannels()
    expect(s.sent[1]).toContain('im.chat.taskFailed')
    expect(s.sent[1]).toContain('额度不够')
    expect(s.sent[2]).toContain('im.chat.planHead')
  })

  it('合并时回复被截断：「需要你决定」单独留一行；没截断不重复', async () => {
    const long = `${'过程'.repeat(200)}\n需要你决定：删不删旧表`
    s.replace(task('t1', 'root1', { status: 'done', decision: '删不删旧表' }))
    s.replace({
      kind: 'message',
      id: 'r1',
      channelId: 'c1',
      at: 2,
      authorId: 'ming',
      text: long,
      format: 'markdown',
      taskId: 't1',
    })
    s.replace(
      task('t2', 'root1', {
        assigneeId: 'hong',
        status: 'done',
        decision: '要不要发版',
        summary: '好了。需要你决定：要不要发版',
      }),
    )
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('im.chat.lineDecision:{"decision":"删不删旧表"}')
    expect(s.sent[0].match(/要不要发版/g)).toHaveLength(1)
  })

  it('只有一项活、回复很长：「需要你决定」提到前面，短回复不重复', async () => {
    const reply = (id: string, text: string): ChannelMessage => ({
      kind: 'message',
      id,
      channelId: 'c1',
      at: 2,
      authorId: 'ming',
      text,
      format: 'markdown',
      taskId: 't1',
    })
    s.replace(task('t1', 'root1', { status: 'done', decision: '删不删旧表' }))
    s.replace(reply('r1', `${'过程'.repeat(2000)}\n需要你决定：删不删旧表`))
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('im.chat.lineDecision')

    const b = setup()
    await b.say('@小明 做一下')
    b.replace(task('t1', 'root1', { status: 'done', decision: '删不删旧表' }))
    b.replace(reply('r1', '好了\n需要你决定：删不删旧表'))
    await b.bridge.syncChannels()
    expect(b.sent[0]).not.toContain('im.chat.lineDecision')
  })

  it('流程中途停了、后面的步骤没开始：不说都做完了，只做完一项也一样', async () => {
    s.replace(task('t1', 'root1', { status: 'done', summary: '一好了', flow: { messageId: 'f1', stepId: 'a' } }))
    s.replace(
      flow('f1', 'root1', { status: 'stopped', steps: [step('a', { taskId: 't1', status: 'delivered' }), step('b')] }),
    )
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('im.chat.resultStopped')
    expect(s.sent[0]).toContain('"n":2')
    expect(s.sent[0]).toContain('"done":1')
    expect(s.sent[0]).toContain('小明：一好了')
  })

  it('流程走完：还是都做完了', async () => {
    s.replace(task('t1', 'root1', { status: 'done', summary: '一好了', flow: { messageId: 'f1', stepId: 'a' } }))
    s.replace(task('t2', 'root1', { status: 'done', summary: '二好了', flow: { messageId: 'f1', stepId: 'b' } }))
    s.replace(
      flow('f1', 'root1', { status: 'done', steps: [step('a', { taskId: 't1' }), step('b', { taskId: 't2' })] }),
    )
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('im.chat.resultAll')
  })

  it('没人接：只列能派的成员；一个都没有时换一句', async () => {
    s.box.root = null
    await s.say('大家看一下')
    expect(s.sent.at(-1)).toContain('@小明')
    expect(s.sent.at(-1)).not.toContain('阿强')
    s.port.info = () => ({ name: '前端', members: [{ name: '阿强', allowed: false, local: true }] })
    await s.say('大家再看一下')
    expect(s.sent.at(-1)).toContain('im.chat.unroutedNone')
  })
})

describe('消息通道 · 频道模式：计划和问题', () => {
  let s: ReturnType<typeof setup>
  const numberIn = (text: string) => Number(/"n":(\d+)/.exec(text)![1])
  beforeEach(async () => {
    s = setup()
    await s.say('把登录页重构一下')
  })

  it('计划发到聊天，同意开工、拒绝放弃', async () => {
    s.replace(flow('f1', 'root1', { steps: [step('a'), step('b', { memberId: 'hong' })] }))
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('im.chat.planHead')
    expect(s.sent[0]).toContain('1. 步骤 a · 小明')
    expect(s.sent[0]).toContain('2. 步骤 b · 小红')
    await s.say(`同意 ${numberIn(s.sent[0])}`)
    expect(s.port.flow).toHaveBeenCalledWith('c1', { type: 'start', messageId: 'f1' })
  })

  it('电脑上改过计划：旧编号作废，发新的；不会开工没看过的计划', async () => {
    s.replace(flow('f1', 'root1', { steps: [step('a')] }))
    await s.bridge.syncChannels()
    const old = numberIn(s.sent[0])
    s.replace(flow('f1', 'root1', { steps: [step('a'), step('c')] }))
    await s.say(`同意 ${old}`)
    expect(s.port.flow).not.toHaveBeenCalled()
    expect(s.sent.some(x => x.includes('im.chat.expired'))).toBe(true)
    expect(s.sent.filter(x => x.includes('im.chat.planHead'))).toHaveLength(2)
  })

  it('步骤里有放宽模式的成员：写明，同意被拦下', async () => {
    s.replace(flow('f1', 'root1', { steps: [step('a', { memberId: 'qiang' })] }))
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('im.chat.planBlockedHow')
    await s.say(`同意 ${numberIn(s.sent[0])}`)
    expect(s.port.flow).not.toHaveBeenCalled()
    expect(s.sent.at(-1)).toContain('im.chat.planBlocked')
    await s.say(`拒绝 ${numberIn(s.sent[0])}`)
    expect(s.port.flow).toHaveBeenCalledWith('c1', { type: 'discard', messageId: 'f1' })
  })

  it('放弃后说一句已放弃，不把拟计划的回复当结果发', async () => {
    s.replace(task('p', 'root1', { status: 'done', summary: '计划如下', flow: { messageId: 'f1', stepId: '' } }))
    s.replace(flow('f1', 'root1', { status: 'stopped', steps: [step('a')] }))
    await s.bridge.syncChannels()
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]).toContain('im.chat.planDropped')
  })

  it('成员直接回答（流程停了、没有步骤）：回答发回聊天', async () => {
    s.replace(task('p', 'root1', { status: 'done', summary: '答案是 42', flow: { messageId: 'f1', stepId: '' } }))
    s.replace(flow('f1', 'root1', { status: 'stopped' }))
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('答案是 42')
  })

  it('拟计划失败（空草稿）算收尾，报失败', async () => {
    s.replace(task('p', 'root1', { status: 'failed', error: '额度不够', flow: { messageId: 'f1', stepId: '' } }))
    s.replace(flow('f1', 'root1'))
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('im.chat.lineFailed')
    expect(s.memory().roots).toEqual([])
  })

  it('拟计划的成员问问题：序号换成选项文字', async () => {
    s.replace(flow('f1', 'root1', { questions: [{ q: '放哪？', options: ['组件旁', 'tests 目录'] }] }))
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('1. 组件旁')
    await s.say(`回答 ${numberIn(s.sent[0])} 2`)
    expect(s.port.flow).toHaveBeenCalledWith('c1', { type: 'answers', messageId: 'f1', answers: ['tests 目录'] })
  })

  it('一步问你问题：整句话作为回答', async () => {
    s.replace(
      flow('f1', 'root1', {
        status: 'running',
        steps: [step('a', { status: 'asking', question: { text: '用哪个库？', at: 5 } })],
      }),
    )
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('用哪个库？')
    await s.say(`回答 ${numberIn(s.sent[0])} 用 zod 吧`)
    expect(s.port.flow).toHaveBeenCalledWith('c1', { type: 'answer', messageId: 'f1', stepId: 'a', text: '用 zod 吧' })
  })

  it('流程停下、到上限各说一句', async () => {
    s.replace(
      flow('f1', 'root1', {
        status: 'paused',
        paused: { reason: 'limit', stepId: 'a', limit: 'rounds' },
        steps: [step('a')],
      }),
    )
    await s.bridge.syncChannels()
    expect(s.sent[0]).toContain('im.chat.flowLimit')
  })

  it('解除绑定后不再发，也不给下一个绑定的人', async () => {
    s.bridge.unbind()
    s.replace(flow('f1', 'root1', { steps: [step('a')] }))
    await s.bridge.syncChannels()
    expect(s.sent).toEqual([])
    expect(s.memory().roots).toEqual([])
    expect(s.memory().asks).toEqual({})
  })
})

describe('pickAnswers', () => {
  const one = [{ q: 'a', options: ['x', 'y'] }]
  const two = [
    { q: 'a', options: ['x', 'y'] },
    { q: 'b', options: [] },
  ]
  it('一个问题：序号或整句', () => {
    expect(pickAnswers(one, '2')).toEqual(['y'])
    expect(pickAnswers(one, '都不要，换一个')).toEqual(['都不要，换一个'])
    expect(pickAnswers(one, '9')).toEqual(['9'])
  })
  it('几个问题：数量对不上返回 null', () => {
    expect(pickAnswers(two, '1 好的')).toEqual(['x', '好的'])
    expect(pickAnswers(two, '1')).toBeNull()
  })
  it('几个问题：最后一个可以带空格、逗号；一行一个时哪个都可以', () => {
    expect(pickAnswers(two, '1 散热不够，机柜太挤')).toEqual(['x', '散热不够，机柜太挤'])
    expect(pickAnswers(two, '2，散热 不够')).toEqual(['y', '散热 不够'])
    const free = [
      { q: 'a', options: [] },
      { q: 'b', options: ['x', 'y'] },
    ]
    expect(pickAnswers(free, '机柜 太挤\n2')).toEqual(['机柜 太挤', 'y'])
  })
  it('几个问题：最后一个有选项时多出来的不算，免得错位', () => {
    const free = [
      { q: 'a', options: [] },
      { q: 'b', options: ['x', 'y'] },
    ]
    expect(pickAnswers(free, '机柜 太挤 2')).toBeNull()
    expect(
      pickAnswers(
        [
          { q: 'a', options: ['x'] },
          { q: 'b', options: ['y'] },
        ],
        '1 1',
      ),
    ).toEqual(['x', 'y'])
  })
})
