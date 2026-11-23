import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EngineHost } from '../src'
import type { HostEvent, SessionRecord } from '@pixelsky/protocol'
import { OmpAdapter } from '../src/omp'
import { ompAgentFile, ompRunsFromSession } from '../src/omp/agents'
import { OMP_MIN_VERSION, ompVersionOf, ompVersionStatus } from '../src/omp/discover'
import { OMP_GATEWAY_SOURCE } from '../src/omp/gateway-ext'
import { ompApproval, ompLaunch, ompTuiArgs, reservedOmpArg } from '../src/omp/launch'
import { OMP_PLAN_ALLOW, OMP_PLAN_SOURCE } from '../src/omp/plan-ext'
import { PLAN_OPTIONS, PLAN_TITLE } from '../src/pixel/translate'
import { btwOutcome } from '../src/omp/btw'
import { ChunkAssembler } from '../src/pixel/process'
import { ompOverlayText } from '../src/omp/overlay'
import { freshSessionId } from '../src/omp/side'
import { OMP_FAST_STUCK, OMP_SESSION_MOVED, ompRestarts } from '../src/pixel/session'
import { isApprovalSelect, isOmpApprovalOptions, toolItem } from '../src/pixel/translate'
import { makeTmp, removeTmp } from './helpers/tmp'

const FAKE = fileURLToPath(new URL('./fakes/fake-omp.mjs', import.meta.url))
let root: string, host: EngineHost | undefined
beforeEach(() => {
  root = makeTmp('omp-test')
})
afterEach(async () => {
  await host?.shutdown()
  host = undefined
  removeTmp(root)
})
const wait = async (fn: () => boolean): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('omp test timed out')
}
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (/^(ANTHROPIC|OPENAI)_/i.test(key) || /^PIXELSKY_PIXEL_/i.test(key)) delete env[key]
  return env
}
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []
function setup(permissionMode: 'ask' | 'edits' | 'full' | 'plan' = 'ask', extraEnv: Record<string, string> = {}) {
  const log = join(root, 'rpc.jsonl'),
    argv = join(root, 'argv.jsonl'),
    events: HostEvent[] = []
  const adapter = new OmpAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    env: { ...cleanEnv(), FAKE_OMP_LOG: log, FAKE_OMP_ARGV: argv, FAKE_OMP_DIR: join(root, 'sessions'), ...extraEnv },
    dataDir: join(root, 'engine'),
  })
  host = new EngineHost({
    dataDir: join(root, 'engine'),
    adapters: { omp: adapter },
    emit: e => events.push(e),
    idleMs: 10_000,
  })
  const session = host.createSession({
    projectId: host.addProject(root).id,
    engine: 'omp',
    model: 'fake/fake-omp',
    effort: 'high',
    permissionMode,
  })
  const mark = (m: { message?: unknown }) => String(m.message ?? '').startsWith('/pixelsky-turn')
  return {
    session,
    events,
    // 轮次标记（omp/turn-ext.ts）每轮都有，另给
    messages: () => lines(log).filter(m => !mark(m)),
    marks: () => lines(log).filter(m => m.type === 'prompt' && mark(m)),
    argvs: () => lines(argv),
  }
}
const snap = (id: string) => host!.open(id)
const idle = (id: string) => snap(id).state === 'idle'

