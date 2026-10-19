import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EngineHost, PixelAdapter } from '../src'
import type { EngineInfo, HostEvent } from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, SessionContext } from '../src/adapter'
import { ENGINES } from '../src/registry'
import { PIXEL_MODES, pixelModelsConfig, reservedPixelArg, searchToolArgs } from '../src/pixel/session'
import { modelEfforts } from '../src/pixel/catalog'
import { makeTmp, removeTmp } from './helpers/tmp'

const FAKE = fileURLToPath(new URL('./fakes/fake-pixel.mjs', import.meta.url))
let root: string, host: EngineHost | undefined
beforeEach(() => {
  root = makeTmp('pixel-test')
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
  throw new Error('Pixel test timed out')
}
/**
 * 本机装的 coding agent 可能在环境里留着 ANTHROPIC_BASE_URL 之类的变量：那些会让 Pixel 会话多带一份 provider 配置，
 * 断言就跟着变。这里清掉，需要哪个用例自己按 extra 给。
 */
function pixelEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (/^(ANTHROPIC|OPENAI)_/i.test(key) || /^PIXELSKY_PIXEL_/i.test(key)) delete env[key]
  return env
}
function setup(idleMs = 50, extra: Record<string, unknown> = {}, hostExtra: Record<string, unknown> = {}) {
  const log = join(root, 'rpc.jsonl'),
    argv = join(root, 'argv.jsonl'),
    events: HostEvent[] = []
  const adapter = new PixelAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    env: { ...pixelEnv(), FAKE_PIXEL_LOG: log, FAKE_PIXEL_ARGV: argv, FAKE_PIXEL_DIR: join(root, 'sessions') },
    ...extra,
  } as never)
  host = new EngineHost({
    dataDir: join(root, 'engine'),
    adapters: { pixel: adapter },
    emit: e => events.push(e),
    idleMs,
    ...hostExtra,
  })
  const session = host.createSession({
    projectId: host.addProject(root).id,
    engine: 'pixel',
    model: 'fake/fake-pixel',
    effort: 'high',
    permissionMode: 'ask',
  })
  const lines = (file: string) =>
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l))
      : []
  return { adapter, session, events, messages: () => lines(log), argvs: () => lines(argv) }
}
const snap = (id: string) => host!.open(id)
const idle = (id: string) => snap(id).state === 'idle'

