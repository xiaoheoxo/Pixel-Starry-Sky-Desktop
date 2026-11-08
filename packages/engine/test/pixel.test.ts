import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EngineHost, PixelAdapter } from '../src'
import type { EngineInfo, HostEvent } from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession, SessionContext } from '../src/adapter'
import { ENGINES } from '../src/registry'
import { PIXEL_MODES, pixelModelsConfig, reservedPixelArg, mcpWaiterFor, searchToolArgs } from '../src/pixel/session'
import { effortsFromLevels, findModel, modelEfforts } from '../src/pixel/catalog'
import { gitBashDir, pixelShell, windowsBash } from '../src/pixel/discover'
import { makeTmp, removeTmp } from './helpers/tmp'
import { answerOf, copyCompleteLines, pixelSideArgs, pixelSideModel, sideUserArgs } from '../src/pixel/side'

const NL = String.fromCharCode(10)

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
    shell: () => ({}),
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
  it('速度配置被 CLI 拒绝时回退，并把错误传给界面', async () => {
    const { session } = setup(10_000, {
      env: { ...pixelEnv(), FAKE_PIXEL_SPEED: '1', FAKE_PIXEL_SPEED_FAIL: 'fast', FAKE_PIXEL_DIR: root },
    })
    await host!.send(session.id, '第一轮')
    await wait(() => idle(session.id))
    await expect(host!.update(session.id, { fast: true })).rejects.toThrow('Rejected speed')
    expect(snap(session.id).record.fast).toBe(false)
    expect(snap(session.id).flags.fastPending).toBe(false)
  })

  it('换到不支持的模型清掉 UltraFast，换回来不自动恢复', async () => {
    const { session } = setup(10_000, { env: { ...pixelEnv(), FAKE_PIXEL_SPEED: '1', FAKE_PIXEL_DIR: root } })
    await host!.update(session.id, { fast: true, ultrafast: true })
    await host!.send(session.id, '第一轮')
    await wait(() => idle(session.id))
    await host!.update(session.id, { model: 'fake/fake-small' })
    expect(snap(session.id).record).toMatchObject({ fast: false, ultrafast: false })
    await host!.update(session.id, { model: 'fake/fake-pixel' })
    expect(snap(session.id).record).toMatchObject({ fast: false, ultrafast: false })
  })

  it('速度在发送前应用，运行中更改留到下一轮，关闭后明确发送普通档', async () => {
    const { session, messages } = setup(10_000, {
      env: { ...pixelEnv(), FAKE_PIXEL_SPEED: '1', FAKE_PIXEL_LOG: join(root, 'rpc.jsonl'), FAKE_PIXEL_DIR: root },
    })
    await host!.update(session.id, { fast: true, ultrafast: true })
    await host!.send(session.id, '慢')
    await wait(() => messages().some(m => m.type === 'prompt' && m.message === '慢'))
    const speedCommands = () => messages().filter(m => m.type === 'prompt' && m.message.startsWith('/pixelsky-speed '))
    expect(speedCommands().at(-1).message).toMatch(/^\/pixelsky-speed ultrafast /)
    await host!.update(session.id, { fast: false })
    expect(snap(session.id).flags.fastPending).toBe(true)
    expect(speedCommands().at(-1).message).toMatch(/^\/pixelsky-speed ultrafast /)
    await host!.interrupt(session.id)
    await wait(() => idle(session.id))
    await host!.send(session.id, '第二轮')
    await wait(() => idle(session.id))
    expect(speedCommands().at(-1).message).toMatch(/^\/pixelsky-speed off /)
    expect(snap(session.id).record.ultrafast).toBe(false)
    expect(snap(session.id).flags.fastPending).toBe(false)
  })

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
    expect(await c.info()).toMatchObject({ status: 'missing', message: expect.stringContaining('PIXELSKY_CLI_BIN') })
    // 安装包自带的命令行不见了：中文说明，让用户重装
    const lost = new PixelAdapter({
      env: { ...process.env, PIXELSKY_CLI_BIN: '', PATH: root, Path: root },
      bundledCli: join(root, 'resources', 'cli.mjs'),
    })
    expect((await lost.info()).message).toMatch(/没有找到像素星空自带的命令行.*请重新安装像素星空/)
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
  it('旁聊：复制会话文件单独问一次，不用工具、不带 MCP，原会话文件不变、副本删掉；出错报原因', async () => {
    const { session, argvs } = setup()
    await expect(host!.sideQuestion(session.id, '先问', [])).rejects.toThrow('先在主对话里发一条消息')
    await host!.send(session.id, '你好')
    await wait(() => idle(session.id) && !!snap(session.id).record.engineSessionId)
    const file = snap(session.id).record.engineSessionId!
    const before = readFileSync(file, 'utf8')
    const answer = await host!.sideQuestion(session.id, '这个项目用什么语言', [
      { question: '上一问', answer: '上一答' },
    ])
    expect(answer).toMatch(/^旁聊回答：\d+ 行，no-tools，问：问：这个项目用什么语言$/)
    expect(readFileSync(file, 'utf8')).toBe(before)
    const side = argvs().find(a => a.argv.includes('-p'))
    expect(side.argv.slice(0, 2)).toEqual(['-p', '--session'])
    // 明确指定会话的模型：Pi 恢复不了会话里的模型时会悄悄换成别的
    expect(side.argv.slice(3)).toEqual(['--no-tools', '--no-skills', '--model', 'fake/fake-pixel'])
    expect(side.argv[2]).not.toBe(file)
    expect(existsSync(side.argv[2])).toBe(false)
    expect(side.mcpFile).toBeNull()
    await expect(host!.sideQuestion(session.id, '旁聊失败', [])).rejects.toThrow('side boom')
  })
  it('旁聊的参数：用户追加的照带、去掉选工具 / 加技能的；模型按网关规则；报错取第一行；会话文件截到完整的行', () => {
    expect(sideUserArgs(['-e', 'x.ts', '--tools', 'bash', '-nt', '--tools=read', '--skill', 'd', '--verbose'])).toEqual(
      ['-e', 'x.ts', '--verbose'],
    )
    expect(pixelSideArgs('s.jsonl', null, ['-e', 'x.ts'])).toEqual([
      '-e',
      'x.ts',
      '-p',
      '--session',
      's.jsonl',
      '--no-tools',
      '--no-skills',
    ])
    expect(pixelSideModel({ model: 'fake/m', platform: null, provider: null })).toBe('fake/m')
    expect(pixelSideModel({ model: 'glm-5', platform: { groupId: 'g', account: 'a' }, provider: null })).toBe(
      'pixelsky/glm-5',
    )
    expect(pixelSideModel({ model: 'pixelsky/glm-5', platform: { groupId: 'g', account: 'a' }, provider: null })).toBe(
      'pixelsky/glm-5',
    )
    expect(pixelSideModel({ model: null, platform: null, provider: null })).toBeNull()
    expect(answerOf(' 回答 ', '')).toBe('回答')
    const stderr = ['', 'No API key found for the selected model.', '', 'Use /login…', '  docs/providers.md'].join(NL)
    expect(() => answerOf('', stderr)).toThrow(/^No API key found for the selected model\.$/)
    // 复制会话文件截到最后一个完整的行；最后一行超过 1 MB 时换行在更前面的块里
    const dir = mkdtempSync(join(tmpdir(), 'pixel-side-copy-'))
    try {
      const src = join(dir, 'src.jsonl'),
        copy = join(dir, 'copy.jsonl')
      const tail = '{"b":"' + 'x'.repeat(1024 * 1024 + 7)
      writeFileSync(src, '{"a":"中"}' + NL + tail)
      expect(copyCompleteLines(src, copy)).toBe(true)
      expect(readFileSync(copy, 'utf8')).toBe('{"a":"中"}' + NL)
      writeFileSync(src, '{"b"')
      expect(copyCompleteLines(src, copy)).toBe(false)
      writeFileSync(src, '')
      expect(copyCompleteLines(src, copy)).toBe(false)
      expect(() => copyCompleteLines(join(dir, 'missing.jsonl'), copy)).toThrow(/ENOENT/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('目录：起不来时记下启动错误，之后起得来就清掉', async () => {
    let fail = 'catalog boom'
    const { adapter } = setup(50, { extraEnv: () => (fail ? { FAKE_PIXEL_START_FAIL: fail } : {}) })
    const info = await adapter.info()
    expect((await adapter.catalog()).models).toBeUndefined()
    expect(info.launchError).toContain('catalog boom')
    fail = ''
    expect((await adapter.catalog()).models?.length).toBe(2)
    expect((await adapter.info()).launchError).toBeUndefined()
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
    // 适配器自己用的扩展命令（pixelsky-mode / pixelsky-mcp）不列，用户自己装的扩展命令照常列出
    expect(snap(session.id).commands?.map(c => c.name)).toEqual(['compact', 'review', 'skill:probe'])
    // 上下文明细：最近一次请求的输入 / 缓存 / 输出
    expect(snap(session.id).context).toMatchObject({ input: 100, cacheRead: 40, cacheWrite: 0, output: 20 })
    // 不调 set_auto_retry（会写进用户自己的 Pi 设置文件）
    expect(log.some(m => m.type === 'set_auto_retry')).toBe(false)
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
  it('停止：进程还在连接时立即结束这一轮，不等连接完，之后也不再把提示发出去', async () => {
    const { session, messages, events } = setup(60_000, { extraEnv: () => ({ FAKE_PIXEL_SLOW_START: '1500' }) })
    await host!.send(session.id, 'hello')
    await wait(() => messages().some(m => m.type === 'get_available_models'))
    const started = Date.now()
    await host!.interrupt(session.id)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(idle(session.id)).toBe(true)
    expect(
      events.flatMap(e => (e.kind === 'session' && e.event.type === 'turn_completed' ? [e.event.outcome] : [])),
    ).toEqual(['interrupted'])
    // 连接在后台做完（set_thinking_level 是 get_available_models 之后的一步），提示不发
    await wait(() => messages().some(m => m.type === 'set_thinking_level'))
    await new Promise(r => setTimeout(r, 100))
    expect(messages().some(m => m.type === 'prompt')).toBe(false)
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
  it('续接：会话文件没了，宿主派发前发现（hasNativeSession），整段对话交接进新会话并提示一次', async () => {
    const { adapter, session, messages } = setup(50)
    await host!.send(session.id, 'first')
    await wait(() => snap(session.id).items.some(i => i.kind === 'turn_stats'))
    const file = snap(session.id).record.engineSessionId!
    expect(adapter.hasNativeSession(snap(session.id).record)).toBe(true)
    await new Promise(r => setTimeout(r, 200))
    const { rmSync } = await import('node:fs')
    rmSync(file)
    expect(adapter.hasNativeSession(snap(session.id).record)).toBe(false)
    await host!.send(session.id, 'second')
    await wait(() => snap(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    expect(snap(session.id).items.filter(i => i.kind === 'notice')).toEqual([
      expect.objectContaining({ level: 'warn', text: expect.stringContaining('Pixel 的会话记录不在了') }),
    ])
    const prompt = messages().findLast(m => m.type === 'prompt')
    expect(prompt.message).toContain('first')
    expect(prompt.message.endsWith('second')).toBe(true)
    // 没会话、id 不是路径时按在算
    expect(adapter.hasNativeSession({ ...snap(session.id).record, engineSessionId: null })).toBe(true)
  })
  it('续接：文件还在却接不上（switch_session 失败），请宿主把之前的聊天带进这条消息（lostSeed）', async () => {
    let broken = false
    const { session, messages } = setup(50, { extraEnv: () => (broken ? { FAKE_PIXEL_SWITCH_FAIL: '1' } : {}) })
    await host!.send(session.id, 'first')
    await wait(() => snap(session.id).items.some(i => i.kind === 'turn_stats'))
    await new Promise(r => setTimeout(r, 200))
    broken = true
    await host!.send(session.id, 'second')
    await wait(() => snap(session.id).items.filter(i => i.kind === 'turn_stats').length === 2)
    const notices = snap(session.id).items.filter(i => i.kind === 'notice')
    expect(notices).toEqual([
      expect.objectContaining({ level: 'warn', text: expect.stringContaining('没能接上原来的 Pixel 会话') }),
    ])
    expect(notices[0].kind === 'notice' && notices[0].detail).toContain('Session file is corrupt')
    const prompt = messages().findLast(m => m.type === 'prompt')
    expect(prompt.message).toContain('first')
    expect(prompt.message.endsWith('second')).toBe(true)
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
    expect(PIXEL_MODES).toEqual({
      ask: 'default',
      edits: 'acceptEdits',
      auto: 'default',
      plan: 'plan',
      full: 'bypassPermissions',
    })
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
  it('云端线路的窗口：没填按模型系列自动定（官方表更小取小的），填了用填的；换模型、改窗口都换进程', async () => {
    const { session, argvs } = setup(60_000, {
      sessionEnv: () => ({ PIXELSKY_PIXEL_BASE_URL: 'http://127.0.0.1:9/v1', PIXELSKY_PIXEL_TOKEN: 'secret-1' }),
      // 和 host/index.ts 接的一样：设置里的窗口
      launchOptions: () => ({ contextWindows: host!.engineConfig().pixel.contextWindows }),
    })
    const windowOf = (n: number): unknown =>
      (argvs()[n].providers.pixelsky.models as Array<{ id: string; contextWindow?: number }>).map(m => [
        m.id,
        m.contextWindow,
      ])
    const turn = async (n: number): Promise<void> => {
      await host!.send(session.id, 'hi')
      await wait(() => argvs().length === n && idle(session.id))
    }
    await host!.update(session.id, { platform: { groupId: '1', account: 'a@b.c' }, model: 'deepseek-v4.1-flash' })
    await turn(1)
    expect(windowOf(0)).toEqual([['deepseek-v4.1-flash', 1_000_000]])
    // 老的 Claude 模型官方只有 200K：取小的
    await host!.update(session.id, { model: 'claude-haiku-4-5' })
    await turn(2)
    expect(windowOf(1)).toEqual([['claude-haiku-4-5', 200_000]])
    await host!.setEngineConfig('pixel', { contextWindows: { platform: { 'claude-haiku-4-5': 150_000 } } })
    await turn(3)
    expect(windowOf(2)).toEqual([['claude-haiku-4-5', 150_000]])
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
    expect(notices).toContain('已把之前的对话交接给 Pixel（1 条，1 张图片未带上）')
    expect(notices.some(text => text.includes('当前模型不能看图') || text.includes("can't view images"))).toBe(false)
    expect(notices.some(text => text.includes('含 1 张图片'))).toBe(false)
    expect(snap(session.id).items.some(i => i.kind === 'notice' && i.level === 'error')).toBe(false)
    expect(snap(session.id).items.filter(i => i.kind === 'user')).toHaveLength(2)
  })
})

describe('MCP 操作结果对号', () => {
  const waiters = [
    { req: '1', op: 'reconnect', name: 'alpha' },
    { req: '2', op: 'status', name: '' },
  ]
  it('带请求号：按请求号找，先完成的刷新不会被交给重连', () => {
    expect(mcpWaiterFor(waiters, '2', 'status', '')).toBe(waiters[1])
    expect(mcpWaiterFor(waiters, '1', 'reconnect', 'alpha')).toBe(waiters[0])
  })
  it('请求号对不上（已超时撤掉）就丢掉，不给别的操作', () => {
    expect(mcpWaiterFor(waiters, '9', 'status', '')).toBeUndefined()
  })
  it('旧版命令行不带请求号：按操作 + 名字找，都对不上才给最早的', () => {
    expect(mcpWaiterFor(waiters, '', 'status', '')).toBe(waiters[1])
    expect(mcpWaiterFor(waiters, '', 'login', 'x')).toBe(waiters[0])
  })
})

describe('Pixel 兼容性（网关模型、发送前准备、强度、重试、换模型）', () => {
  const GATEWAY = { PIXELSKY_PIXEL_BASE_URL: 'http://127.0.0.1:9/v1', PIXELSKY_PIXEL_TOKEN: 'secret-1' }
  const platform = { groupId: '1', account: 'a@b.c' }
  const outcomes = (events: HostEvent[]) =>
    events.flatMap(e => (e.kind === 'session' && e.event.type === 'turn_completed' ? [e.event.outcome] : []))
  const stats = (id: string) => snap(id).items.filter(i => i.kind === 'turn_stats')

  it('经网关：只认 pixelsky/<id>，不会落到 Pi 内置的同名模型（那会用本机密钥直连厂商）', async () => {
    const { session, messages } = setup(60_000, { sessionEnv: () => GATEWAY })
    // fake-pixel 同时是内置 provider fake 下的模型，Pi 把内置的排在前面
    await host!.update(session.id, { platform, model: 'fake-pixel' })
    await host!.send(session.id, 'hi')
    await wait(() => stats(session.id).length === 1)
    expect(messages().filter(m => m.type === 'set_model')).toEqual([
      expect.objectContaining({ provider: 'pixelsky', modelId: 'fake-pixel' }),
    ])
    expect(findModel([{ provider: 'fake', id: 'x' }], 'x', 'pixelsky')).toBeUndefined()
    expect(findModel([{ provider: 'pixelsky', id: 'x' }], 'pixelsky/x', 'pixelsky')).toMatchObject({ id: 'x' })
  })

  it('经网关、网关没注册模型：报错，不用同名的内置模型', async () => {
    // 没给网关地址：命令行不注册 pixelsky provider
    const { session, messages } = setup(60_000, { sessionEnv: () => ({ PIXELSKY_PIXEL_TOKEN: 'secret-1' }) })
    await host!.update(session.id, { platform, model: 'fake-pixel' })
    await host!.send(session.id, 'hi')
    await wait(() => idle(session.id) && snap(session.id).record.lastOutcome === 'failed')
    expect(snap(session.id).record.lastError).toContain('Model not found: pixelsky/fake-pixel')
    expect(messages().some(m => m.type === 'set_model')).toBe(false)
  })

  it('发送前先压缩（比等回应的时间长）：不按超时失败，这一轮照常做完', async () => {
    const { session, events } = setup(60_000, {
      extraEnv: () => ({ FAKE_PIXEL_COMPACT_MS: '600' }),
      launchOptions: () => ({ promptStartMs: 200 }),
    })
    await host!.send(session.id, '先总结')
    await wait(() => stats(session.id).length === 1)
    expect(outcomes(events)).toEqual(['completed'])
    expect(snap(session.id).items.find(i => i.kind === 'compaction')).toMatchObject({ status: 'completed' })
    expect(snap(session.id).items.some(i => i.kind === 'assistant' && i.text.startsWith('收到'))).toBe(true)
  })

  it('发送前一直没动静：先让 Pi 停下再按失败结束，下一条消息不会被「正在处理」拒掉', async () => {
    const { session, messages, events } = setup(60_000, { launchOptions: () => ({ promptStartMs: 200 }) })
    await host!.send(session.id, '卡住')
    await wait(() => idle(session.id) && snap(session.id).record.lastOutcome === 'failed')
    expect(snap(session.id).record.lastError).toContain('没有开始处理这条消息')
    expect(messages().some(m => m.type === 'abort')).toBe(true)
    host!.resumeQueue(session.id)
    await host!.send(session.id, 'hi')
    await wait(() => stats(session.id).length === 2)
    expect(outcomes(events)).toEqual(['failed', 'completed'])
    expect(snap(session.id).items.filter(i => i.kind === 'notice' && i.level === 'error')).toHaveLength(1)
  })

  it('强度：报当前模型实际支持的档位（flags.efforts），选的档位被 Pi 夹紧时记录跟着改', async () => {
    const { session } = setup(60_000)
    await host!.update(session.id, { effort: 'max' })
    await host!.send(session.id, 'hi')
    await wait(() => stats(session.id).length === 1)
    // fake-pixel 没有 max：Pi 夹到 xhigh
    expect(snap(session.id).flags.efforts).toEqual({
      model: 'fake/fake-pixel',
      efforts: ['low', 'medium', 'high', 'xhigh'],
    })
    expect(snap(session.id).record.effort).toBe('xhigh')
    // 换到不能推理的模型：档位为空，记录里的强度不动（换回来还用）
    await host!.update(session.id, { model: 'fake/fake-small' })
    await wait(() => snap(session.id).flags.efforts?.model === 'fake/fake-small')
    expect(snap(session.id).flags.efforts?.efforts).toEqual([])
    expect(snap(session.id).record.effort).toBe('xhigh')
    expect(effortsFromLevels(['off', 'minimal', 'low', 'max'])).toEqual(['low', 'max'])
  })

  it('强度：旧版命令行没有 get_available_thinking_levels，按模型定义算', async () => {
    const { session } = setup(60_000, { extraEnv: () => ({ FAKE_PIXEL_OLD: '1' }) })
    await host!.send(session.id, 'hi')
    await wait(() => stats(session.id).length === 1)
    expect(snap(session.id).flags.efforts?.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('重试：用完只显示一次错误；超过设置的次数就取消等着的重试，不调 set_auto_retry', async () => {
    const { session, messages } = setup(60_000)
    host!.setRetrySettings(1)
    await host!.send(session.id, '重试失败')
    await wait(() => idle(session.id) && snap(session.id).record.lastOutcome === 'failed')
    expect(snap(session.id).record.lastError).toContain('529 overloaded')
    expect(snap(session.id).items.filter(i => i.kind === 'notice' && i.level === 'error')).toHaveLength(1)
    const log = messages()
    expect(log.filter(m => m.type === 'abort_retry')).toHaveLength(1)
    expect(log.some(m => m.type === 'set_auto_retry')).toBe(false)
    expect(snap(session.id).retry ?? null).toBeNull()
  })

  it('重试：Pi 自己用完重试次数时错误也只显示一次', async () => {
    const { session } = setup(60_000)
    await host!.send(session.id, '重试失败')
    await wait(() => idle(session.id) && snap(session.id).record.lastOutcome === 'failed')
    expect(snap(session.id).items.filter(i => i.kind === 'notice' && i.level === 'error')).toHaveLength(1)
  })

  it('重试：等重试时停止，按中断结束，不显示红色的「Retry cancelled」', async () => {
    const { session, events } = setup(60_000)
    await host!.send(session.id, '重试等待')
    await wait(() => !!snap(session.id).retry)
    await host!.interrupt(session.id)
    await wait(() => idle(session.id))
    expect(outcomes(events)).toEqual(['interrupted'])
    expect(snap(session.id).items.some(i => i.kind === 'notice' && i.level === 'error')).toBe(false)
  })

  it('压缩生成摘要的用量记在会话的模型名下，并算进累计', async () => {
    const { session } = setup(60_000)
    await host!.send(session.id, '压缩')
    await wait(() => stats(session.id).length === 1)
    const usage = stats(session.id)[0]
    expect(usage.kind === 'turn_stats' && Object.keys(usage.usage.models)).toEqual(['fake-pixel'])
    expect(usage.kind === 'turn_stats' && usage.usage.models['fake-pixel'].requests).toBe(2)
  })

  it('云端线路运行中换模型：这一轮照旧用原模型、不假装换了，下一条消息换进程用新模型', async () => {
    const { session, messages, argvs } = setup(60_000, { sessionEnv: () => GATEWAY })
    await host!.update(session.id, { platform, model: 'm1' })
    await host!.send(session.id, '慢')
    await wait(() => snap(session.id).items.some(i => i.kind === 'assistant'))
    await host!.update(session.id, { model: 'm2' })
    expect(snap(session.id).record.model).toBe('m2')
    expect(snap(session.id).execution?.model).toBe('m1')
    expect(messages().some(m => m.type === 'set_model' && m.modelId === 'm2')).toBe(false)
    await host!.interrupt(session.id)
    host!.resumeQueue(session.id)
    await host!.send(session.id, 'hi')
    await wait(() => stats(session.id).length === 2 && idle(session.id))
    expect(argvs()).toHaveLength(2)
    expect(
      messages()
        .filter(m => m.type === 'set_model')
        .pop(),
    ).toMatchObject({ provider: 'pixelsky', modelId: 'm2' })
    expect(snap(session.id).record.lastOutcome).toBe('completed')
  })

  it('自定义 API：换到启动后才加进接口的模型，换进程接上，不再报 Model not found', async () => {
    const endpoint = ['a']
    const { session, messages, argvs } = setup(60_000, {
      sessionEnv: () => ({ ...GATEWAY, PIXELSKY_PIXEL_MODELS: JSON.stringify(endpoint) }),
    })
    await host!.update(session.id, { provider: { id: 'p1' }, model: 'a' })
    await host!.send(session.id, 'hi')
    await wait(() => stats(session.id).length === 1 && idle(session.id))
    endpoint.push('b')
    await host!.update(session.id, { model: 'b' })
    await host!.send(session.id, 'hi')
    await wait(() => stats(session.id).length === 2 && idle(session.id))
    expect(snap(session.id).record.lastOutcome).toBe('completed')
    expect(argvs()).toHaveLength(2)
    expect(
      messages()
        .filter(m => m.type === 'set_model')
        .pop(),
    ).toMatchObject({ provider: 'pixelsky', modelId: 'b' })
    // 接口里已经有的模型照常运行中切换，不换进程
    await host!.update(session.id, { model: 'a' })
    await wait(
      () =>
        messages()
          .filter(m => m.type === 'set_model')
          .pop()?.modelId === 'a',
    )
    expect(argvs()).toHaveLength(2)
  })
})

describe('Windows 上的 Git Bash（Pi 只在 ProgramFiles 下找，找不到就用 PATH 上的 bash.exe）', () => {
  const files = (...list: string[]) => {
    const set = new Set(list.map(f => f.toLowerCase()))
    return (p: string) => set.has(p.toLowerCase())
  }
  const env = (path: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ProgramFiles: 'C:\\Program Files',
    Path: path,
    PIXELSKY_CODING_AGENT_DIR: root,
    ...extra,
  })

  it('ProgramFiles 下有 Git Bash、或不是 Windows：什么都不用做', () => {
    expect(pixelShell(env('C:\\Windows\\system32'), 'win32', files('C:\\Program Files\\Git\\bin\\bash.exe'))).toEqual(
      {},
    )
    expect(pixelShell(env(''), 'darwin', files())).toEqual({})
    expect(windowsBash(env(''), files('C:\\Program Files\\Git\\bin\\bash.exe'))).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    )
  })

  it('Git 装在别的盘：从 PATH 上的 git.exe 找到它的 bin，放到会话进程 PATH 的最前面（不用 System32 的 WSL bash）', () => {
    const exists = files(
      'C:\\Windows\\system32\\bash.exe',
      'D:\\Program Files\\Git\\cmd\\git.exe',
      'D:\\Program Files\\Git\\bin\\bash.exe',
    )
    const path = 'C:\\Windows\\system32;D:\\Program Files\\Git\\cmd'
    expect(gitBashDir(env(path), exists)).toBe('D:\\Program Files\\Git\\bin')
    expect(pixelShell(env(path), 'win32', exists)).toEqual({ pathDir: 'D:\\Program Files\\Git\\bin' })
  })

  it('只有 WSL 的 bash、或什么都没有：给出中文提示', () => {
    expect(pixelShell(env('C:\\Windows\\system32'), 'win32', files('C:\\Windows\\system32\\bash.exe')).warning).toMatch(
      /只找到了 WSL 的 bash/,
    )
    expect(pixelShell(env(''), 'win32', files()).warning).toMatch(/没有找到 Git Bash.*Git for Windows/)
  })

  it('用户在 Pi 的 settings.json 里写了 shellPath：以它为准', () => {
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ shellPath: 'E:\\tools\\bash.exe' }))
    expect(pixelShell(env(''), 'win32', files('E:\\tools\\bash.exe'))).toEqual({})
  })

  it('检测时把提示放进引擎信息的配置提示，Git 的 bin 加进会话进程的 PATH', async () => {
    const { adapter, session, argvs } = setup(60_000, {
      shell: () => ({ pathDir: 'D:\\Git\\bin', warning: '没有找到 Git Bash' }),
    })
    expect((await adapter.info()).configWarnings).toEqual(['没有找到 Git Bash'])
    await host!.send(session.id, 'hi')
    await wait(() => argvs().length === 1 && idle(session.id))
    expect(argvs()[0].path.split(';')[0]).toBe('D:\\Git\\bin')
  })
})