describe('oh-my-pi 适配器', () => {
  it('先协商第 2 版协议、用 get_available_commands；一轮以 prompt_result 结束，--approval-mode 按权限档', async () => {
    const { session, messages, argvs } = setup()
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id))
    const types = messages().map(m => m.type)
    expect(types[0]).toBe('negotiate_protocol')
    expect(types).toContain('get_available_commands')
    expect(types).not.toContain('get_commands')
    expect(argvs()[0].argv).toEqual(expect.arrayContaining(['--mode', 'rpc', '--approval-mode', 'always-ask']))
    // 没走网关：只加载计划扩展（滤掉历史里的计划说明）和记轮次位置的，不加载网关扩展
    const extensions = argvs()[0].argv.flatMap((a: string, i: number, all: string[]) =>
      a === '-e' ? [all[i + 1]] : [],
    )
    expect(extensions.map((e: string) => basename(e))).toEqual(['pixelsky-plan.mjs', 'pixelsky-turn.mjs'])
    const items = snap(session.id).items
    expect(items.some(i => i.kind === 'assistant' && i.text === '好的')).toBe(true)
    expect(snap(session.id).record.engineSessionId).toMatch(/omp-\d+\.jsonl$/)
  })

  it('确认卡片：认出 omp 的英文三选一，按它的选项原文回', async () => {
    const { session, messages } = setup()
    const answers: string[] = []
    for (const decision of [{ type: 'allow_always', scope: 'session' }, { type: 'allow' }, { type: 'deny' }] as const) {
      await host!.send(session.id, '工具')
      await wait(() => snap(session.id).pending.length === 1)
      expect(snap(session.id).pending[0]).toMatchObject({
        kind: 'command',
        command: 'echo hi',
        alwaysScopes: ['session'],
      })
      host!.answer(session.id, snap(session.id).pending[0].requestId, decision)
      await wait(() => snap(session.id).pending.length === 0 && idle(session.id))
      answers.push(
        messages()
          .filter(m => m.type === 'extension_ui_response')
          .pop().value,
      )
    }
    expect(answers).toEqual(['Approve bash for this session', 'Approve', 'Deny'])
  })

  it('停止：prompt_result aborted 按中断结束；status error 按失败结束并带原因', async () => {
    const { session, events, messages } = setup()
    await host!.send(session.id, '慢')
    await wait(() => messages().some(m => m.type === 'prompt'))
    await host!.interrupt(session.id)
    expect(idle(session.id)).toBe(true)
    expect(messages().some(m => m.type === 'abort')).toBe(true)
    const completed = () =>
      events.flatMap(e => (e.kind === 'session' && e.event.type === 'turn_completed' ? [e.event] : []))
    expect(completed()[0]).toMatchObject({ outcome: 'interrupted' })
    host!.resumeQueue(session.id)
    await host!.send(session.id, '坏')
    await wait(() => completed().length === 2)
    expect(completed()[1]).toMatchObject({ outcome: 'failed', error: 'boom from omp' })
  })

  // 正文超长会被截短（docs/engine-output-limits.md），这里只看拼回来的那条到了、这一轮正常结束
  it('超过 1 MiB 的消息按 rpc_chunk 拼回来', async () => {
    const { session } = setup()
    await host!.send(session.id, '大')
    await wait(() => idle(session.id))
    const reply = snap(session.id).items.find(i => i.kind === 'assistant')
    expect(reply && reply.kind === 'assistant' ? reply.text.length : 0).toBeGreaterThan(500_000)
  })

  it('本地做完的斜杠命令（agentInvoked: false）直接结束这一轮', async () => {
    const { session, messages } = setup()
    await host!.send(session.id, '/security status')
    await wait(() => idle(session.id))
    expect(
      messages()
        .filter(m => m.type === 'prompt')
        .pop().message,
    ).toBe('/security status')
  })

  // 用户自己的 omp 配置（tier.openai: priority）或会话文件里记的 /fast 会让请求悄悄按 Fast 档发，平台加价扣费（docs/omp-engine.md §11）
  it('Fast 档：打开进程后关掉再发；换模型后再关一次', async () => {
    const { session, messages } = setup('ask', { FAKE_OMP_FAST: '1', FAKE_OMP_FAST_ON_SWITCH: '1' })
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id))
    const tiers = () => messages().filter(m => m.type === 'tier')
    expect(tiers()).toEqual([{ type: 'tier', fast: false }])
    const types = messages().map(m => m.type)
    expect(types.indexOf('set_fast_mode')).toBeGreaterThan(types.indexOf('set_model'))
    // 换到另一个模型：omp 按模型家族记档位，又回到 Fast，要再关一次
    await host!.update(session.id, { model: 'fake/fake-omp-2' })
    await host!.send(session.id, '再来')
    await wait(() => idle(session.id) && tiers().length === 2)
    expect(tiers()[1]).toEqual({ type: 'tier', fast: false })
  })

  it('Fast 开关：开了按 Fast 发、每轮发送前套用；换到开不了的模型就关掉、记录改成关、提示原因', async () => {
    const { session, messages, events } = setup('ask', { FAKE_OMP_FAST_NO: 'fake-omp-2' })
    const tiers = () =>
      messages()
        .filter(m => m.type === 'tier')
        .map(m => m.fast)
    await host!.update(session.id, { fast: true })
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id) && tiers().length === 1)
    expect(tiers()).toEqual([true])
    expect(snap(session.id).flags).toMatchObject({ fastAvailable: true, fastState: 'on', fastBlocked: 'omp_fast_cost' })
    // 轮间关掉：下一轮按关发
    await host!.update(session.id, { fast: false })
    await host!.send(session.id, '再来')
    await wait(() => idle(session.id) && tiers().length === 2)
    expect(tiers()[1]).toBe(false)
    await host!.update(session.id, { fast: true, model: 'fake/fake-omp-2' })
    await host!.send(session.id, '第三条')
    await wait(() => idle(session.id) && tiers().length === 3)
    expect(tiers()[2]).toBe(false)
    expect(snap(session.id).record.fast).toBe(false)
    expect(snap(session.id).flags).toMatchObject({ fastAvailable: false, fastBlocked: 'omp_fast_unavailable' })
    const notices = events.flatMap(e =>
      e.kind === 'session' && e.event.type === 'item_completed' && e.event.item.kind === 'notice'
        ? [e.event.item.text]
        : [],
    )
    expect(notices).toContain('oh-my-pi 的这个模型不支持 Fast，已关闭')
  })

  it('Fast 档关不掉：这一轮不发，报原因', async () => {
    const { session, events, messages } = setup('ask', { FAKE_OMP_FAST: '1', FAKE_OMP_FAST_STUCK: '1' })
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id))
    const done = events.flatMap(e => (e.kind === 'session' && e.event.type === 'turn_completed' ? [e.event] : []))
    expect(done[0]).toMatchObject({ outcome: 'failed', error: OMP_FAST_STUCK })
    expect(messages().some(m => m.type === 'prompt')).toBe(false)
  })

  it('换权限档：这一轮结束后换进程，新进程带新的 --approval-mode 并续接同一个会话文件', async () => {
    const { session, messages, argvs } = setup()
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id))
    const file = snap(session.id).record.engineSessionId
    await host!.update(session.id, { permissionMode: 'full' })
    await host!.send(session.id, '再来')
    await wait(() => idle(session.id) && argvs().length === 2)
    expect(argvs()[1].argv).toEqual(expect.arrayContaining(['--approval-mode', 'yolo']))
    expect(
      messages()
        .filter(m => m.type === 'switch_session')
        .pop(),
    ).toMatchObject({ sessionPath: file })
  })
  it('显示思考、Ultracode：启动带 --config 叠加设置；会话里改了等这一轮结束换进程、续接同一会话', async () => {
    const { session, argvs, messages } = setup()
    const config = () => {
      const arg = argvs()
        .at(-1)
        .argv.find((a: string) => a.startsWith('--config='))
      return readFileSync(arg.slice('--config='.length), 'utf8')
    }
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id) && !!snap(session.id).record.engineSessionId)
    const file = snap(session.id).record.engineSessionId
    expect(config()).toBe('omitThinking: false\n')
    expect(snap(session.id).flags.ultracodeAvailable).toBe(true)
    await host!.update(session.id, { ultracode: true, thinkingSummaries: false })
    await host!.send(session.id, '再来')
    await wait(() => idle(session.id) && argvs().length === 2)
    expect(config()).toBe('omitThinking: true\ntask:\n  eager: always\n  maxConcurrency: 8\n')
    expect(
      messages()
        .filter(m => m.type === 'switch_session')
        .at(-1),
    ).toMatchObject({ sessionPath: file })
  })
  it('会话文件中途换了：记录跟着换，提示一次；换权限档重启进程接的是新文件', async () => {
    const { session, messages, argvs } = setup()
    await host!.send(session.id, '占用')
    await wait(() => idle(session.id))
    const moved = /moved-\d+\.jsonl$/
    await wait(() => moved.test(snap(session.id).record.engineSessionId ?? ''))
    const file = snap(session.id).record.engineSessionId
    const notices = snap(session.id).items.filter(i => i.kind === 'notice' && i.text === OMP_SESSION_MOVED)
    expect(notices).toHaveLength(1)
    await host!.send(session.id, '慢')
    await wait(() => messages().filter(m => m.type === 'prompt').length === 2)
    await host!.update(session.id, { permissionMode: 'edits' })
    await host!.interrupt(session.id)
    await wait(() => idle(session.id))
    host!.resumeQueue(session.id)
    await host!.send(session.id, '再来')
    await wait(() => idle(session.id) && argvs().length === 2)
    expect(
      messages()
        .filter(m => m.type === 'switch_session')
        .at(-1),
    ).toMatchObject({ sessionPath: file })
  })
  it('会话文件没有通知就换了：这一轮结束时记录也跟着换', async () => {
    const { session } = setup()
    await host!.send(session.id, '悄悄换')
    await wait(() => /new-\d+\.jsonl$/.test(snap(session.id).record.engineSessionId ?? ''))
  })
  it('换权限档的那一轮里文件悄悄换了：新进程接新文件', async () => {
    const { session, messages, argvs } = setup()
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id))
    void host!.send(session.id, '悄悄换')
    await wait(() => messages().filter(m => m.type === 'prompt').length === 2)
    await host!.update(session.id, { permissionMode: 'edits' })
    await wait(() => idle(session.id))
    await host!.send(session.id, '再来')
    await wait(() => idle(session.id) && argvs().length === 2)
    expect(
      messages()
        .filter(m => m.type === 'switch_session')
        .at(-1).sessionPath,
    ).toMatch(/new-\d+\.jsonl$/)
  })
  it('子智能体：omp 的 task 一次派几个，各自一项（进度、结果、失败原因），挂在 task 条目上', async () => {
    const { session } = setup()
    await host!.send(session.id, '派活')
    await wait(() => idle(session.id))
    const agents = snap(session.id).runs.agents
    expect(agents.map(a => [a.id, a.label, a.state])).toEqual([
      ['0-a', 'a', 'completed'],
      ['1-b', 'b', 'failed'],
    ])
    expect(agents[0]).toMatchObject({
      result: 'A 的结果',
      tokens: 80,
      model: 'fake/fake-omp',
      toolUseId: 'px-task-call-task',
    })
    expect(agents[1].result).toBe('B 失败了')
    expect(snap(session.id).items.some(i => i.id === 'px-task-call-task')).toBe(true)
  })
  it('子智能体在后台跑：条目等它们结束才收尾；点开看对话；用量算进这一轮；重开应用读回', async () => {
    const { session, events } = setup()
    await host!.send(session.id, '后台分')
    await wait(() => idle(session.id))
    const task = () => snap(session.id).items.find(i => i.kind === 'tool' && i.tool === 'task')
    const seen = events.flatMap(e =>
      e.kind === 'session' &&
      (e.event.type === 'item_started' || e.event.type === 'item_completed') &&
      e.event.item.kind === 'tool'
        ? [e.event.item.status]
        : [],
    )
    expect(seen).toEqual(['running', 'running', 'completed'])
    expect(task()).toMatchObject({ status: 'completed', title: 'Alpha、Beta' })
    expect(snap(session.id).runs.agents.map(a => [a.id, a.label, a.state])).toEqual([
      ['Alpha', 'Alpha', 'completed'],
      ['Beta', 'Beta', 'completed'],
    ])
    // 统计里没有子智能体的：从它们的会话文件加，各算一次
    expect(snap(session.id).usage).toMatchObject({ inputTokens: 200, outputTokens: 20, costUsd: 1 })
    const turn = events.flatMap(e => (e.kind === 'session' && e.event.type === 'turn_completed' ? [e.event] : []))[0]
    expect(turn.usage?.models['fake-omp']).toMatchObject({ input: 200, output: 20, requests: 2 })
    const items = await host!.subagentTranscript(session.id, 'Alpha')
    expect(items.map(i => i.kind)).toEqual(['user', 'tool', 'assistant'])
    expect(items[0]).toMatchObject({ text: '查 Alpha' })
    expect(() => host!.subagentTranscript(session.id, '../omp')).toThrow('子智能体不属于当前会话')
    const record = snap(session.id).record
    const adapter = new OmpAdapter({ launcher: { command: process.execPath, args: [FAKE] }, env: cleanEnv() })
    expect(adapter.loadRuns(record).agents).toMatchObject([
      { id: 'Alpha', state: 'completed', result: 'Alpha 的结果', durationMs: 1400, tokens: 110, toolCalls: 1 },
      { id: 'Beta', state: 'completed', toolUseId: (task() as { id: string }).id, prompt: '查 Beta' },
    ])
    // 换进程续接：用量接着算，不重复
    await host!.update(session.id, { permissionMode: 'edits' })
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id) && snap(session.id).items.filter(i => i.kind === 'user').length === 2)
    expect(snap(session.id).usage).toMatchObject({ inputTokens: 200, outputTokens: 20, costUsd: 1 })
  })
  it('停掉主智能体：子智能体在后台跑完时卡片跟着更新，用量进会话累计、不改已结束的那一轮；被停的读回是已停止', async () => {
    const { session, events, messages } = setup()
    await host!.send(session.id, '后台分，停，取消')
    await wait(() => messages().some(m => m.type === 'prompt') && snap(session.id).runs.agents.length === 2)
    await host!.interrupt(session.id)
    expect(snap(session.id).runs.agents.map(a => a.state)).toEqual(['running', 'running'])
    expect(snap(session.id).items.find(i => i.kind === 'tool')).toMatchObject({ status: 'interrupted' })
    await wait(() => snap(session.id).runs.agents.every(a => a.state !== 'running'))
    expect(snap(session.id).runs.agents.map(a => a.state)).toEqual(['completed', 'stopped'])
    expect(snap(session.id).items.find(i => i.kind === 'tool')).toMatchObject({ status: 'completed' })
    await wait(() => snap(session.id).usage?.inputTokens === 200)
    const turn = events.flatMap(e => (e.kind === 'session' && e.event.type === 'turn_completed' ? [e.event] : []))[0]
    expect(turn.usage?.models).toEqual({})
    const adapter = new OmpAdapter({ launcher: { command: process.execPath, args: [FAKE] }, env: cleanEnv() })
    const runs = () => adapter.loadRuns(snap(session.id).record).agents
    await wait(() => runs().length === 2)
    expect(runs().map(a => [a.state, a.result])).toEqual([
      ['completed', 'Alpha 的结果'],
      ['stopped', '停了'],
    ])
  })
  it('停主智能体连同子智能体：先停主轮再逐个停，排队的补上来也停；这一轮记中断、合成一条提示', async () => {
    const { session, messages } = setup()
    void host!.send(session.id, '并发')
    await wait(() => snap(session.id).subagents.length === 1)
    expect(snap(session.id).subagents[0]).toMatchObject({ id: 'Alpha', background: true })
    expect(snap(session.id).background).toBe(2)
    await host!.interrupt(session.id, { background: true })
    expect(snap(session.id).runs.agents.map(a => [a.id, a.state])).toEqual([
      ['Alpha', 'stopped'],
      ['Beta', 'stopped'],
    ])
    expect(snap(session.id).background).toBe(0)
    expect(idle(session.id)).toBe(true)
    const items = snap(session.id).items
    expect(items.find(i => i.kind === 'turn_stats')).toMatchObject({ outcome: 'interrupted' })
    expect(items.find(i => i.kind === 'tool')).toMatchObject({ status: 'interrupted' })
    expect(items.filter(i => i.kind === 'notice').map(i => i.kind === 'notice' && i.text)).toEqual([
      '已停止，连同 2 个后台子智能体（Alpha、Beta）',
    ])
    const sent = messages().map(m => m.type)
    expect(sent.indexOf('abort')).toBeLessThan(sent.indexOf('cancel_subagent'))
  })
  it('只停主智能体：子智能体接着跑；单独停一个；已经结束的再停不报错；停不掉报原因', async () => {
    const { session, messages } = setup()
    void host!.send(session.id, '并发')
    await wait(() => snap(session.id).subagents.length === 1)
    await host!.interrupt(session.id)
    expect(messages().some(m => m.type === 'cancel_subagent')).toBe(false)
    expect(snap(session.id).background).toBe(2)
    // 排队的停不了（真 omp 只认在跑的）
    await expect(host!.stopTask(session.id, 'Beta')).rejects.toThrow('这个子智能体没有停下来')
    await host!.stopTask(session.id, 'Alpha')
    await wait(() => snap(session.id).subagents[0]?.id === 'Beta')
    await host!.stopTask(session.id, 'Beta')
    await wait(() => snap(session.id).background === 0)
    await host!.stopTask(session.id, 'Alpha')
  })
  it('子智能体停不掉：到时间结束进程，记成已停止，下一条消息再起', async () => {
    const { session, argvs } = setup('ask', { FAKE_OMP_STUCK_AGENTS: '1' })
    void host!.send(session.id, '并发')
    await wait(() => snap(session.id).subagents.length === 1)
    await host!.interrupt(session.id, { background: true })
    await wait(() => snap(session.id).background === 0)
    expect(snap(session.id).runs.agents.map(a => a.state)).toEqual(['stopped', 'stopped'])
    host!.resumeQueue(session.id)
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id) && argvs().length === 2)
  }, 15_000)
  it('终端模式：新对话要先发一条消息；有会话文件后起 omp 自己的界面，带 --resume 和同一套启动参数', async () => {
    const { session } = setup('edits')
    expect(host!.tuiBlock(session.id)).toBe('freshOmp')
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id) && !!snap(session.id).record.engineSessionId)
    const record = snap(session.id).record
    const adapter = new OmpAdapter({
      launcher: { command: process.execPath, args: [FAKE] },
      env: cleanEnv(),
      dataDir: join(root, 'engine'),
    })
    const launch = await adapter.tuiLaunch(record)
    expect(launch.args).toEqual(
      expect.arrayContaining(['--approval-mode', 'write', `--resume=${record.engineSessionId}`, '--service-tier=none']),
    )
    expect(launch.engineSessionId).toBe(record.engineSessionId)
    await expect(adapter.tuiLaunch({ ...record, engineSessionId: join(root, 'nope.jsonl') })).rejects.toThrow(
      'oh-my-pi 要先在界面里发一条消息，才能切到终端',
    )
  })
  it('计划模式：启动加载计划扩展；计划卡先到、条目后到也挂上；继续完善留在计划，开始执行回到原来的档、不换进程', async () => {
    const { session, messages, argvs } = setup()
    await host!.update(session.id, { permissionMode: 'plan' })
    await host!.send(session.id, '交计划')
    await wait(() => snap(session.id).pending.length === 1 && !!snap(session.id).pending[0].itemId)
    const argv = argvs().at(-1).argv as string[]
    expect(argv[argv.indexOf('--approval-mode') + 1]).toBe('always-ask')
    expect(argv.some(a => a.endsWith('pixelsky-plan.mjs'))).toBe(true)
    expect(argvs().at(-1).plan).toBe('1')
    const request = snap(session.id).pending[0]
    expect(request).toMatchObject({ kind: 'plan', plan: '# 计划\n1. 改 a' })
    expect(snap(session.id).items.find(i => i.id === request.itemId)).toMatchObject({ name: 'ExitPlanMode' })
    host!.answer(session.id, request.requestId, { type: 'deny' })
    await wait(() => idle(session.id))
    expect(
      messages()
        .filter(m => m.type === 'extension_ui_response')
        .pop(),
    ).toMatchObject({
      value: '继续完善计划 / Keep planning',
    })
    expect(host!.record(session.id)?.permissionMode).toBe('plan')
    await host!.send(session.id, '交计划')
    await wait(() => snap(session.id).pending.length === 1)
    host!.answer(session.id, snap(session.id).pending[0].requestId, { type: 'allow' })
    await wait(() => idle(session.id) && host!.record(session.id)?.permissionMode === 'ask')
    expect(host!.record(session.id)?.planReturn ?? null).toBeNull()
    // 进程本来就是「每次都问」：不用换
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id) && snap(session.id).items.filter(i => i.kind === 'user').length === 3)
    expect(argvs()).toHaveLength(1)
  })
  it('完全放行时先出计划：计划阶段最多自动改文件（不靠 yolo 兜底）；批准后回到完全放行，这一轮做完换进程', async () => {
    const { session, argvs } = setup('full')
    await host!.update(session.id, { permissionMode: 'plan' })
    expect(host!.record(session.id)?.planReturn).toBe('full')
    await host!.send(session.id, '交计划')
    await wait(() => snap(session.id).pending.length === 1)
    const first = argvs().at(-1).argv as string[]
    expect(first[first.indexOf('--approval-mode') + 1]).toBe('write')
    host!.answer(session.id, snap(session.id).pending[0].requestId, { type: 'allow' })
    await wait(() => idle(session.id) && host!.record(session.id)?.permissionMode === 'full')
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id) && argvs().length === 2)
    const next = argvs().at(-1).argv as string[]
    expect(next[next.indexOf('--approval-mode') + 1]).toBe('yolo')
    // 扩展照样加载（滤掉历史里的计划说明），但不在计划档
    expect(next.some(a => a.endsWith('pixelsky-plan.mjs'))).toBe(true)
    expect(argvs().at(-1).plan).toBeNull()
  })
  it('Ultracode：没有 task 工具时不能开，开着的关掉并提示', async () => {
    const { session, events } = setup('ask', { FAKE_OMP_NO_TASK: '1' })
    await host!.update(session.id, { ultracode: true })
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id))
    expect(snap(session.id).flags.ultracodeAvailable).toBe(false)
    expect(snap(session.id).record.ultracode).toBe(false)
    const notices = events.flatMap(e =>
      e.kind === 'session' && e.event.type === 'item_completed' && e.event.item.kind === 'notice'
        ? [e.event.item.text]
        : [],
    )
    expect(notices).toContain('oh-my-pi 没有 task 工具（启动参数关掉了），Ultracode 已关闭')
  })
  it('旁聊：会话进程在就直接用 btw 问（不另起进程），用量补进累计；出错、停止报原因', async () => {
    const { session, argvs, messages } = setup()
    await expect(host!.sideQuestion(session.id, '先问', [])).rejects.toThrow('先在主对话里发一条消息')
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id) && !!snap(session.id).record.engineSessionId)
    const spawned = argvs().length
    const answer = await host!.sideQuestion(session.id, '这个项目用什么语言', [])
    expect(answer).toMatch(/^旁聊回答：\d+，fake\/fake-omp，问：[\s\S]*这个项目用什么语言$/)
    expect(argvs()).toHaveLength(spawned)
    const btw = messages().filter(m => m.type === 'btw')
    expect(btw).toHaveLength(1)
    expect(btw[0].question).toContain('这个项目用什么语言')
    // 假 omp 每次 btw 在统计里记 100 输入
    expect(snap(session.id).usage?.inputTokens).toBe(100)
    await expect(host!.sideQuestion(session.id, '旁聊失败', [])).rejects.toThrow('btw boom')
    const slow = host!.sideQuestion(session.id, '旁聊慢', [])
    await wait(() => messages().filter(m => m.type === 'btw').length === 3)
    host!.cancelSideQuestion(session.id)
    await expect(slow).rejects.toThrow('已停止')
    await wait(() => messages().some(m => m.type === 'btw_cancel'))
    // 主轮照常
    await host!.send(session.id, '再来')
    await wait(() => idle(session.id) && snap(session.id).items.filter(i => i.kind === 'user').length === 2)
  })
  it('旁聊：这次还没起过会话进程时，复制会话文件起临时进程问，原文件不变、副本删掉；Fast 关不掉就不问', async () => {
    const { session, argvs, messages } = setup()
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id) && !!snap(session.id).record.engineSessionId)
    const record = snap(session.id).record
    const before = readFileSync(record.engineSessionId!, 'utf8')
    const fresh = (extra: Record<string, string> = {}) =>
      new OmpAdapter({
        launcher: { command: process.execPath, args: [FAKE] },
        env: {
          ...cleanEnv(),
          FAKE_OMP_LOG: join(root, 'rpc.jsonl'),
          FAKE_OMP_ARGV: join(root, 'argv.jsonl'),
          FAKE_OMP_DIR: join(root, 'sessions'),
          FAKE_OMP_FAST: '1',
          ...extra,
        },
        dataDir: join(root, 'engine'),
      })
    const answer = await fresh().sideQuestion(record, '问一下', new AbortController().signal)
    expect(answer).toMatch(/^旁聊回答：\d+，fake\/fake-omp，问：[\s\S]*问一下$/)
    expect(readFileSync(record.engineSessionId!, 'utf8')).toBe(before)
    const side = argvs().find(a => a.argv.includes('--session'))
    const copy = side.argv[side.argv.indexOf('--session') + 1]
    expect(copy).not.toBe(record.engineSessionId)
    expect(existsSync(copy)).toBe(false)
    // 副本换了会话 id（租约按 id 算），其余原样
    const id = (text: string) => JSON.parse(text.split('\n').find(l => l.includes('"type":"session"'))!).id
    expect(id(side.head)).not.toBe(id(before))
    expect(side.head.replace(id(side.head), id(before))).toBe(before)
    // 副本里先关 Fast 再问
    const sent = messages().map(m => m.type)
    expect(sent.lastIndexOf('set_fast_mode')).toBeLessThan(sent.lastIndexOf('btw'))
    await expect(
      fresh({ FAKE_OMP_FAST_STUCK: '1' }).sideQuestion(record, '问一下', new AbortController().signal),
    ).rejects.toThrow(OMP_FAST_STUCK)
  })
})