describe('Pixel 引擎适配器', () => {
  it('发现：PIXELSKY_CLI_BIN 优先于自带入口；脚本入口用 node 启动并带 ELECTRON_RUN_AS_NODE', async () => {
    const env = { ...process.env, PIXELSKY_CLI_BIN: FAKE, FAKE_PIXEL_ARGV: join(root, 'a.jsonl') }
    const a = new PixelAdapter({ env, bundledCli: join(root, 'missing.ts') })
    const info = await a.info()
    expect(info).toMatchObject({ id: 'pixel', status: 'ready', version: '1.2.0', path: FAKE })
    const entry = readFileSync(join(root, 'a.jsonl'), 'utf8').trim().split('\n')[0]
    expect(JSON.parse(entry).electron).toBe('1')
    // 没有 PIXELSKY_CLI_BIN 时用自带入口
    const b = new PixelAdapter({ env: { ...process.env, PIXELSKY_CLI_BIN: '' }, bundledCli: FAKE })
    expect((await b.info()).path).toBe(FAKE)
    // 都没有：PATH 上也没有 pixelsky
    const c = new PixelAdapter({ env: { ...process.env, PIXELSKY_CLI_BIN: '', PATH: root, Path: root } })
    expect((await c.info()).status).toBe('missing')
    // 用户替换的命令找不到：直接报，不换成别的
    const d = new PixelAdapter({ env, overridePath: () => join(root, 'nope.mjs') })
    expect((await d.info()).status).toBe('missing')
  })
  it('checkLaunch 拒绝像素星空自己控制的参数', () => {
    const a = new PixelAdapter({ env: process.env })
    expect(() => a.checkLaunch(null, ['--mode=json'])).toThrow()
    expect(() => a.checkLaunch(null, ['--verbose'])).not.toThrow()
    expect(reservedPixelArg(['--permission-mode', 'plan'])).toBe('--permission-mode')
  })
  it('目录：provider/id 的模型和各自的强度', async () => {
    const { adapter } = setup()
    await adapter.info()
    const catalog = await adapter.catalog()
    expect(catalog.models?.map(m => m.id)).toEqual(['fake/fake-pixel', 'fake/fake-small'])
    expect(catalog.models?.[0].efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(catalog.models?.[1].efforts).toEqual([])
    expect(catalog.currentModel).toBe('fake/fake-pixel')
    expect(modelEfforts({ reasoning: true, thinkingLevelMap: { low: null, max: 'max' } })).toEqual([
      'medium',
      'high',
      'max',
    ])
  })
  it('一轮：文字、思考、命令、改文件、待办、用量，并带上启动参数和模型强度', async () => {
    const { session, messages, argvs } = setup()
    await host!.send(session.id, '工具')
    await wait(() => snap(session.id).items.some(i => i.kind === 'turn_stats'))
    const items = snap(session.id).items
    expect(items.find(i => i.kind === 'reasoning')).toMatchObject({ text: '想一想', status: 'completed' })
    const commands = items.filter(i => i.kind === 'command')
    expect(commands[0]).toMatchObject({ command: 'ls', output: 'a.txt\nb.txt', exitCode: 0, status: 'completed' })
    expect(commands[1]).toMatchObject({ command: 'false', exitCode: 2, status: 'failed' })
    const changes = items.filter(i => i.kind === 'file_change')
    expect(changes[0]).toMatchObject({
      status: 'completed',
      changes: [{ path: 'a.txt', kind: 'update', diff: '@@ -1,1 +1,1 @@\n-hello\n+hi', added: 1, removed: 1 }],
    })
    expect(changes[1]).toMatchObject({ changes: [{ path: 'new-file.txt', kind: 'add', added: 2 }] })
    expect(items.find(i => i.kind === 'todo')).toMatchObject({
      status: 'completed',
      steps: [
        { text: '第一步', status: 'completed' },
        { text: '第二步', status: 'in_progress' },
      ],
    })
    expect(items.find(i => i.kind === 'tool')).toMatchObject({ tool: 'read', name: 'read', title: 'a.txt' })
    const stats = items.find(i => i.kind === 'turn_stats')
    expect(stats).toMatchObject({ outcome: 'completed' })
    expect(snap(session.id).usage?.contextWindow).toBe(200000)
    expect(snap(session.id).usage?.costUsd).toBeGreaterThan(0.005)
    expect(argvs()[0].argv).toEqual(['--mode', 'rpc', '--permission-mode', 'default', '--tools', '+grep,+find,+ls'])
    const log = messages()
    expect(log.find(m => m.type === 'set_model')).toMatchObject({ provider: 'fake', modelId: 'fake-pixel' })
    expect(log.find(m => m.type === 'set_thinking_level')).toMatchObject({ level: 'high' })
    expect(snap(session.id).record.engineSessionId).toMatch(/session-\d+\.jsonl$/)
    expect(snap(session.id).commands?.map(c => c.name)).toEqual(['compact', 'skill:probe'])
  })
  it('批准：允许和拒绝都往返，拒绝的命令显示已拒绝', async () => {
    const { session, messages } = setup()
    await host!.send(session.id, '审批')
    await wait(() => snap(session.id).pending.length === 1)
    const request = snap(session.id).pending[0]
    expect(request).toMatchObject({ kind: 'command', command: 'rm x', alwaysScopes: [] })
    expect(request.itemId).toBeTruthy()
    host!.answer(session.id, request.requestId, { type: 'allow' })
    await wait(() => idle(session.id) && snap(session.id).items.some(i => i.kind === 'turn_stats'))
    expect(messages().find(m => m.type === 'extension_ui_response')).toMatchObject({ confirmed: true })
    expect(snap(session.id).items.find(i => i.kind === 'command')).toMatchObject({ status: 'completed' })
    await host!.send(session.id, '审批')
    await wait(() => snap(session.id).pending.length === 1)
    host!.answer(session.id, snap(session.id).pending[0].requestId, { type: 'deny' })
    await wait(() => snap(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    const denied = snap(session.id).items.filter(i => i.kind === 'command')[1]
    expect(denied).toMatchObject({ status: 'declined' })
    expect(snap(session.id).pending).toEqual([])
  })
  it('批准（三选一）：卡片带「本会话」始终允许，三种决定各回对应的选项原文', async () => {
    const { session, messages } = setup()
    const answers: string[] = []
    for (const decision of [{ type: 'allow_always', scope: 'session' }, { type: 'allow' }, { type: 'deny' }] as const) {
      await host!.send(session.id, '三选一')
      await wait(() => snap(session.id).pending.length === 1)
      const request = snap(session.id).pending[0]
      expect(request).toMatchObject({ kind: 'command', command: 'rm y', alwaysScopes: ['session'] })
      host!.answer(session.id, request.requestId, decision)
      await wait(() => snap(session.id).pending.length === 0 && idle(session.id))
      answers.push(
        messages()
          .filter(m => m.type === 'extension_ui_response')
          .pop().value,
      )
    }
    expect(answers).toEqual(['本会话不再询问 / Always allow in this session', '允许 / Allow', '拒绝 / Deny'])
    expect(
      snap(session.id)
        .items.filter(i => i.kind === 'command')
        .pop(),
    ).toMatchObject({ status: 'declined' })
  })
  it('同一条消息里两条命令：第二张卡挂第二条，不会挂回已经批准、还在跑的第一条', async () => {
    const { session } = setup()
    await host!.send(session.id, '两条命令')
    await wait(() => snap(session.id).pending.length === 1)
    const first = snap(session.id).pending[0]
    expect(first).toMatchObject({ kind: 'command', command: 'rm a' })
    host!.answer(session.id, first.requestId, { type: 'allow' })
    await wait(() => snap(session.id).pending.length === 1 && snap(session.id).pending[0].requestId !== first.requestId)
    const second = snap(session.id).pending[0]
    expect(second).toMatchObject({ kind: 'command', command: 'rm b' })
    expect(second.itemId).not.toBe(first.itemId)
    expect(snap(session.id).items.find(i => i.id === second.itemId)).toMatchObject({ command: 'rm b' })
    host!.answer(session.id, second.requestId, { type: 'deny' })
    await wait(() => idle(session.id))
    const commands = snap(session.id).items.filter(i => i.kind === 'command')
    expect(commands.map(c => [c.kind === 'command' && c.command, 'status' in c && c.status])).toEqual([
      ['rm a', 'completed'],
      ['rm b', 'failed'],
    ])
  })
  it('子智能体转来的审批：卡片按子进程里的参数显示改动，挂在 task 条目上', async () => {
    const { session, messages } = setup()
    await host!.send(session.id, '子智能体审批')
    await wait(() => snap(session.id).pending.length === 1)
    const request = snap(session.id).pending[0]
    expect(request).toMatchObject({ kind: 'file_change', alwaysScopes: ['session'] })
    expect(request.changes?.[0]).toMatchObject({ path: 'child.txt', kind: 'add' })
    expect(request.changes?.[0].diff).toContain('+from child')
    expect(snap(session.id).items.find(i => i.id === request.itemId)).toMatchObject({ kind: 'tool', name: 'Agent' })
    host!.answer(session.id, request.requestId, { type: 'allow_always', scope: 'session' })
    await wait(() => idle(session.id))
    expect(
      messages()
        .filter(m => m.type === 'extension_ui_response')
        .pop().value,
    ).toBe('本会话不再询问 / Always allow in this session')
  })
  it('桌面端管理的扩展：MCP 文件和免批准工具走环境变量，技能每个目录一个 --skill', async () => {
    const skill = join(root, 'skills', 'review')
    const { session, argvs } = setup(
      50,
      {},
      {
        extensions: () => ({
          key: 'ext',
          pluginDirs: [],
          pathDirs: [],
          skillRoots: [skill],
          mcpFile: join(root, 'mcp.json'),
          allowTools: ['mcp__pixelsky_history'],
        }),
      },
    )
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id) && argvs().length > 0)
    const launch = argvs()[0]
    expect(launch.mcpFile).toBe(join(root, 'mcp.json'))
    expect(launch.allowTools).toBe('mcp__pixelsky_history')
    expect(launch.argv.slice(launch.argv.indexOf('--skill'), launch.argv.indexOf('--skill') + 2)).toEqual([
      '--skill',
      skill,
    ])
  })
  it('计划模式：exit_plan_mode 变成计划卡片；开始执行后跟着命令行退出计划模式，继续完善算已拒绝', async () => {
    const { session, messages } = setup()
    await host!.update(session.id, { permissionMode: 'plan' })
    await host!.send(session.id, '交计划')
    await wait(() => snap(session.id).pending.length === 1)
    const request = snap(session.id).pending[0]
    expect(request).toMatchObject({ kind: 'plan', plan: '# 改登录\n1. 改 a.ts', alwaysScopes: [] })
    expect(request.itemId).toBeTruthy()
    expect(snap(session.id).items.find(i => i.id === request.itemId)).toMatchObject({
      kind: 'tool',
      name: 'ExitPlanMode',
      title: '改登录',
      output: '# 改登录\n1. 改 a.ts',
    })
    host!.answer(session.id, request.requestId, { type: 'deny' })
    await wait(() => idle(session.id) && snap(session.id).pending.length === 0)
    expect(
      messages()
        .filter(m => m.type === 'extension_ui_response')
        .pop(),
    ).toMatchObject({
      value: '继续完善计划 / Keep planning',
    })
    expect(snap(session.id).items.find(i => i.id === request.itemId)).toMatchObject({ status: 'declined' })
    expect(host!.record(session.id)?.permissionMode).toBe('plan')

    await host!.send(session.id, '交计划')
    await wait(() => snap(session.id).pending.length === 1)
    host!.answer(session.id, snap(session.id).pending[0].requestId, { type: 'allow' })
    await wait(() => idle(session.id) && host!.record(session.id)?.permissionMode === 'ask')
    expect(
      messages()
        .filter(m => m.type === 'extension_ui_response')
        .pop(),
    ).toMatchObject({
      value: '开始执行 / Start implementing',
    })
    // 命令行自己换的模式：适配器不再发 /pixelsky-mode
    expect(messages().filter(m => m.type === 'prompt' && m.message === '/pixelsky-mode default')).toHaveLength(0)
  })
  it('停止：abort 后这一轮以 interrupted 结束；等批准时停止也行', async () => {
    const { session, messages, events } = setup(60_000)
    await host!.send(session.id, '慢')
    await wait(() => snap(session.id).items.some(i => i.kind === 'assistant'))
    await host!.interrupt(session.id)
    expect(idle(session.id)).toBe(true)
    expect(messages().some(m => m.type === 'abort')).toBe(true)
    const outcomes = () =>
      events.flatMap(e => (e.kind === 'session' && e.event.type === 'turn_completed' ? [e.event.outcome] : []))
    expect(outcomes()).toEqual(['interrupted'])
    host!.resumeQueue(session.id)
    await host!.send(session.id, '审批')
    await wait(() => snap(session.id).pending.length === 1)
    await host!.interrupt(session.id)
    expect(snap(session.id).pending).toEqual([])
    expect(outcomes()).toEqual(['interrupted', 'interrupted'])
    expect(
      messages()
        .filter(m => m.type === 'extension_ui_response')
        .pop(),
    ).toMatchObject({ cancelled: true })
  })
  it('引导：steer 命令，交付后确认；排队消息变成对话里的用户消息', async () => {
    const { session, messages } = setup()
    await host!.send(session.id, '慢')
    await wait(
      () => snap(session.id).flags.steerAvailable === true && snap(session.id).items.some(i => i.kind === 'assistant'),
    )
    const receipt = await host!.send(session.id, { text: '追加要求', clientMessageId: 'guidance-1' })
    await host!.steerQueued(session.id, receipt.queueId, snap(session.id).turnId!)
    await wait(() => snap(session.id).items.some(i => i.kind === 'turn_stats'))
    expect(messages().find(m => m.type === 'steer')).toMatchObject({ message: '追加要求' })
    expect(snap(session.id).items.filter(i => i.kind === 'user' && i.text === '追加要求')).toHaveLength(1)
  })
  it('续接：空闲关掉进程后再发消息，用 switch_session 接上会话文件', async () => {
    const { session, messages, argvs } = setup(50)
    await host!.send(session.id, 'first')
    await wait(() => snap(session.id).items.some(i => i.kind === 'turn_stats'))
    const file = snap(session.id).record.engineSessionId!
    expect(existsSync(file)).toBe(true)
    await new Promise(r => setTimeout(r, 200))
    await host!.send(session.id, 'second')
    await wait(() => snap(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    expect(argvs()).toHaveLength(2)
    expect(messages().find(m => m.type === 'switch_session')).toMatchObject({ sessionPath: file })
    expect(snap(session.id).items.filter(i => i.kind === 'user')).toHaveLength(2)
    expect(snap(session.id).items.filter(i => i.kind === 'notice')).toEqual([])
  })
  it('续接：会话文件没了就新开并提示', async () => {
    const { session } = setup(50)
    await host!.send(session.id, 'first')
    await wait(() => snap(session.id).items.some(i => i.kind === 'turn_stats'))
    const file = snap(session.id).record.engineSessionId!
    writeFileSync(join(root, 'marker'), '')
    host!.open(session.id)
    await new Promise(r => setTimeout(r, 200))
    const { rmSync } = await import('node:fs')
    rmSync(file)
    await host!.send(session.id, 'second')
    await wait(() => snap(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    expect(snap(session.id).items.filter(i => i.kind === 'notice')).toEqual([
      expect.objectContaining({ level: 'warn', text: expect.stringContaining('Could not resume') }),
    ])
  })
  it('进程崩溃：这一轮以 failed 结束并带 stderr 原因', async () => {
    const { session } = setup()
    await host!.send(session.id, '崩溃')
    await wait(() => idle(session.id) && snap(session.id).record.lastOutcome === 'failed')
    expect(snap(session.id).record.lastError).toContain('fake pixel crashed')
  })
  it('模型报错：agent_settled 后以 failed 结束并显示原因', async () => {
    const { session } = setup()
    await host!.send(session.id, '错误')
    await wait(() => idle(session.id) && snap(session.id).record.lastOutcome === 'failed')
    expect(snap(session.id).record.lastError).toContain('529 overloaded')
    expect(snap(session.id).items.find(i => i.kind === 'notice')).toMatchObject({ level: 'error' })
  })
  it('运行中切换权限模式、模型和强度', async () => {
    const { session, messages } = setup(60_000)
    await host!.send(session.id, 'first')
    await wait(() => snap(session.id).items.some(i => i.kind === 'turn_stats'))
    await host!.update(session.id, { permissionMode: 'full', model: 'fake/fake-small', effort: 'low' })
    const log = messages()
    expect(log.find(m => m.type === 'prompt' && m.message.startsWith('/pixelsky-mode'))).toMatchObject({
      message: '/pixelsky-mode bypassPermissions',
    })
    expect(log.filter(m => m.type === 'set_model').pop()).toMatchObject({ modelId: 'fake-small' })
    expect(log.filter(m => m.type === 'set_thinking_level').pop()).toMatchObject({ level: 'low' })
    expect(PIXEL_MODES).toEqual({ ask: 'default', edits: 'acceptEdits', plan: 'plan', full: 'bypassPermissions' })
  })
  it('重试、压缩和手动 /compact', async () => {
    const { session, messages } = setup(60_000)
    await host!.send(session.id, '压缩')
    await wait(() => snap(session.id).items.some(i => i.kind === 'turn_stats'))
    expect(snap(session.id).items.find(i => i.kind === 'compaction')).toMatchObject({
      status: 'completed',
      trigger: 'auto',
      preTokens: 150000,
      postTokens: 3000,
    })
    await host!.send(session.id, '重试')
    await wait(() => snap(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    expect(snap(session.id).retry ?? null).toBeNull()
    await host!.send(session.id, '/compact')
    await wait(() => messages().some(m => m.type === 'compact'))
    await wait(() => idle(session.id))
    expect(snap(session.id).items.filter(i => i.kind === 'compaction')).toHaveLength(2)
  })
  it('网关会话：provider 配置走环境变量交给命令行（不含密钥），配置目录不换，密钥只走环境变量，不带本机的 ANTHROPIC_API_KEY', async () => {
    const { session, argvs } = setup(50, {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'sk-local',
        FAKE_PIXEL_ARGV: join(root, 'argv.jsonl'),
        FAKE_PIXEL_LOG: join(root, 'rpc.jsonl'),
        FAKE_PIXEL_DIR: join(root, 'sessions'),
      },
      sessionEnv: () => ({ PIXELSKY_PIXEL_BASE_URL: 'http://127.0.0.1:9/v1', PIXELSKY_PIXEL_TOKEN: 'secret-1' }),
    })
    await host!.update(session.id, { platform: { groupId: '1', account: 'a@b.c' }, model: 'fake/fake-pixel' })
    await host!.send(session.id, 'hi').catch(() => {})
    await wait(() => argvs().length === 1)
    const launch = argvs()[0]
    expect(launch.token).toBe('secret-1')
    expect(launch.anthropicKey).toBeNull()
    expect(launch.argv).not.toContain('--session-dir')
    expect(launch.agentDir).toBeNull()
    expect(launch.providers.pixelsky).toMatchObject({
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'anthropic-messages',
      apiKey: '$PIXELSKY_PIXEL_TOKEN',
    })
    expect(JSON.stringify(launch.providers)).not.toContain('secret-1')
  })
  it('默认再开 grep / find / ls；用户自己选了工具就不加', async () => {
    expect(searchToolArgs([])).toEqual(['--tools', '+grep,+find,+ls'])
    expect(searchToolArgs(['--tools', 'read,bash'])).toEqual([])
    expect(searchToolArgs(['--no-builtin-tools'])).toEqual([])
    expect(searchToolArgs(['-t=read'])).toEqual([])
    const { session, argvs } = setup()
    await host!.send(session.id, 'hi').catch(() => {})
    await wait(() => argvs().length === 1)
    expect(argvs()[0].argv.join(' ')).toContain('--tools +grep,+find,+ls')
  })
  it('provider 配置生成：网关、用户自己的 ANTHROPIC_BASE_URL / OPENAI_BASE_URL、什么都没有', () => {
    expect(pixelModelsConfig({}, null)).toBeNull()
    expect(pixelModelsConfig({ ANTHROPIC_BASE_URL: 'https://relay.example/' }, null)).toEqual({
      providers: { anthropic: { baseUrl: 'https://relay.example/' } },
    })
    const gateway = pixelModelsConfig(
      { PIXELSKY_PIXEL_BASE_URL: 'http://x', PIXELSKY_PIXEL_API: 'openai-responses', PIXELSKY_PIXEL_MODELS: '["m1"]' },
      'pixelsky/m2',
    ) as { providers: { pixelsky: { models: Array<{ id: string }>; api: string } } }
    expect(gateway.providers.pixelsky.models.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(gateway.providers.pixelsky.api).toBe('openai-responses')
  })
})

describe('Pixel 接手带图片的聊天', () => {
  const png = (name: string) => ({
    id: name.replace(/\W/g, '-'),
    name,
    mediaType: 'image/png' as const,
    bytes: 16,
    width: 1,
    height: 1,
    dataBase64: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8)]).toString('base64'),
  })
  /** 另一个引擎：收到消息就被打断，没有回复 */
  const interrupted: EngineAdapter = {
    async info(): Promise<EngineInfo> {
      return { ...ENGINES.claude, status: 'ready', version: 'stub', path: 'stub', message: null }
    },
    createSession(ctx: SessionContext): EngineSession {
      return {
        send: (_text, turnId) => ctx.emit({ type: 'turn_completed', turnId, outcome: 'interrupted', error: null }),
        async interrupt() {},
        answer() {},
        async update() {},
        async close() {},
      }
    },
  }
  async function handoff(model: string, own = false) {
    const log = join(root, 'rpc.jsonl')
    const adapter = new PixelAdapter({
      launcher: { command: process.execPath, args: [FAKE] },
      env: { ...process.env, FAKE_PIXEL_LOG: log, FAKE_PIXEL_DIR: join(root, 'sessions') },
    } as never)
    host = new EngineHost({
      dataDir: join(root, 'engine'),
      adapters: { claude: interrupted, pixel: adapter },
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
    await host.send(session.id, { text: '看这个', clientMessageId: 'first', attachments: [png('old.png')] })
    await wait(() => snap(session.id).items.some(i => i.kind === 'user') && idle(session.id))
    await host.update(session.id, { engine: 'pixel', model })
    await host.send(session.id, {
      text: '怎么样',
      clientMessageId: 'second',
      ...(own ? { attachments: [png('own.png')] } : {}),
    })
    await wait(() => snap(session.id).items.filter(i => i.kind === 'user').length === 2 && idle(session.id))
    const prompt = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
      .findLast(m => m.type === 'prompt')
    return { session, prompt }
  }

  it('文字交接：更早消息的图片排在消息自己的图片前面一起发', async () => {
    const { prompt } = await handoff('fake/fake-pixel', true)
    expect(prompt.message).toContain('下面第 1 张图是之前「看这个」那条消息附的 old.png')
    expect(prompt.images.map((i: { data: string }) => i.data)).toEqual([
      png('old.png').dataBase64,
      png('own.png').dataBase64,
    ])
  })

  it('模型不能看图：宿主按目录里的模型就不带更早消息的图片，只写未带上，不再先说带了又更正，也不报错', async () => {
    const { session, prompt } = await handoff('fake/fake-small')
    expect(prompt.images).toBeUndefined()
    const notices = snap(session.id).items.flatMap(i => (i.kind === 'notice' ? [i.text] : []))
    expect(notices).toContain('已把之前的对话交接给 像素星空（1 条，1 张图片未带上）')
    expect(notices.some(text => text.includes('当前模型不能看图') || text.includes("can't view images"))).toBe(false)
    expect(notices.some(text => text.includes('含 1 张图片'))).toBe(false)
    expect(snap(session.id).items.some(i => i.kind === 'notice' && i.level === 'error')).toBe(false)
    expect(snap(session.id).items.filter(i => i.kind === 'user')).toHaveLength(2)
  })
})
