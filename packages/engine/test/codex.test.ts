import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexAdapter, EngineHost } from '../src'
import {
  parseCodedError,
  type AgentRun,
  type Effort,
  type EngineEvent,
  type EngineInfo,
  type HostEvent,
  type ImageAttachment,
} from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, SessionContext } from '../src/adapter'
import { ENGINES } from '../src/registry'
import {
  codexPermission,
  codexRerouteNotice,
  codexRetryState,
  defaultModeAskSupported,
  turnErrorDetail,
  withoutOwnFeatures,
  type CodexLaunchOptions,
} from '../src/codex/session'
import { CODEX_MIN_VERSION, codexVersionStatus } from '../src/codex/discover'
import { CodexTranslator, tokenCounts } from '../src/codex/translate'
import { loadCodexRuns } from '../src/codex/runs'
import { makeTmp, removeTmp } from './helpers/tmp'
import { NATIVE_TEXT } from '../src/native/text'
let root: string, host: EngineHost | undefined
beforeEach(() => {
  root = makeTmp('codex-test')
})
afterEach(async () => {
  await host?.shutdown()
  host = undefined
  removeTmp(root)
})
const wait = async (fn: () => boolean): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('Codex test timed out')
}
/** 换一个全新的会话环境：关掉上一个宿主，清掉 RPC / 启动参数记录，不然新旧记录混在一起 */
const fresh = async () => {
  await host!.shutdown()
  rmSync(join(root, 'rpc.jsonl'), { force: true })
  rmSync(join(root, 'argv.jsonl'), { force: true })
}
function setup(
  idleMs = 50,
  opts: {
    env?: Record<string, string>
    permissionMode?: 'ask' | 'plan'
    askQuestions?: boolean
    /** 会话记录里的模型 / 推理强度；null 是跟随引擎默认，不写就用 fake-codex / high */
    model?: string | null
    effort?: Effort | null
    /** 追加的启动选项（版本、启动参数等） */
    launch?: Partial<CodexLaunchOptions>
  } = {},
) {
  const log = join(root, 'rpc.jsonl'),
    argv = join(root, 'argv.jsonl'),
    events: HostEvent[] = [],
    launcher = { command: process.execPath, args: [fileURLToPath(new URL('./fakes/fake-codex.mjs', import.meta.url))] }
  const adapter = new CodexAdapter({
    launcher,
    env: {
      ...process.env,
      FAKE_CODEX_LOG: log,
      FAKE_CODEX_ARGV: argv,
      FAKE_CODEX_RESUME_FAIL_FILE: join(root, 'resume-fail'),
      ...opts.env,
    },
    launchOptions: () => ({ askQuestions: opts.askQuestions ?? true, steeringValidated: true, ...opts.launch }),
  })
  host = new EngineHost({
    dataDir: join(root, 'engine'),
    adapters: { codex: adapter },
    emit: e => events.push(e),
    idleMs,
  })
  const session = host.createSession({
    projectId: host.addProject(root).id,
    engine: 'codex',
    model: opts.model !== undefined ? opts.model : 'fake-codex',
    effort: opts.effort !== undefined ? opts.effort : 'high',
    permissionMode: opts.permissionMode ?? 'ask',
  })
  const messages = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
  const launches = (): string[][] =>
    existsSync(argv)
      ? readFileSync(argv, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
      : []
  return { adapter, session, log, events, messages, launches }
}
describe('Codex app-server adapter', () => {
  it('检测时分清授权来源：ChatGPT 登录、API Key、config.toml 里自己的接口、没登录', async () => {
    const info = async (account: unknown, provider = 'openai') => {
      const { adapter } = setup(50, {
        env: { FAKE_CODEX_ACCOUNT: JSON.stringify(account), FAKE_CODEX_PROVIDER: provider },
      })
      const result = await adapter.info()
      await host?.shutdown()
      host = undefined
      return result
    }
    const chatgpt = await info({
      account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    })
    expect(chatgpt).toMatchObject({
      status: 'ready',
      auth: { kind: 'login' },
      account: { email: 'a@example.com', plan: 'plus' },
    })
    expect(await info({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })).toMatchObject({
      status: 'ready',
      auth: { kind: 'apiKey' },
    })
    const relay = await info({ account: null, requiresOpenaiAuth: false }, 'relay')
    expect(relay).toMatchObject({ status: 'ready', auth: { kind: 'provider', provider: 'relay' } })
    expect(relay.account).toBeUndefined()
    const none = await info({ account: null, requiresOpenaiAuth: true })
    expect(none.status).toBe('unauthenticated')
    expect(none.auth).toBeUndefined()
  })
  it('Codex 自己重连时显示「正在重试 n/m」状态条，不再每次一条报错；最后失败的报错带附加说明、错误类型和 HTTP 状态码', async () => {
    const { session, events } = setup()
    await host!.send(session.id, '重连')
    await wait(
      () =>
        host!.open(session.id).state === 'idle' &&
        host!.open(session.id).items.some(i => i.kind === 'notice' && i.level === 'error'),
    )
    const retries = events.flatMap(e =>
      e.kind === 'session' && e.sessionId === session.id && e.event.type === 'request_retry' ? [e.event.retry] : [],
    )
    expect(retries).toEqual([
      { turnId: expect.any(String), attempt: 1, maxRetries: 2, retryAt: null, reason: 'HTTP 502' },
      { turnId: expect.any(String), attempt: 2, maxRetries: 2, retryAt: null, reason: 'HTTP 502' },
    ])
    const snapshot = host!.open(session.id)
    expect(snapshot.retry).toBeNull()
    const notices = snapshot.items.filter(i => i.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      level: 'error',
      text: 'exceeded retry limit, last status: 502 Bad Gateway',
      detail: ['upstream connect error', 'type: responseTooManyFailedAttempts', 'HTTP status: 502'].join('\n'),
    })
  })
  it('换了模型：对话里一条提示，用量记在实际用的模型上；重连后接上了就收起状态条', async () => {
    const { session, events } = setup()
    await host!.send(session.id, '换模型')
    await wait(
      () => host!.open(session.id).state === 'idle' && host!.open(session.id).items.some(i => i.kind === 'notice'),
    )
    const notices = host!.open(session.id).items.filter(i => i.kind === 'notice')
    expect(notices).toEqual([
      expect.objectContaining({
        level: 'warn',
        text: 'Codex switched the model from fake-codex to fake-codex-safe: the request was flagged as high-risk cybersecurity activity',
      }),
    ])
    const retries = events.flatMap(e =>
      e.kind === 'session' && e.sessionId === session.id && e.event.type === 'request_retry' ? [e.event.retry] : [],
    )
    expect(retries).toEqual([
      expect.objectContaining({
        attempt: 1,
        maxRetries: 5,
        reason: 'stream disconnected before completion: error decoding response body',
      }),
      null,
    ])
    const done = events.flatMap(e =>
      e.kind === 'session' && e.sessionId === session.id && e.event.type === 'turn_completed' ? [e.event] : [],
    )
    expect(Object.keys(done.at(-1)!.usage!.models)).toEqual(['fake-codex-safe'])
  })
  it('重连状态和换模型提示的拼法', () => {
    expect(codexRetryState({ message: 'Reconnecting... waiting for network' }, 't1')).toEqual({
      turnId: 't1',
      attempt: null,
      maxRetries: null,
      retryAt: null,
      reason: 'waiting for network',
    })
    expect(
      codexRetryState(
        { message: 'Reconnecting... 3/5', additionalDetails: 'first line\nsecond', codexErrorInfo: 'other' },
        't1',
      ),
    ).toMatchObject({ attempt: 3, maxRetries: 5, reason: 'first line' })
    expect(codexRetryState(null, 't1').reason).toBe('Connection lost')
    expect(codexRerouteNotice({ fromModel: 'a', toModel: 'b', reason: 'somethingNew' })).toEqual({
      text: 'Codex switched the model from a to b',
      detail: 'reason: somethingNew',
    })
    expect(codexRerouteNotice({ fromModel: 'a', toModel: 'a' })).toBeNull()
    expect(codexRerouteNotice({ toModel: '' })).toBeNull()
  })
  it('报错详情：只有 message 时为空，字符串错误类型照样列出', () => {
    expect(turnErrorDetail({ message: 'boom' })).toBeNull()
    expect(turnErrorDetail(null)).toBeNull()
    expect(turnErrorDetail({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }, false)).toBe(
      ['type: usageLimitExceeded', 'will retry: no'].join('\n'),
    )
  })
  it('动态目录、流式、用量与空闲后恢复，不重复历史', async () => {
    const { adapter, session, messages } = setup()
    expect((await adapter.info()).status).toBe('ready')
    expect((await adapter.catalog()).models?.[0].efforts).toContain('ultra')
    await host!.send(session.id, 'first')
    await wait(() => host!.open(session.id).items.some(i => i.kind === 'turn_stats'))
    expect(host!.open(session.id).items.filter(i => i.kind === 'assistant')).toHaveLength(1)
    await new Promise(r => setTimeout(r, 100))
    await host!.send(session.id, 'second')
    await wait(() => host!.open(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    expect(messages().some(m => m.method === 'thread/resume')).toBe(true)
    expect(host!.open(session.id).items.filter(i => i.kind === 'user')).toHaveLength(2)
    expect(host!.open(session.id).usage?.contextWindow).toBe(128000)
  })
  it('空闲后重新起进程：子智能体追踪取运行时里已有的，不再整读一遍 rollout', async () => {
    const { adapter, session } = setup()
    const running: AgentRun = {
      id: 'child-x',
      label: '',
      type: '',
      model: '',
      state: 'running',
      startedAt: 1,
      durationMs: 0,
      tokens: 0,
      toolCalls: 0,
      phase: null,
      prompt: '',
      result: '',
      toolUseId: null,
    }
    const loadRuns = vi.spyOn(adapter, 'loadRuns').mockReturnValue({ workflows: [], agents: [running] })
    await host!.send(session.id, 'first')
    await wait(() => host!.open(session.id).items.some(i => i.kind === 'turn_stats'))
    // 空闲超时关掉进程，第二条消息会新建 CodexSession
    await new Promise(r => setTimeout(r, 100))
    await host!.send(session.id, 'second')
    await wait(() => host!.open(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    // 只有创建运行时那一次读了 rollout
    expect(loadRuns).toHaveBeenCalledTimes(1)
    // 宿主快照里的追踪没被会话改动
    expect(host!.open(session.id).runs.agents[0]).toMatchObject({ id: 'child-x', state: 'running' })
  })
  it('新会话连接拿到的子智能体追踪：来自宿主快照的副本，还在 running 的标成已中断，快照不被改', async () => {
    const { adapter, session } = setup()
    expect((await adapter.info()).status).toBe('ready')
    const agent = (id: string, state: AgentRun['state']): AgentRun => ({
      id,
      label: '',
      type: '',
      model: '',
      state,
      startedAt: 1,
      durationMs: 0,
      tokens: 0,
      toolCalls: 0,
      phase: null,
      prompt: '',
      result: '',
      toolUseId: null,
    })
    const runs = { workflows: [], agents: [agent('child-x', 'running'), agent('child-y', 'completed')] }
    const record = host!.open(session.id).record
    const loadRuns = vi.spyOn(adapter, 'loadRuns')
    const ctx = {
      record: () => record,
      emit: () => {},
      runs: () => runs,
    } as unknown as SessionContext
    const created = adapter.createSession(ctx)
    const agents = (created as unknown as { agents: Map<string, AgentRun> }).agents
    expect([...agents.values()].map(a => [a.id, a.state])).toEqual([
      ['child-x', 'interrupted'],
      ['child-y', 'completed'],
    ])
    // 快照里的那份没被改，也没有再读 rollout
    expect(runs.agents[0].state).toBe('running')
    expect(agents.get('child-x')).not.toBe(runs.agents[0])
    expect(loadRuns).not.toHaveBeenCalled()
    await created.close()
  })
  it('审批拒绝、中断与崩溃都结束轮次并暂停队列', async () => {
    const { session } = setup()
    await host!.send(session.id, '审批')
    await wait(() => host!.open(session.id).pending.length === 1)
    host!.answer(session.id, 'approve', { type: 'deny' })
    await wait(() => host!.open(session.id).state === 'idle')
    expect(host!.open(session.id).pending).toEqual([])
    host!.resumeQueue(session.id)
    await host!.send(session.id, '慢')
    await wait(() => host!.open(session.id).flags.steerAvailable === true && host!.open(session.id).state === 'running')
    await host!.interrupt(session.id)
    expect(host!.open(session.id).queuePaused).toBe(true)
  })
  it('完全放行立即覆盖本轮不同命令、子智能体、文件和权限审批，保留问答与 MCP 表单；下一轮原生放行且可以改回', async () => {
    const { session, messages, events } = setup(3000)
    await host!.send(session.id, '连续审批')
    await wait(() => host!.open(session.id).pending.length === 1)
    expect(host!.open(session.id).pending[0].canAllowAll).toBe(true)
    host!.answer(session.id, 'approval-1', { type: 'allow_all' })
    await wait(() => host!.open(session.id).pending[0]?.requestId === 'approval-5')
    expect(host!.open(session.id).record.permissionMode).toBe('full')
    expect(host!.executionRecord(session.id)?.permissionMode).toBe('full')
    expect(messages().find(m => m.id === 'approval-2' && m.result)?.result).toEqual({ decision: 'accept' })
    expect(messages().find(m => m.id === 'approval-3' && m.result)?.result).toEqual({ decision: 'accept' })
    expect(messages().find(m => m.id === 'approval-4' && m.result)?.result).toMatchObject({
      permissions: { network: { enabled: true } },
    })
    expect(
      events.flatMap(e =>
        e.kind === 'session' && e.event.type === 'approval_request' ? [e.event.request.requestId] : [],
      ),
    ).toEqual(['approval-1', 'approval-5'])
    host!.answer(session.id, 'approval-5', { type: 'answer', answers: { 'Choose a name': 'Pixel' } })
    await wait(() => host!.open(session.id).pending[0]?.requestId === 'approval-6')
    expect(host!.open(session.id).pending[0].canAllowAll).toBe(false)
    host!.answer(session.id, 'approval-6', { type: 'form', content: { name: 'Pixel' } })
    await wait(() => host!.open(session.id).state === 'idle')

    await host!.send(session.id, '第二轮')
    await wait(() => host!.open(session.id).state === 'idle')
    expect(
      messages()
        .filter(m => m.method === 'turn/start')
        .at(-1).params,
    ).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
    const other = host!.createSession({ projectId: session.projectId, engine: 'codex' })
    expect(other.permissionMode).toBe('edits')

    await host!.update(session.id, { permissionMode: 'edits' })
    await host!.send(session.id, '审批')
    await wait(() => host!.open(session.id).pending.length === 1)
    expect(
      messages()
        .filter(m => m.method === 'turn/start')
        .at(-1).params.approvalPolicy,
    ).toBe('on-request')
    host!.answer(session.id, 'approve', { type: 'deny' })
    await wait(() => host!.open(session.id).state === 'idle')
  })
  it.each(['allow', 'allow_always'] as const)('%s 保留原来的审批范围，不切换为完全放行', async type => {
    const { session } = setup()
    await host!.send(session.id, '连续审批')
    await wait(() => host!.open(session.id).pending.length === 1)
    host!.answer(session.id, 'approval-1', type === 'allow' ? { type } : { type, scope: 'session' })
    await wait(() => host!.open(session.id).pending[0]?.requestId === 'approval-2')
    expect(host!.open(session.id).record.permissionMode).toBe('ask')
    host!.answer(session.id, 'approval-2', { type: 'deny' })
    await wait(() => host!.open(session.id).state === 'idle')
  })
  it('原生请求不支持允许时不能通过完全放行绕过，也不会修改权限', async () => {
    const { session } = setup(50, { env: { FAKE_CODEX_DECISIONS: '["decline"]' } })
    await host!.send(session.id, '审批')
    await wait(() => host!.open(session.id).pending.length === 1)
    expect(host!.open(session.id).pending[0].canAllowAll).toBe(false)
    expect(() => host!.answer(session.id, 'approve', { type: 'allow_all' })).toThrow('cannot enable full access')
    expect(host!.open(session.id).record.permissionMode).toBe('ask')
    expect(host!.open(session.id).pending).toHaveLength(1)
    host!.answer(session.id, 'approve', { type: 'deny' })
    await wait(() => host!.open(session.id).state === 'idle')
  })
  it('原生引导用对应轮次和 client ID，单条消费并显示用户内容', async () => {
    const { session, messages } = setup()
    await host!.send(session.id, '慢')
    await wait(() => host!.open(session.id).flags.steerAvailable === true)
    await new Promise(r => setTimeout(r, 40))
    const receipt = await host!.send(session.id, { text: '追加要求', clientMessageId: 'guidance-1' })
    const turnId = host!.open(session.id).turnId!
    await host!.steerQueued(session.id, receipt.queueId, turnId)
    await wait(() => host!.open(session.id).items.some(i => i.kind === 'user' && i.text === '追加要求'))
    expect(messages().find(m => m.method === 'turn/steer').params.expectedTurnId).toMatch(/^turn-/)
    expect(host!.open(session.id).items.filter(i => i.kind === 'user' && i.text === '追加要求')).toHaveLength(1)
    await host!.interrupt(session.id)
  })
  it('config.toml 引起的警告不进对话、记在引擎信息上（只广播一次，重新检测清掉）；别的警告照常每次都显示', async () => {
    const { session, events } = setup()
    await host!.send(session.id, '警告')
    await wait(() => host!.open(session.id).items.some(i => i.kind === 'turn_stats'))
    await host!.send(session.id, '警告')
    await wait(() => host!.open(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    const notices = host!.open(session.id).items.flatMap(i => (i.kind === 'notice' ? [[i.level, i.text]] : []))
    expect(notices).toEqual([
      ['warn', 'Model metadata for `fake-model` not found.'],
      ['warn', 'Model metadata for `fake-model` not found.'],
    ])
    const codex = async () => (await host!.engines()).find(e => e.id === 'codex')!
    expect((await codex()).configWarnings).toEqual([
      expect.stringMatching(/^Codex is ignoring 2 unrecognized configuration settings/),
      expect.stringMatching(/^Under-development features enabled/),
    ])
    // 第二轮同样的警告不再广播
    const broadcasts = events.filter(e => e.kind === 'engines' && e.engines.some(x => x.configWarnings))
    expect(broadcasts).toHaveLength(2)
    // 登录 / 装更新 / 改启动设置引起的重新检测不动警告；用户自己点「重新检测」才清掉
    await host!.engines(true)
    expect((await codex()).configWarnings).toHaveLength(2)
    await host!.engines(true, true)
    expect((await codex()).configWarnings).toBeUndefined()
  })
  it('原生压缩走方法而非 turn/start 的普通提示', async () => {
    const { session, messages } = setup()
    await host!.send(session.id, 'hello')
    await wait(() => host!.open(session.id).state === 'idle' && host!.open(session.id).flags.compactAvailable === true)
    await host!.compactContext(session.id)
    await wait(() => messages().some(m => m.method === 'thread/compact/start'))
    expect(messages().filter(m => m.method === 'turn/start')).toHaveLength(1)
    await wait(() => host!.open(session.id).state === 'idle')
    expect(host!.open(session.id).context?.compacting).toBe(false)
  })
  it('空闲超时关掉引擎进程后点压缩：不报错，重新拉起会话再压缩', async () => {
    const { session, messages, launches } = setup(50)
    await host!.send(session.id, 'hello')
    await wait(() => host!.open(session.id).state === 'idle' && host!.open(session.id).flags.compactAvailable === true)
    // idleMs=50：进程被关掉后 flags.compactAvailable 还留着，但已经没有活的会话
    await wait(() => messages().some(m => m.method === 'turn/start'))
    await new Promise(r => setTimeout(r, 400))
    expect(host!.open(session.id).flags.compactAvailable).toBe(true)
    const before = launches().length
    await host!.compactContext(session.id)
    await wait(() => messages().some(m => m.method === 'thread/compact/start'))
    expect(launches().length).toBeGreaterThan(before)
    expect(messages().filter(m => m.method === 'turn/start')).toHaveLength(1)
    await wait(() => host!.open(session.id).state === 'idle')
  })
  it('会话还没开始过（没有 compactAvailable）点压缩仍然报错', async () => {
    const { session } = setup()
    await expect(host!.compactContext(session.id)).rejects.toThrow('当前引擎不支持原生压缩')
  })
  it('恢复线程失败（记录还在）：新开线程，把之前的聊天注进去并提示（详情里有 Codex 报的原因），换掉线程 id，之后的消息正常完成', async () => {
    const { session, messages } = setup()
    const failFile = join(root, 'resume-fail')
    await host!.send(session.id, 'first')
    await wait(() => host!.open(session.id).items.some(i => i.kind === 'turn_stats'))
    const oldId = host!.open(session.id).record.engineSessionId
    writeFileSync(failFile, '')
    await new Promise(r => setTimeout(r, 100))
    await host!.send(session.id, 'second')
    await wait(() => host!.open(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    expect(messages().some(m => m.method === 'thread/resume')).toBe(true)
    const notices = host!.open(session.id).items.filter(i => i.kind === 'notice')
    expect(notices).toEqual([
      expect.objectContaining({ kind: 'notice', level: 'warn', text: NATIVE_TEXT.resumeLost(1, 'Codex') }),
    ])
    const detail = notices[0].kind === 'notice' ? (notices[0].detail ?? '') : ''
    expect(detail.startsWith('thread/resume: ')).toBe(true)
    expect(detail).toContain('first')
    // 之前那一轮注进了新线程，这一轮自己的话不在回放里
    const injected = messages().filter(m => m.method === 'thread/inject_items')
    expect(injected).toHaveLength(1)
    expect(JSON.stringify(injected[0].params)).toContain('first')
    expect(JSON.stringify(injected[0].params)).not.toContain('second')
    expect(host!.open(session.id).items.some(i => i.kind === 'notice' && /Could not resume/.test(i.text))).toBe(false)
    expect(host!.open(session.id).record.engineSessionId).toBeTruthy()
    expect(host!.open(session.id).record.engineSessionId).not.toBe(oldId)
    rmSync(failFile)
    await host!.send(session.id, 'third')
    await wait(() => host!.open(session.id).items.filter(i => i.kind === 'turn_stats').length === 3)
    expect(host!.open(session.id).state).toBe('idle')
  })
  it('thread/start 和 thread/resume 显式带 modelProvider：自己账号用 config 里的当前 provider，自定义接口是 pixelsky-custom', async () => {
    const providers = (messages: () => { method?: string; params?: Record<string, unknown> }[]) =>
      messages()
        .filter(m => m.method === 'thread/start' || m.method === 'thread/resume')
        .map(m => [m.method, m.params?.modelProvider])
    const own = setup(50, { env: { FAKE_CODEX_PROVIDER: 'openai' } })
    await host!.send(own.session.id, 'one')
    await wait(() => host!.open(own.session.id).items.some(i => i.kind === 'turn_stats'))
    await new Promise(r => setTimeout(r, 150))
    await host!.send(own.session.id, 'two')
    await wait(() => host!.open(own.session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    expect(providers(own.messages)).toEqual([
      ['thread/start', 'openai'],
      ['thread/resume', 'openai'],
    ])
    await host!.shutdown()
    host = undefined
    const gateway = setup(50, {
      env: { PIXELSKY_CODEX_BASE_URL: 'http://127.0.0.1:9/v1', PIXELSKY_CODEX_TOKEN: 'tok' },
    })
    await host!.update(gateway.session.id, { provider: { id: 'my-api' } })
    await host!.send(gateway.session.id, 'one')
    await wait(() => host!.open(gateway.session.id).items.some(i => i.kind === 'turn_stats'))
    expect(providers(gateway.messages).at(-1)).toEqual(['thread/start', 'pixelsky-custom'])
  })
  it('经网关的线程在 Codex 里改名带上「[像素星空]」前缀，跟着标题改；自己账号的不改名', async () => {
    const names = (messages: () => { method?: string; params?: Record<string, unknown> }[]) =>
      messages()
        .filter(m => m.method === 'thread/name/set')
        .map(m => m.params?.name)
    const own = setup(50, { env: { FAKE_CODEX_PROVIDER: 'openai' } })
    await host!.send(own.session.id, 'one')
    await wait(() => host!.open(own.session.id).items.some(i => i.kind === 'turn_stats'))
    expect(names(own.messages)).toEqual([])
    await host!.shutdown()
    host = undefined

    const gateway = setup(50, {
      env: { PIXELSKY_CODEX_BASE_URL: 'http://127.0.0.1:9/v1', PIXELSKY_CODEX_TOKEN: 'tok' },
    })
    await host!.update(gateway.session.id, { provider: { id: 'my-api' } })
    await host!.send(gateway.session.id, 'hello there')
    await wait(() => names(gateway.messages).length === 1)
    expect(names(gateway.messages)).toEqual(['[像素星空] hello there'])
    // 标题没变：第二轮不再改名
    await host!.send(gateway.session.id, 'again')
    await wait(() => host!.open(gateway.session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    expect(names(gateway.messages)).toHaveLength(1)
  })
  it('thread/resume 带 modelProvider：关掉进程再发送，resume 里是当前来源', async () => {
    const { session, messages } = setup(50, {
      env: { PIXELSKY_CODEX_BASE_URL: 'http://127.0.0.1:9/v1', PIXELSKY_CODEX_TOKEN: 'tok' },
    })
    await host!.update(session.id, { provider: { id: 'my-api' } })
    await host!.send(session.id, 'one')
    await wait(() => host!.open(session.id).items.some(i => i.kind === 'turn_stats'))
    await new Promise(r => setTimeout(r, 150))
    await host!.send(session.id, 'two')
    await wait(() => host!.open(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    expect(messages().find(m => m.method === 'thread/resume')?.params?.modelProvider).toBe('pixelsky-custom')
  })
  it('线程正被别的进程写着（already has an active writer）：失败代码 resume.live，不改开新线程', async () => {
    const { session, messages } = setup(50, { env: { FAKE_CODEX_LOCKED: '1' } })
    await host!.send(session.id, 'first')
    await wait(() => host!.open(session.id).items.some(i => i.kind === 'turn_stats'))
    const oldId = host!.open(session.id).record.engineSessionId
    await new Promise(r => setTimeout(r, 150))
    const starts = () => messages().filter(m => m.method === 'thread/start').length
    const before = starts()
    await host!.send(session.id, 'second')
    await wait(() => host!.open(session.id).state === 'idle' && host!.open(session.id).queue.some(q => q.error))
    expect(messages().some(m => m.method === 'thread/resume')).toBe(true)
    expect(starts()).toBe(before)
    const queued = host!.open(session.id).queue.find(q => q.error)
    expect(parseCodedError(queued?.error)?.code).toBe('resume.live')
    expect(host!.open(session.id).record.engineSessionId).toBe(oldId)
  })
  it('停止后等原生结束这一轮，不会直接结束进程', async () => {
    const { session, messages, events } = setup()
    await host!.send(session.id, '缓停')
    // 等原生轮次已经开始（有了 turn id），否则停止只会在本地结束
    await wait(() => host!.open(session.id).items.some(i => i.kind === 'assistant'))
    const started = Date.now()
    await host!.interrupt(session.id)
    // 原生约 1 秒后才回 interrupted：停止要等到它结束，而不是 300 毫秒就结束进程
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(host!.open(session.id).state).toBe('idle')
    expect(messages().some(m => m.method === 'turn/interrupt')).toBe(true)
    expect(messages().filter(m => m.method === 'thread/start' || m.method === 'thread/resume')).toHaveLength(1)
    expect(
      events.some(e => e.kind === 'session' && e.event.type === 'turn_completed' && e.event.outcome === 'interrupted'),
    ).toBe(true)
  })
  it('turn/start 未返回时停止，返回后对返回的 turn id 补发 turn/interrupt', async () => {
    // 停止后会话空闲，给足时间，让晚到的 turn/start 响应能回到还活着的进程
    const { session, messages, log } = setup(3000)
    await host!.send(session.id, '延迟')
    await wait(() => existsSync(log) && messages().some(m => m.method === 'turn/start'))
    await host!.interrupt(session.id)
    expect(host!.open(session.id).state).toBe('idle')
    await wait(() => messages().some(m => m.method === 'turn/interrupt'))
    expect(messages().find(m => m.method === 'turn/interrupt').params).toEqual({
      threadId: 'fake-thread',
      turnId: 'turn-1',
    })
  })
  it('找不到的审批也发 approval_resolved，不影响真正的审批', async () => {
    const { session, events } = setup()
    await host!.send(session.id, '审批')
    await wait(() => host!.open(session.id).pending.length === 1)
    host!.answer(session.id, 'missing-request', { type: 'deny' })
    expect(
      events.some(
        e => e.kind === 'session' && e.event.type === 'approval_resolved' && e.event.requestId === 'missing-request',
      ),
    ).toBe(true)
    expect(host!.open(session.id).pending).toHaveLength(1)
    host!.answer(session.id, 'approve', { type: 'deny' })
    await wait(() => host!.open(session.id).state === 'idle')
    expect(host!.open(session.id).pending).toEqual([])
  })
  it('子智能体（别的线程）的审批照常弹卡，标题带子智能体', async () => {
    const { session, messages } = setup()
    await host!.send(session.id, '子智能体审批')
    await wait(() => host!.open(session.id).pending.length === 1)
    expect(host!.open(session.id).pending[0]).toMatchObject({
      requestId: 'approve',
      itemId: null,
      title: 'Codex subagent fake-sub command approval',
      command: 'npm test',
    })
    host!.answer(session.id, 'approve', { type: 'allow' })
    await wait(() => host!.open(session.id).state === 'idle')
    expect(messages().find(m => m.id === 'approve' && m.result)?.result).toEqual({ decision: 'accept' })
  })
  it('Codex 版本检查：读不到为 error，低于下限为 outdated，达到下限为 ready', () => {
    expect(codexVersionStatus(null)).toEqual({ status: 'error', message: 'Could not read the Codex version' })
    expect(codexVersionStatus('0.159.9')).toEqual({
      status: 'outdated',
      message: 'Codex is too old (requires 0.160.0 or later). Run npm i -g @openai/codex@latest',
    })
    expect(codexVersionStatus(CODEX_MIN_VERSION)).toEqual({ status: 'ready', message: null })
    expect(codexVersionStatus('0.161.0')).toEqual({ status: 'ready', message: null })
  })
  it('文件 diff 和完整消息更新不重复累计文字，缓存拆分不重叠', () => {
    const items: unknown[] = []
    const translator = new CodexTranslator(e => items.push(e))
    translator.item({ type: 'agentMessage', id: 'one', text: '' }, false)
    translator.delta('item/agentMessage/delta', { itemId: 'one', delta: 'hello' })
    translator.item({ type: 'agentMessage', id: 'one', text: 'hello' }, true)
    expect(translator.items.get('cx-one')).toMatchObject({ text: 'hello' })
    translator.item(
      {
        type: 'fileChange',
        id: 'file',
        changes: [{ path: 'file.ts', kind: { type: 'update' }, diff: '@@\n-old\n+new' }],
      },
      true,
    )
    expect(translator.items.get('cx-file')).toMatchObject({ changes: [{ added: 1, removed: 1 }] })
    expect(
      tokenCounts({ inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 10, outputTokens: 20 }),
    ).toMatchObject({ input: 50, cacheRead: 40, cacheWrite: 10, output: 20 })
    expect(codexPermission('plan').sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false })
    // 项目的附加文件夹和工作目录一样可写（docs/ui/multi-root-projects.md §3.3）
    expect(codexPermission('auto', '/w', ['/a', '/b']).sandboxPolicy).toMatchObject({
      writableRoots: ['/w', '/a', '/b'],
    })
  })
  it('压缩上下文：开始带压缩前大小，完成后用下一次用量补上压缩后大小', () => {
    const events: EngineEvent[] = []
    let used: number | null = 120_000
    const translator = new CodexTranslator(
      e => events.push(e),
      () => used,
    )
    translator.item({ type: 'contextCompaction', id: 'c1' }, false)
    expect(translator.items.get('cx-c1')).toMatchObject({ kind: 'compaction', status: 'running', preTokens: 120_000 })
    used = 130_000
    translator.item({ type: 'contextCompaction', id: 'c1' }, true)
    expect(translator.items.get('cx-c1')).toMatchObject({ status: 'completed', preTokens: 120_000, postTokens: null })
    expect(translator.items.get('cx-c1')).toHaveProperty('durationMs', expect.any(Number))
    translator.usage(15_000)
    translator.usage(16_000)
    expect(translator.items.get('cx-c1')).toMatchObject({ postTokens: 15_000 })
  })
  it('新版子智能体：派出出一张卡并进追踪，发消息不出卡，跑完跨轮也能更新，子线程算工具次数和 token', () => {
    const events: EngineEvent[] = [],
      agents = new Map<string, AgentRun>()
    const first = new CodexTranslator(e => events.push(e), undefined, agents)
    const spawn = {
      type: 'subAgentActivity',
      id: 'call_spawn',
      kind: 'started',
      agentThreadId: 'child-1',
      agentPath: '/root/pattern_api',
      model: 'gpt-x',
    }
    first.item(spawn, false)
    first.item(spawn, true)
    expect(first.items.get('cx-call_spawn')).toMatchObject({
      kind: 'tool',
      tool: 'task',
      title: 'pattern_api',
      status: 'completed',
    })
    expect(agents.get('child-1')).toMatchObject({
      label: 'pattern_api',
      model: 'gpt-x',
      state: 'running',
      toolUseId: 'cx-call_spawn',
    })
    first.item({ type: 'subAgentActivity', id: 'call_msg', kind: 'interacted', agentThreadId: 'child-1' }, true)
    expect(first.items.has('cx-call_msg')).toBe(false)
    first.child('child-1', 'item/completed', { item: { type: 'commandExecution' } })
    first.child('child-1', 'item/completed', { item: { type: 'agentMessage' } })
    first.child('child-1', 'thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 1234 } } })
    expect(agents.get('child-1')).toMatchObject({ toolCalls: 1, tokens: 1234 })
    // 下一轮换了翻译器，跑完照样记到原来的追踪上
    const next = new CodexTranslator(e => events.push(e), undefined, agents)
    next.item(
      {
        type: 'subAgentActivity',
        id: 'subagent-completed-child-1',
        kind: 'completed',
        agentThreadId: 'child-1',
        agentPath: '/root/pattern_api',
      },
      true,
    )
    expect(next.items.size).toBe(0)
    expect(agents.get('child-1')).toMatchObject({
      state: 'completed',
      model: 'gpt-x',
      toolUseId: 'cx-call_spawn',
      toolCalls: 1,
    })
    const runs = events.filter(e => e.type === 'runs').at(-1)
    expect(runs).toMatchObject({ runs: { agents: [{ id: 'child-1', state: 'completed' }] } })
  })
  it('重新打开会话：从线程的各段 rollout 还原子智能体追踪', () => {
    const thread = '01a14092-744d-7183-a67e-8a03c58f3578',
      at = parseInt(thread.replace(/-/g, '').slice(0, 12), 16)
    const dayDir = (time: number) => {
      const date = new Date(time),
        dir = join(
          root,
          'sessions',
          String(date.getFullYear()),
          String(date.getMonth() + 1).padStart(2, '0'),
          String(date.getDate()).padStart(2, '0'),
        )
      mkdirSync(dir, { recursive: true })
      return dir
    }
    const event = (item: object, started: number) =>
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'item_completed', thread_id: thread, item, started_at_ms: started },
      })
    const activity = (id: string, kind: string, model: string | null) => ({
      type: 'SubAgentActivity',
      model,
      id,
      kind,
      agent_thread_id: 'child-1',
      agent_path: '/root/pattern_api',
    })
    writeFileSync(
      join(dayDir(at), `rollout-2026-10-16T01-18-22-${thread}.jsonl`),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: thread } }),
        event(activity('call_spawn', 'started', 'gpt-x'), at + 1000),
      ].join('\n'),
    )
    // 隔几天接着跑：另起一段，放在那天的目录
    writeFileSync(
      join(
        dayDir(at + 3 * 86_400_000),
        `rollout-2026-10-19T09-00-00-${thread}_01a14097-8eb8-7691-873b-2c6ad0d11d32.jsonl`,
      ),
      [event(activity('subagent-completed-child-1', 'completed', null), at + 61_000), ''].join('\n'),
    )
    expect(loadCodexRuns(root, thread).agents).toEqual([
      expect.objectContaining({
        id: 'child-1',
        label: 'pattern_api',
        model: 'gpt-x',
        state: 'completed',
        startedAt: at + 1000,
        durationMs: 60_000,
        toolUseId: 'cx-call_spawn',
      }),
    ])
    expect(loadCodexRuns(root, 'not-a-uuid').agents).toEqual([])
  })
  it('重新打开会话：只派出没跑完的子智能体标成已中断，跑完的保持完成', () => {
    const thread = '01a14092-744d-7183-a67e-8a03c58f3579',
      at = parseInt(thread.replace(/-/g, '').slice(0, 12), 16),
      date = new Date(at),
      dir = join(
        root,
        'sessions',
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      )
    mkdirSync(dir, { recursive: true })
    const event = (id: string, kind: string, child: string, started: number) =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: thread,
          item: { type: 'SubAgentActivity', id, kind, agent_thread_id: child, agent_path: '/root/' + child },
          started_at_ms: started,
        },
      })
    writeFileSync(
      join(dir, `rollout-2026-10-16T01-18-22-${thread}.jsonl`),
      [
        event('s1', 'started', 'child-a', at + 1000),
        event('s2', 'started', 'child-b', at + 2000),
        event('c2', 'completed', 'child-b', at + 5000),
      ].join('\n'),
    )
    const agents = loadCodexRuns(root, thread).agents
    expect(agents.find(a => a.id === 'child-a')).toMatchObject({ state: 'interrupted', toolUseId: 'cx-s1' })
    expect(agents.find(a => a.id === 'child-b')).toMatchObject({ state: 'completed', durationMs: 3000 })
  })
  it('collab 调用只有派出（spawnAgent）出派发卡并认领子智能体；等待 / 关闭沿用派出时的卡片，状态跟着子智能体', () => {
    const agents = new Map<string, AgentRun>(),
      translator = new CodexTranslator(() => {}, undefined, agents),
      collab = (id: string, tool: string, status: string, state: string) => ({
        type: 'collabAgentToolCall',
        id,
        tool,
        status,
        prompt: tool === 'spawnAgent' ? '干活' : undefined,
        receiverThreadIds: ['child-1'],
        agentsStates: { 'child-1': { status: state, message: null } },
      })
    translator.item(collab('spawn', 'spawnAgent', 'completed', 'pendingInit'), true)
    translator.item(collab('wait', 'wait', 'completed', 'running'), true)
    translator.item(collab('close', 'closeAgent', 'completed', 'shutdown'), true)
    expect(translator.items.get('cx-spawn')).toMatchObject({ name: 'spawn_agent' })
    expect(translator.items.get('cx-wait')).toMatchObject({ name: 'collabAgentToolCall' })
    expect(translator.items.get('cx-close')).toMatchObject({ name: 'collabAgentToolCall' })
    expect(agents.get('child-1')).toMatchObject({ state: 'shutdown', toolUseId: 'cx-spawn', prompt: '干活' })
  })
  it('重新打开会话：只派出没跑完的子智能体标成已中断，跑完的保持完成', () => {
    const thread = '01a14092-744d-7183-a67e-8a03c58f3579',
      at = parseInt(thread.replace(/-/g, '').slice(0, 12), 16),
      date = new Date(at),
      dir = join(
        root,
        'sessions',
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      )
    mkdirSync(dir, { recursive: true })
    const event = (id: string, kind: string, child: string, started: number) =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: thread,
          item: { type: 'SubAgentActivity', id, kind, agent_thread_id: child, agent_path: '/root/' + child },
          started_at_ms: started,
        },
      })
    writeFileSync(
      join(dir, `rollout-2026-10-16T01-18-22-${thread}.jsonl`),
      [
        event('s1', 'started', 'child-a', at + 1000),
        event('s2', 'started', 'child-b', at + 2000),
        event('c2', 'completed', 'child-b', at + 5000),
      ].join('\n'),
    )
    const agents = loadCodexRuns(root, thread).agents
    expect(agents.find(a => a.id === 'child-a')).toMatchObject({ state: 'interrupted', toolUseId: 'cx-s1' })
    expect(agents.find(a => a.id === 'child-b')).toMatchObject({ state: 'completed', durationMs: 3000 })
  })
  it('collab 调用只有派出（spawnAgent）认领子智能体；等待 / 关闭沿用派出时的卡片，状态跟着子智能体', () => {
    const agents = new Map<string, AgentRun>(),
      translator = new CodexTranslator(() => {}, undefined, agents),
      collab = (id: string, tool: string, status: string, state: string) => ({
        type: 'collabAgentToolCall',
        id,
        tool,
        status,
        prompt: tool === 'spawnAgent' ? '干活' : undefined,
        receiverThreadIds: ['child-1'],
        agentsStates: { 'child-1': { status: state, message: null } },
      })
    translator.item(collab('spawn', 'spawnAgent', 'completed', 'pendingInit'), true)
    translator.item(collab('wait', 'wait', 'completed', 'running'), true)
    translator.item(collab('close', 'closeAgent', 'completed', 'shutdown'), true)
    expect(translator.items.get('cx-spawn')).toMatchObject({ name: 'spawn_agent' })
    expect(translator.items.get('cx-wait')).toMatchObject({ name: 'collabAgentToolCall' })
    expect(translator.items.get('cx-close')).toMatchObject({ name: 'collabAgentToolCall' })
    expect(agents.get('child-1')).toMatchObject({ state: 'shutdown', toolUseId: 'cx-spawn', prompt: '干活' })
  })
  it('计划模式带 Codex 原生计划协作模式，模型提问弹问题卡；切回别的权限时带一次 default', async () => {
    const { session, messages } = setup(50, { permissionMode: 'plan' })
    await host!.send(session.id, '提问')
    await wait(() => host!.open(session.id).pending.length === 1)
    const start = () => messages().filter(m => m.method === 'turn/start')
    // 会话进程声明实验接口（第一条 initialize 是检测引擎时的探测进程）
    expect(
      messages()
        .filter(m => m.method === 'initialize')
        .at(-1)?.params.capabilities,
    ).toEqual({ experimentalApi: true })
    expect(start()[0].params).toMatchObject({
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly' },
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'fake-codex', reasoning_effort: 'high', developer_instructions: null },
      },
    })
    expect(host!.open(session.id).pending[0]).toMatchObject({
      requestId: 'ask',
      kind: 'question',
      questions: [
        {
          id: 'scope',
          question: '先做哪一批？',
          allowOther: true,
          options: [{ label: '只做收尾（推荐）' }, { label: '先补测试' }],
        },
      ],
    })
    host!.answer(session.id, 'ask', { type: 'answer', answers: { '先做哪一批？': '只做收尾（推荐）' } })
    await wait(() => host!.open(session.id).state === 'idle')
    expect(messages().find(m => m.id === 'ask' && m.result)?.result).toEqual({
      answers: { scope: { answers: ['只做收尾（推荐）'] } },
    })
    await host!.update(session.id, { permissionMode: 'edits' })
    await host!.send(session.id, '第二轮')
    await wait(() => host!.open(session.id).state === 'idle' && start().length === 2)
    await host!.send(session.id, '第三轮')
    await wait(() => host!.open(session.id).state === 'idle' && start().length === 3)
    expect(start()[1].params.collaborationMode).toMatchObject({ mode: 'default', settings: { model: 'fake-codex' } })
    expect(start()[2].params.collaborationMode).toBeUndefined()
  })
  it('允许提问时打开 Default 模式提问：启动带开关，第一轮带一次 default 拿提问指令，非计划模式也弹问题卡', async () => {
    const { session, messages, launches } = setup()
    await host!.send(session.id, '提问')
    await wait(() => host!.open(session.id).pending.length === 1)
    expect(launches().at(-1)).toEqual(expect.arrayContaining(['-c', 'features.default_mode_request_user_input=true']))
    const start = () => messages().filter(m => m.method === 'turn/start')
    expect(start()[0].params.collaborationMode).toEqual({
      mode: 'default',
      settings: { model: 'fake-codex', reasoning_effort: 'high', developer_instructions: null },
    })
    expect(host!.open(session.id).pending[0]).toMatchObject({ kind: 'question', questions: [{ id: 'scope' }] })
    host!.answer(session.id, 'ask', { type: 'answer', answers: { '先做哪一批？': '先补测试' } })
    await wait(() => host!.open(session.id).state === 'idle')
    await host!.send(session.id, '第二轮')
    await wait(() => host!.open(session.id).state === 'idle' && start().length === 2)
    expect(start()[1].params.collaborationMode).toBeUndefined()
  })
  it('不允许提问时不开 Default 模式提问，也不带协作模式', async () => {
    const { session, messages, launches } = setup(50, { askQuestions: false })
    await host!.send(session.id, '提问')
    await wait(() => host!.open(session.id).state === 'idle')
    expect(host!.open(session.id).pending).toHaveLength(0)
    expect(launches().at(-1)!.join(' ')).not.toContain('default_mode_request_user_input')
    expect(messages().find(m => m.method === 'turn/start')?.params.collaborationMode).toBeUndefined()
  })
  describe('Default 模式提问的协作模式', () => {
    type Messages = ReturnType<typeof setup>['messages']
    const turns = (messages: Messages) => messages().filter(m => m.method === 'turn/start')
    /** 发一轮，等到这一轮结束（累计第 count 个 turn/start 之后回到空闲） */
    const send = async (id: string, text: string, count: number, messages: Messages) => {
      await host!.send(id, text)
      await wait(() => host!.open(id).state === 'idle' && turns(messages).length === count)
    }
    it('推理强度跟随引擎配置时第一轮带线程报的强度，不带 null 冲掉 config.toml 里的', async () => {
      const { session, messages } = setup(10_000, {
        effort: null,
        env: { FAKE_CODEX_THREAD_EFFORT: 'xhigh', FAKE_CODEX_THREAD_MODEL: 'fake-codex' },
      })
      await send(session.id, '第一轮', 1, messages)
      expect(turns(messages)[0].params.collaborationMode).toEqual({
        mode: 'default',
        settings: { model: 'fake-codex', reasoning_effort: 'xhigh', developer_instructions: null },
      })
      expect(turns(messages)[0].params.effort).toBeUndefined()
    })
    it('强度不知道（线程没报、会话也没选）且模型有强度可选时不带 default；计划模式照旧带 null', async () => {
      const { session, messages } = setup(10_000, { effort: null })
      await send(session.id, '第一轮', 1, messages)
      expect(turns(messages)[0].params.collaborationMode).toBeUndefined()
      await host!.update(session.id, { permissionMode: 'plan' })
      await send(session.id, '计划', 2, messages)
      expect(turns(messages)[1].params.collaborationMode).toEqual({
        mode: 'plan',
        settings: { model: 'fake-codex', reasoning_effort: null, developer_instructions: null },
      })
    })
    it('模型不知道时不带 default（也不报错）；线程报了模型就用它', async () => {
      const unknown = setup(10_000, {
        model: null,
        env: { FAKE_CODEX_NO_MODEL: '1', FAKE_CODEX_THREAD_EFFORT: 'high' },
      })
      await send(unknown.session.id, '第一轮', 1, unknown.messages)
      expect(turns(unknown.messages)[0].params.collaborationMode).toBeUndefined()
      expect(turns(unknown.messages)[0].params.model).toBeUndefined()
      await fresh()
      const reported = setup(10_000, {
        model: null,
        env: { FAKE_CODEX_NO_MODEL: '1', FAKE_CODEX_THREAD_MODEL: 'fake-plain', FAKE_CODEX_THREAD_EFFORT: 'high' },
      })
      await send(reported.session.id, '第一轮', 1, reported.messages)
      expect(turns(reported.messages)[0].params.collaborationMode).toMatchObject({
        mode: 'default',
        settings: { model: 'fake-plain', reasoning_effort: 'high' },
      })
    })
    it('中途换模型或推理强度：带过 default 之后换了就重新带，没换不重复带', async () => {
      const { session, messages } = setup(10_000)
      await send(session.id, '第一轮', 1, messages)
      await send(session.id, '没换', 2, messages)
      expect(turns(messages)[1].params.collaborationMode).toBeUndefined()
      await host!.update(session.id, { effort: 'low' })
      await send(session.id, '换强度', 3, messages)
      expect(turns(messages)[2].params).toMatchObject({
        effort: 'low',
        collaborationMode: { mode: 'default', settings: { model: 'fake-codex', reasoning_effort: 'low' } },
      })
      await send(session.id, '又没换', 4, messages)
      expect(turns(messages)[3].params.collaborationMode).toBeUndefined()
      await host!.update(session.id, { model: 'fake-plain', effort: 'high' })
      await send(session.id, '换模型', 5, messages)
      expect(turns(messages)[4].params).toMatchObject({
        model: 'fake-plain',
        collaborationMode: { mode: 'default', settings: { model: 'fake-plain', reasoning_effort: 'high' } },
      })
    })
    it('跟随引擎默认的会话换回默认强度时，用线程报的强度重新带', async () => {
      const { session, messages } = setup(10_000, {
        env: { FAKE_CODEX_THREAD_EFFORT: 'xhigh', FAKE_CODEX_THREAD_MODEL: 'fake-codex' },
      })
      await send(session.id, '第一轮', 1, messages)
      expect(turns(messages)[0].params.collaborationMode).toMatchObject({ settings: { reasoning_effort: 'high' } })
      await host!.update(session.id, { effort: null })
      await send(session.id, '换回默认', 2, messages)
      expect(turns(messages)[1].params.collaborationMode).toMatchObject({
        mode: 'default',
        settings: { reasoning_effort: 'xhigh' },
      })
    })
    it('turn/start 被拒绝时不记已带过：下一轮照样带 default', async () => {
      const failFile = join(root, 'turn-fail')
      const { session, messages } = setup(10_000, { env: { FAKE_CODEX_TURN_FAIL_FILE: failFile } })
      writeFileSync(failFile, '')
      await host!.send(session.id, '被拒绝')
      await wait(() => !existsSync(failFile) && host!.open(session.id).state === 'idle')
      expect(turns(messages)).toHaveLength(1)
      await send(session.id, '第二轮', 2, messages)
      expect(turns(messages)[0].params.collaborationMode).toMatchObject({ mode: 'default' })
      expect(turns(messages)[1].params.collaborationMode).toMatchObject({ mode: 'default' })
      await send(session.id, '第三轮', 3, messages)
      expect(turns(messages)[2].params.collaborationMode).toBeUndefined()
    })
    it('恢复线程：报的是计划模式就在需要时切回 default；报的是 default 照样带一次提问指令', async () => {
      const resumed = async (collab: unknown, opts: Parameters<typeof setup>[1] = {}) => {
        const { session, messages } = setup(50, {
          ...opts,
          env: { FAKE_CODEX_RESUME_COLLAB: JSON.stringify(collab), ...opts.env },
        })
        await send(session.id, '第一轮', 1, messages)
        // 空闲后进程退出，下一轮 thread/resume 接着原线程
        await new Promise(r => setTimeout(r, 200))
        await host!.update(session.id, { permissionMode: 'edits' })
        await send(session.id, '第二轮', 2, messages)
        expect(messages().some(m => m.method === 'thread/resume')).toBe(true)
        return turns(messages)[1].params.collaborationMode
      }
      const plan = { mode: 'plan', settings: { model: 'fake-codex', reasoning_effort: 'high' } }
      expect(await resumed(plan, { askQuestions: false })).toMatchObject({
        mode: 'default',
        settings: { model: 'fake-codex' },
      })
      await fresh()
      const held = { mode: 'default', settings: { model: 'fake-codex', reasoning_effort: 'high' } }
      expect(await resumed(held)).toMatchObject({ mode: 'default', settings: { reasoning_effort: 'high' } })
      await fresh()
      // 没开提问：线程里已有的 default 和现在一致就不带
      expect(await resumed(held, { askQuestions: false })).toBeUndefined()
    })
    it('恢复线程时线程里留着 default：没开提问也要在中途换模型后重新带，免得被旧的覆盖', async () => {
      const held = { mode: 'default', settings: { model: 'fake-codex', reasoning_effort: 'high' } }
      const { session, messages } = setup(50, {
        askQuestions: false,
        env: { FAKE_CODEX_RESUME_COLLAB: JSON.stringify(held) },
      })
      await send(session.id, '第一轮', 1, messages)
      await new Promise(r => setTimeout(r, 200))
      await host!.update(session.id, { model: 'fake-plain' })
      await send(session.id, '第二轮', 2, messages)
      expect(turns(messages)[1].params.collaborationMode).toMatchObject({
        mode: 'default',
        settings: { model: 'fake-plain', reasoning_effort: 'high' },
      })
    })
  })
  describe('Default 模式提问开关的兼容', () => {
    const flag = 'features.default_mode_request_user_input=true'
    const finish = async (session: { id: string }) => {
      await host!.send(session.id, '第一轮')
      await wait(() => host!.open(session.id).state === 'idle')
    }
    const codexWarnings = async () => (await host!.engines()).find(e => e.id === 'codex')!.configWarnings
    const notices = (id: string) => host!.open(id).items.filter(i => i.kind === 'notice')
    it('版本太老（读到的版本低于开关出现的版本）不带开关，也不带 default；读不到版本或够新照常带', async () => {
      expect(defaultModeAskSupported('0.109.0')).toBe(false)
      expect(defaultModeAskSupported('0.110.0')).toBe(true)
      expect(defaultModeAskSupported(CODEX_MIN_VERSION)).toBe(true)
      expect(defaultModeAskSupported(null)).toBe(true)
      const old = setup(50, { launch: { version: '0.109.0' } })
      await finish(old.session)
      expect(old.launches().flat()).not.toContain(flag)
      expect(old.messages().find(m => m.method === 'turn/start')?.params.collaborationMode).toBeUndefined()
      await fresh()
      const recent = setup(50, { launch: { version: '0.162.1' } })
      await finish(recent.session)
      expect(recent.launches().flat()).toContain(flag)
      expect(recent.messages().find(m => m.method === 'turn/start')?.params.collaborationMode).toMatchObject({
        mode: 'default',
      })
    })
    it('Codex 带着开关起不来：不带开关重试一次，这一轮正常完成、不带 default，之后重连也不再带开关', async () => {
      const { session, messages, launches } = setup(50, { env: { FAKE_CODEX_REJECT_ASK: '1' } })
      await finish(session)
      expect(launches().filter(args => args.includes(flag))).toHaveLength(1)
      expect(launches().at(-1)).not.toContain(flag)
      expect(host!.open(session.id).items.some(i => i.kind === 'turn_stats')).toBe(true)
      expect(notices(session.id)).toEqual([])
      expect(messages().find(m => m.method === 'turn/start')?.params.collaborationMode).toBeUndefined()
      // 空闲后进程退出，再发一轮重新启动（新会话对象，靠适配器记着）：不再带开关，共 4 次启动：检测探测、带开关、重试、第二轮
      await new Promise(r => setTimeout(r, 200))
      await host!.send(session.id, '第二轮')
      await wait(() => host!.open(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
      expect(launches().filter(args => args.includes(flag))).toHaveLength(1)
      expect(launches()).toHaveLength(4)
    })
    it('开关带来的警告整条去掉（包括开头带换行的），不进对话也不进设置里的配置提示', async () => {
      for (const kind of ['features', 'features-newline', 'ignored']) {
        const { session } = setup(50, { env: { FAKE_CODEX_ASK_WARNING: kind } })
        await finish(session)
        expect(notices(session.id), kind).toEqual([])
        expect(await codexWarnings(), kind).toBeUndefined()
        await fresh()
      }
    })
    it('不认识的设置项警告里只去掉开关那一行并减掉个数，用户自己的那条照常留着', async () => {
      const { session } = setup(50, { env: { FAKE_CODEX_ASK_WARNING: 'ignored-mixed' } })
      await finish(session)
      expect(await codexWarnings()).toEqual([
        'Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n' +
          '  user (config.toml): `disable_response_storage` is ignored.',
      ])
    })
    it('用户自己的 config.toml 或启动参数也开了同一个功能：警告原样留着', async () => {
      const warning = /^Under-development features enabled: default_mode_request_user_input\./
      const userConfig = setup(50, { env: { FAKE_CODEX_ASK_WARNING: 'features', FAKE_CODEX_USER_ASK: '1' } })
      await finish(userConfig.session)
      expect(await codexWarnings()).toEqual([expect.stringMatching(warning)])
      await fresh()
      const viaArgs = setup(50, {
        env: { FAKE_CODEX_ASK_WARNING: 'features' },
        launch: { args: ['-c', flag] },
      })
      await finish(viaArgs.session)
      expect(await codexWarnings()).toEqual([expect.stringMatching(warning)])
    })
  })
  it('配置类警告去掉像素星空自己打开的 Default 模式提问；只剩它时不报；不是我们加的原样留着', () => {
    const tail = ' Under-development features are incomplete and may behave unpredictably.'
    const only = `Under-development features enabled: default_mode_request_user_input.${tail}`
    expect(withoutOwnFeatures(only, true)).toBe(null)
    expect(withoutOwnFeatures(`\n${only}`, true)).toBe(null)
    expect(withoutOwnFeatures(only, false)).toBe(only)
    expect(
      withoutOwnFeatures(`Under-development features enabled: memories, default_mode_request_user_input.${tail}`, true),
    ).toBe(`Under-development features enabled: memories.${tail}`)
    // 开头的空白和 isQuietWarning 一样先去掉
    expect(withoutOwnFeatures(`\n  Under-development features enabled: memories.${tail}`, true)).toBe(
      `Under-development features enabled: memories.${tail}`,
    )
    expect(withoutOwnFeatures('Model metadata for `x` not found.', true)).toBe('Model metadata for `x` not found.')
    const own = '  session-flags: `features.default_mode_request_user_input` is ignored.'
    const user = '  user (config.toml): `x` is ignored.'
    const head = (n: number) => `Codex is ignoring ${n} unrecognized configuration setting${n === 1 ? '' : 's'}. Check.`
    expect(withoutOwnFeatures(`${head(1)}\n${own}`, true)).toBe(null)
    expect(withoutOwnFeatures(`\n${head(1)}\n${own}`, true)).toBe(null)
    expect(withoutOwnFeatures(`${head(1)}\n${own}`, false)).toBe(`${head(1)}\n${own}`)
    expect(withoutOwnFeatures(`${head(2)}\n${own}\n${user}`, true)).toBe(`${head(1)}\n${user}`)
    expect(withoutOwnFeatures(`${head(3)}\n${own}\n${user}\n${user}`, true)).toBe(`${head(2)}\n${user}\n${user}`)
    // 没有指向开关的行就原样留着
    expect(withoutOwnFeatures(`${head(1)}\n${user}`, true)).toBe(`${head(1)}\n${user}`)
  })
  it('Fast：自己的 openai 登录且模型有 priority 档位时每轮写明档位；换到没有档位的模型也能开，只提示可能不生效', async () => {
    const { session, messages } = setup(50, { env: { FAKE_CODEX_PROVIDER: 'openai' } })
    await host!.update(session.id, { fast: true })
    await host!.send(session.id, '快')
    await wait(() => host!.open(session.id).state === 'idle')
    expect(host!.open(session.id).flags).toMatchObject({ fastAvailable: true, fastState: 'on', fastBlocked: null })
    const start = () => messages().filter(m => m.method === 'turn/start')
    expect(start()[0].params.serviceTier).toBe('priority')
    expect(start()[0].params.collaborationMode).toMatchObject({ mode: 'default' })
    await host!.update(session.id, { fast: false })
    await host!.send(session.id, '慢一点')
    await wait(() => host!.open(session.id).state === 'idle' && start().length === 2)
    expect(start()[1].params.serviceTier).toBe('default')
    await host!.update(session.id, { fast: true, model: 'fake-plain' })
    await wait(() => host!.open(session.id).flags.fastBlocked === 'codex_unverified')
    expect(host!.open(session.id).flags).toMatchObject({ fastAvailable: true, fastState: 'on' })
    expect(host!.open(session.id).record.fast).toBe(true)
    await host!.send(session.id, '没有档位的模型')
    await wait(() => host!.open(session.id).state === 'idle' && start().length === 3)
    expect(start()[2].params.serviceTier).toBe('priority')
    // 拿不准时关掉不写 default，用 Codex 自己的配置
    await host!.update(session.id, { fast: false })
    await host!.send(session.id, '关掉')
    await wait(() => host!.open(session.id).state === 'idle' && start().length === 4)
    expect(start()[3].params.serviceTier).toBeUndefined()
  })
  it('Fast：provider 不是 openai（自己配的接口）时也能开，提示可能不生效，开着照样带档位', async () => {
    const { session, messages } = setup()
    await host!.update(session.id, { fast: true })
    await host!.send(session.id, '快')
    await wait(() => host!.open(session.id).state === 'idle')
    expect(host!.open(session.id).flags).toMatchObject({
      fastAvailable: true,
      fastState: 'on',
      fastBlocked: 'codex_unverified',
    })
    expect(host!.open(session.id).record.fast).toBe(true)
    expect(messages().find(m => m.method === 'turn/start')?.params.serviceTier).toBe('priority')
  })
  it('Fast：走平台 / 像素星空接口时也能开，提示看接口支不支持，开着照样带档位、关着不带', async () => {
    const { session, messages } = setup(50, {
      env: { PIXELSKY_CODEX_BASE_URL: 'http://127.0.0.1:9/v1', PIXELSKY_CODEX_TOKEN: 'tok' },
    })
    await host!.update(session.id, { provider: { id: 'my-api' }, fast: true })
    await host!.send(session.id, '快')
    await wait(() => host!.open(session.id).state === 'idle')
    expect(host!.open(session.id).flags).toMatchObject({
      fastAvailable: true,
      fastState: 'on',
      fastBlocked: 'codex_gateway',
    })
    expect(host!.open(session.id).record.fast).toBe(true)
    const start = () => messages().filter(m => m.method === 'turn/start')
    expect(start()[0].params.serviceTier).toBe('priority')
    await host!.update(session.id, { fast: false })
    await host!.send(session.id, '关掉')
    await wait(() => host!.open(session.id).state === 'idle' && start().length === 2)
    expect(start()[1].params.serviceTier).toBeUndefined()
  })
})

/** 跨引擎接力里的另一个引擎：收到消息就被打断，没有回复 */
class InterruptedClaude implements EngineAdapter {
  async info(): Promise<EngineInfo> {
    return { ...ENGINES.claude, status: 'ready', version: 'stub', path: 'stub', message: null }
  }
  createSession(ctx: SessionContext): EngineSession {
    return {
      send(_text, turnId) {
        ctx.emit({ type: 'turn_completed', turnId, outcome: 'interrupted', error: null })
      },
      async interrupt() {},
      answer() {},
      async update() {},
      async close() {},
    }
  }
}

describe('Codex 接手带图片的聊天', () => {
  const png = (name: string): ImageAttachment => ({
    id: name.replace(/\W/g, '-'),
    name,
    mediaType: 'image/png',
    bytes: 16,
    width: 1,
    height: 1,
    dataBase64: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8, name.length)]).toString(
      'base64',
    ),
  })
  const url = (image: ImageAttachment) => `data:image/png;base64,${image.dataBase64}`
  const ASKED = '这个地方显示的内容不对'
  /** 引擎发的警告提示 */
  const notices = (id: string) =>
    host!.open(id).items.flatMap(i => (i.kind === 'notice' && i.level === 'warn' ? [i.text] : []))
  type Rpc = { method?: string; params?: { items?: { role: string; content: Record<string, unknown>[] }[] } }

  /** claude 先收到一条带图的消息，被打断没有回复；再换成 Codex 发下一条 */
  async function handoff(model: string, env: Record<string, string>, next: ImageAttachment[] | undefined) {
    const log = join(root, 'rpc.jsonl')
    const adapter = new CodexAdapter({
      launcher: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fakes/fake-codex.mjs', import.meta.url))],
      },
      env: { ...process.env, FAKE_CODEX_LOG: log, ...env },
      launchOptions: () => ({ askQuestions: true, steeringValidated: true }),
    })
    host = new EngineHost({
      dataDir: join(root, 'engine'),
      adapters: { claude: new InterruptedClaude(), codex: adapter },
      emit: () => {},
      idleMs: 60_000,
    })
    const session = host.createSession({
      projectId: host.addProject(root).id,
      engine: 'claude',
      model: 'm',
      effort: 'high',
      permissionMode: 'ask',
    })
    const idle = () => host!.open(session.id).state === 'idle' && host!.open(session.id).queue.length === 0
    const old = png('old.png')
    await host.send(session.id, { text: ASKED, clientMessageId: 'first', attachments: [old] })
    await wait(() => host!.open(session.id).items.some(i => i.kind === 'user') && idle())
    await host.update(session.id, { engine: 'codex', model })
    await host.send(session.id, { text: '怎么样', clientMessageId: 'second', ...(next ? { attachments: next } : {}) })
    await wait(() => host!.open(session.id).items.some(i => i.kind === 'turn_stats') && idle())
    const messages = (): Rpc[] =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
    return { old, session, messages }
  }

  it('注入线程的用户消息带 input_image，回复占位仍在，开轮的输入只有这条消息自己', async () => {
    const { old, messages } = await handoff('fake-codex', {}, undefined)
    const inject = messages().find(m => m.method === 'thread/inject_items')!
    expect(inject.params!.items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: `${ASKED}（附：old.png）` },
          { type: 'input_image', image_url: url(old) },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '（这一轮没有回复，可能被中断了）' }],
      },
    ])
    const start = messages().find(m => m.method === 'turn/start') as { params: { input: unknown[] } }
    expect(start.params.input).toEqual([{ type: 'text', text: '怎么样', text_elements: [] }])
  })

  it('模型不能看图（目录里查得到）：host 就不交图片，注入的文字写明没带上，也不用会话再警告，不报错', async () => {
    const { session, messages } = await handoff('fake-plain', {}, undefined)
    const inject = messages().find(m => m.method === 'thread/inject_items')!
    expect(inject.params!.items![0].content).toEqual([{ type: 'input_text', text: `${ASKED}（附图 old.png，未带上）` }])
    expect(host!.open(session.id).items.some(i => i.kind === 'notice' && i.level === 'error')).toBe(false)
    expect(notices(session.id)).toEqual([])
  })

  it('目录里没有这个模型：host 按引擎能力交了图片，会话这边兜底不带，并告诉用户实际没带', async () => {
    const { session, messages } = await handoff('fake-unlisted', {}, undefined)
    const inject = messages().find(m => m.method === 'thread/inject_items')!
    expect(inject.params!.items![0].content).toEqual([
      { type: 'input_text', text: `${ASKED}（附：old.png）（上面这些图片没有带上：当前模型不能看图）` },
    ])
    expect(host!.open(session.id).items.some(i => i.kind === 'notice' && i.level === 'error')).toBe(false)
    expect(notices(session.id)).toEqual([
      "The current model can't view images, so 1 earlier image(s) were not actually passed along",
    ])
  })

  it('注入失败退回文字交接：更早消息的图片排在消息自己的图片前面一起发', async () => {
    const own = png('own.png')
    const { old, messages } = await handoff('fake-codex', { FAKE_CODEX_INJECT_FAIL: '1' }, [own])
    const start = messages().find(m => m.method === 'turn/start') as {
      params: { input: { type: string; text?: string; url?: string }[] }
    }
    const input = start.params.input
    expect(input.map(i => i.type)).toEqual(['text', 'image', 'image'])
    expect(input[0].text).toContain(`下面第 1 张图是之前「${ASKED}」那条消息附的 old.png`)
    expect(input[0].text!.endsWith('\n\n怎么样')).toBe(true)
    expect(input.slice(1).map(i => i.url)).toEqual([url(old), url(own)])
  })

  it('注入失败且模型不能看图（目录里查得到）：只发文字交接，不带图片，不用会话再警告也不报错', async () => {
    const { session, messages } = await handoff('fake-plain', { FAKE_CODEX_INJECT_FAIL: '1' }, undefined)
    const start = messages().find(m => m.method === 'turn/start') as { params: { input: { type: string }[] } }
    expect(start.params.input.map(i => i.type)).toEqual(['text'])
    expect(notices(session.id).filter(t => t.includes('view images'))).toEqual([])
  })

  it('注入失败且目录里没有这个模型：会话兜底只发文字交接，不带图片，告诉用户实际没带', async () => {
    const { session, messages } = await handoff('fake-unlisted', { FAKE_CODEX_INJECT_FAIL: '1' }, undefined)
    const start = messages().find(m => m.method === 'turn/start') as { params: { input: { type: string }[] } }
    expect(start.params.input.map(i => i.type)).toEqual(['text'])
    expect(notices(session.id).filter(t => t.includes('view images'))).toEqual([
      "The current model can't view images, so 1 earlier image(s) were not actually passed along",
    ])
  })
})