describe('oh-my-pi 启动参数、版本、确认选项', () => {
  it('子智能体的会话文件：只认单个文件名；没有结果的算停了', () => {
    const line = (o: unknown) => JSON.stringify(o) + '\n'
    const main = join(root, 'main.jsonl')
    const details = { results: [], totalDurationMs: 1, progress: [{ id: 'A', status: 'pending', assignment: '查' }] }
    writeFileSync(
      main,
      line({ type: 'title' }) +
        line({ type: 'session', id: 'y' }) +
        line({
          type: 'message',
          id: 'm1',
          parentId: null,
          timestamp: '2026-11-23T06:41:46.541Z',
          message: { role: 'toolResult', toolCallId: 'c', toolName: 'task', details },
        }),
    )
    mkdirSync(join(root, 'main'))
    writeFileSync(join(root, 'main', 'A.jsonl'), line({ type: 'session' }))
    expect(ompAgentFile(main, 'A')).toBe(join(root, 'main', 'A.jsonl'))
    expect(ompAgentFile(main, 'B')).toBeNull()
    for (const id of ['../main', '..\\main', 'main/A', '..', '', 'C:x']) expect(ompAgentFile(main, id)).toBeNull()
    expect(ompRunsFromSession(main)).toMatchObject([{ id: 'A', label: 'A', state: 'stopped', prompt: '查' }])
  })
  it('旁聊副本换会话 id：同样长、只改文件头那一行；认不出文件头不改', () => {
    const file = join(root, 'copy.jsonl')
    const text = '{"type":"title","id":"t"}\n{"type":"session","version":3,"id":"abc"}\n{"type":"message","id":"abc"}\n'
    writeFileSync(file, text)
    expect(freshSessionId(file)).toBe(true)
    const [title, head, message] = readFileSync(file, 'utf8').split('\n')
    expect([title, message]).toEqual(['{"type":"title","id":"t"}', '{"type":"message","id":"abc"}'])
    expect(JSON.parse(head).id).not.toBe('abc')
    expect(JSON.parse(head).id).toHaveLength(3)
    writeFileSync(file, '{"type":"message","id":"abc"}\n')
    expect(freshSessionId(file)).toBe(false)
  })
  it('队友派来的活（strictMcp）：叠加设置停掉用户级的来源；没有叠加设置不启动', () => {
    const seen: boolean[] = []
    const launch = (strictMcp: boolean, config = true) =>
      ompLaunch(
        {},
        record,
        'edits',
        { key: '', pluginDirs: [], pathDirs: [], strictMcp },
        {
          ...(config ? { configFile: (_: unknown, isolated: boolean) => (seen.push(isolated), '/x/o.yml') } : {}),
        },
      )
    expect(launch(true).args.at(-1)).toBe('--config=/x/o.yml')
    launch(false)
    expect(seen).toEqual([true, false])
    expect(() => launch(true, false)).toThrow('oh-my-pi 的隔离设置没有写出来')
    const text = ompOverlayText({ thinkingSummaries: true, ultracode: false }, true)
    expect(text).toContain(
      'disabledProviders: [native, omp-plugins, agent-plugins, agents, claude, claude-plugins, codex,',
    )
    expect(text).toContain('enabledProviders: []')
    // 和模型提供方撞名的不能停
    expect(text).not.toContain('cursor')
  })
  const record = { model: 'pixelsky/glm-5', provider: null } as never
  it('经网关：加载网关扩展、只给 provider 配置；没走网关不加载、不带配置', () => {
    const gw = ompLaunch(
      { PIXELSKY_PIXEL_BASE_URL: 'http://127.0.0.1:1/v1', PIXELSKY_PIXEL_TOKEN: 't', PIXELSKY_PIXEL_INFERRED: '{}' },
      record,
      'edits',
      undefined,
      { extensionFile: '/x/pixelsky-gateway.mjs', args: ['--verbose'] },
    )
    // 辅助请求的角色模型也指到会话的模型，放在用户参数后面（真 omp 实测：不加会用用户自己配的 smol / slow）
    expect(gw.args).toEqual([
      '--approval-mode',
      'write',
      '-e',
      '/x/pixelsky-gateway.mjs',
      '--verbose',
      '--smol=pixelsky/glm-5',
      '--slow=pixelsky/glm-5',
      '--plan=pixelsky/glm-5',
      '--no-judge',
      '--no-spotlight',
    ])
    expect(JSON.parse(gw.env.PIXELSKY_PIXEL_PROVIDERS!).pixelsky).toMatchObject({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: '$PIXELSKY_PIXEL_TOKEN',
    })
    expect(gw.env.PIXELSKY_PIXEL_INFERRED).toBeUndefined()
    const own = ompLaunch(
      { ANTHROPIC_BASE_URL: 'http://x', PIXELSKY_PIXEL_PROVIDERS: '{}' },
      record,
      'full',
      undefined,
      {
        extensionFile: '/x/pixelsky-gateway.mjs',
      },
    )
    expect(own.args).toEqual(['--approval-mode', 'yolo'])
    expect(own.env.PIXELSKY_PIXEL_PROVIDERS).toBeUndefined()
  })

  it('网关扩展把 $ 去掉当环境变量名、补模型默认字段', async () => {
    const registered: Array<[string, Record<string, unknown>]> = []
    const url = 'data:text/javascript;base64,' + Buffer.from(OMP_GATEWAY_SOURCE).toString('base64')
    const before = process.env.PIXELSKY_PIXEL_PROVIDERS
    process.env.PIXELSKY_PIXEL_PROVIDERS = JSON.stringify({
      pixelsky: {
        baseUrl: 'http://gw',
        api: 'anthropic-messages',
        apiKey: '$PIXELSKY_PIXEL_TOKEN',
        models: [{ id: 'm1' }],
      },
    })
    try {
      const factory = (await import(url)).default as (pi: unknown) => void
      factory({ registerProvider: (name: string, config: Record<string, unknown>) => registered.push([name, config]) })
    } finally {
      if (before === undefined) delete process.env.PIXELSKY_PIXEL_PROVIDERS
      else process.env.PIXELSKY_PIXEL_PROVIDERS = before
    }
    expect(registered).toHaveLength(1)
    expect(registered[0][1]).toMatchObject({
      apiKey: 'PIXELSKY_PIXEL_TOKEN',
      models: [{ id: 'm1', name: 'm1', contextWindow: 128000, maxTokens: 16384 }],
    })
  })

  it('保留参数、版本', () => {
    expect(reservedOmpArg(['--approval-mode=yolo'])).toBe('--approval-mode')
    expect(reservedOmpArg(['--verbose'])).toBeNull()
    expect(ompVersionOf('omp/19.1.0\n')).toBe('19.1.0')
    expect(ompVersionStatus('19.0.9').status).toBe('outdated')
    expect(ompVersionStatus(OMP_MIN_VERSION).status).toBe('ready')
    expect(ompVersionStatus(null).status).toBe('error')
  })

  it('omp 的确认选项按结构认（工具名在中间那项），别的三选一不认', () => {
    expect(isOmpApprovalOptions(['Approve', 'Approve write for this session', 'Deny'])).toBe(true)
    expect(isOmpApprovalOptions(['Approve', 'Always', 'Deny'])).toBe(false)
    expect(isApprovalSelect('Allow tool: write\nPath: a', ['Approve', 'Approve write for this session', 'Deny'])).toBe(
      true,
    )
    expect(isApprovalSelect('Pick one', ['Approve', 'Approve write for this session', 'Deny'])).toBe(false)
  })

  it('omp 的 task 一次派几个：标题列出各自的名字', () => {
    const item = toolItem(
      't',
      'task',
      { context: 'c', tasks: [{ name: 'helper', task: 'x' }, { task: '查日志' }] },
      '/',
    )
    expect(item).toMatchObject({ kind: 'tool', name: 'Agent', title: 'helper、查日志' })
  })

  it('btw 记录：running 不算完、完成取回答、取消算停止、出错带原因', () => {
    expect(btwOutcome({ status: 'running' })).toBeNull()
    expect(btwOutcome({ status: 'complete', answer: ' 好 ' })).toEqual({ answer: '好' })
    expect(btwOutcome({ status: 'complete', answer: '' })).toEqual({ error: 'oh-my-pi 没有回答' })
    expect(btwOutcome({ status: 'cancelled' })).toEqual({ error: '已停止' })
    expect(btwOutcome({ status: 'interrupted' })).toEqual({ error: '已停止' })
    expect(btwOutcome({ status: 'error', error: { message: 'x' } })).toEqual({ error: 'x' })
  })
  it('终端模式参数：--resume=<会话文件>、模型（经网关带 pixelsky/）、思考档、Fast 关着时 --service-tier=none', () => {
    const base = { model: 'gpt-5.5', effort: 'high' as const, fast: false, platform: null, provider: null }
    expect(ompTuiArgs(base, 'D:/s.jsonl', ['--approval-mode', 'write'])).toEqual([
      '--approval-mode',
      'write',
      '--resume=D:/s.jsonl',
      '--model=gpt-5.5',
      '--thinking=high',
      '--service-tier=none',
    ])
    const platform = { groupId: 'g', vendor: 'openai' } as unknown as NonNullable<SessionRecord['platform']>
    expect(ompTuiArgs({ ...base, fast: true, platform }, 'D:/s.jsonl', [])).toEqual([
      '--resume=D:/s.jsonl',
      '--model=pixelsky/gpt-5.5',
      '--thinking=high',
      '--service-tier=priority',
    ])
  })
  it('计划扩展：标题和选项和适配器认的一致；白名单之外一律拦；--approval-mode 计划中最多 write', () => {
    expect(OMP_PLAN_SOURCE).toContain(JSON.stringify(PLAN_TITLE))
    expect(OMP_PLAN_SOURCE).toContain(JSON.stringify(PLAN_OPTIONS))
    expect(OMP_PLAN_ALLOW).not.toContain('bash')
    expect(OMP_PLAN_ALLOW).not.toContain('task')
    // 不在计划档也滤掉历史里的计划说明；状态整个进程共用（子智能体再挂一份时也看得到批准）
    expect(OMP_PLAN_SOURCE).toContain('globalThis.__pixelskyOmpPlan')
    expect(OMP_PLAN_SOURCE.indexOf("pi.on('context'")).toBeLessThan(OMP_PLAN_SOURCE.indexOf('pi.registerTool'))
    expect(ompApproval('plan', 'full')).toBe('write')
    expect(ompApproval('plan', null)).toBe('always-ask')
    expect(ompApproval('plan', 'edits')).toBe('write')
    expect(ompApproval('full')).toBe('yolo')
    expect(ompRestarts({ permissionMode: 'plan', planReturn: 'ask' } as never, { planReturn: 'full' })).toBe(true)
    expect(ompRestarts({ permissionMode: 'ask', planReturn: null } as never, { planReturn: 'full' })).toBe(false)
  })
  it('rpc_chunk：乱序拼齐才交出、格式不对的丢掉', () => {
    const whole = Buffer.from(JSON.stringify({ type: 'x', text: '你好' }))
    const a = whole.subarray(0, 7).toString('base64'),
      b = whole.subarray(7).toString('base64')
    const c = new ChunkAssembler()
    expect(c.push({ chunkId: 'k', index: 1, count: 2, byteLength: whole.length, data: b })).toBeNull()
    expect(c.push({ chunkId: 'k', index: 0, count: 2, byteLength: whole.length, data: a })).toEqual({
      type: 'x',
      text: '你好',
    })
    expect(c.push({ chunkId: 'k', index: 2, count: 2, data: a })).toBeNull()
    expect(c.push({ chunkId: 'z', index: 0, count: 1, byteLength: 1e12, data: a })).toBeNull()
  })
})
