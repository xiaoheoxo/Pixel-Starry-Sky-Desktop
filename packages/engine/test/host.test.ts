// EngineHost + ClaudeSession 的完整流程，引擎用 test/fakes/fake-claude.mjs 代替（不调用真实模型）
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostEvent, SessionRecord } from '@pixelsky/protocol'
import { ClaudeAdapter, EngineHost, LONG_CONTEXT_ENV, type EngineHostOptions } from '../src'

const FAKE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))

let root: string
let events: HostEvent[]
let hosts: EngineHost[]

function makeHost(
  idleMs = 60_000,
  extraEnv: NodeJS.ProcessEnv = {},
  sessionEnv?: (record: SessionRecord) => NodeJS.ProcessEnv,
  steeringValidated = false,
  extra: Partial<EngineHostOptions> = {},
): EngineHost {
  const projectsDir = join(root, 'claude-projects')
  const adapter = new ClaudeAdapter({
    sessionEnv,
    steeringValidated,
    launcher: { command: process.execPath, args: [FAKE] },
    projectsDir,
    env: { ...process.env, FAKE_CLAUDE_PROJECTS: projectsDir, FAKE_CLAUDE_LOG: join(root, 'argv.log'), ...extraEnv },
  })
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    emit: e => events.push(e),
    idleMs,
    adapters: { claude: adapter },
    ...extra,
  })
  hosts.push(host)
  return host
}

function permLog(): unknown[] {
  try {
    return readFileSync(join(root, 'argv.perm.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as unknown)
  } catch {
    return []
  }
}

function thinkingLog(): string[] {
  try {
    return readFileSync(join(root, 'argv.thinking.log'), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function spawnArgs(): string[][] {
  try {
    return readFileSync(join(root, 'argv.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as string[])
  } catch {
    return []
  }
}

async function waitFor<T>(pick: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = pick()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 20))
  }
}

function sessionEvents(id: string) {
  return events.flatMap(e => (e.kind === 'session' && e.sessionId === id ? [e.event] : []))
}

function turnsDone(id: string): number {
  return sessionEvents(id).filter(e => e.type === 'turn_completed').length
}

it('worktree sessions keep their own cwd and directory maintenance blocks new writes', async () => {
  const host = makeHost()
  const project = host.addProject(root)
  const copy = join(root, 'copy-workspace')
  mkdirSync(copy)
  const record = host.createSession({ projectId: project.id }, copy)
  expect(record.cwd).toBe(copy)
  expect(host.projects().find(p => p.id === project.id)?.path).toBe(root)
  await host.withWorkspaceStopped(copy, async () => {
    await expect(host.send(record.id, 'blocked')).rejects.toThrow('维护')
    expect(() => host.createSession({ projectId: project.id }, copy)).toThrow('维护')
    expect(host.open(record.id).queuePaused).toBe(true)
  })
  expect(host.createSession({ projectId: project.id }, copy).cwd).toBe(copy)
})

function setup(host: EngineHost, ultracode = false) {
  const projectDir = mkdtempSync(join(root, 'proj-'))
  const project = host.addProject(projectDir)
  const record = host.createSession({ projectId: project.id, permissionMode: 'ask', effort: 'high', ultracode })
  return { project, record }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-engine-'))
  events = []
  hosts = []
})

afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  rmSync(root, { recursive: true, force: true })
})

describe('EngineHost + Claude（假引擎）', () => {
  it('真实 stdin 传图片内容块，纯图片不含空文本块，文字旧格式兼容', async () => {
    const log = join(root, 'image-metadata.jsonl'),
      host = makeHost(60_000, { FAKE_CLAUDE_IMAGES: log })
    const { record } = setup(host)
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
    const image = {
      id: 'img',
      name: '中文截图.png',
      mediaType: 'image/png' as const,
      width: 1,
      height: 1,
      bytes: Buffer.from(png, 'base64').length,
      dataBase64: png,
    }
    await host.send(record.id, { text: '说明', clientMessageId: 'mixed', attachments: [image] })
    await waitFor(() => turnsDone(record.id) === 1)
    await host.send(record.id, { text: '', clientMessageId: 'pure', attachments: [image] })
    await waitFor(() => turnsDone(record.id) === 2)
    await host.send(record.id, '文字')
    await waitFor(() => turnsDone(record.id) === 3)
    const frames = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(frames[0]).toEqual({
      types: ['text', 'image'],
      text: '说明',
      images: [
        {
          mediaType: 'image/png',
          bytes: image.bytes,
          sha256: createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex'),
        },
      ],
    })
    expect(frames[1].types).toEqual(['image'])
    expect(frames[2]).toEqual({ types: ['string'], text: '文字', images: [] })
  })
  it('原生上下文诊断不新增聊天条目、轮次或用量记录', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_CONTEXT: '1' })
    const { record } = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    const before = host.open(record.id)
    expect(before.flags).toMatchObject({ contextAvailable: true, compactAvailable: true })
    const detail = await host.inspectContext(record.id)
    expect(detail).toMatchObject({ used: 60000, window: 200000, model: 'fake-model' })
    const after = host.open(record.id)
    expect(after.items).toEqual(before.items)
    expect(after.usage).toEqual(before.usage)
    expect(after.record.title).toBe(before.record.title)
    expect(after.context).toMatchObject({ source: 'diagnostic', used: 60000, diagnosticStale: false })
    expect(turnsDone(record.id)).toBe(1)
    expect(spawnArgs()).toHaveLength(1)
  })

  it('诊断期间的新消息先排队，重复诊断和压缩不插队，结束后继续发送', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_CONTEXT: '1', FAKE_CLAUDE_CONTEXT_DELAY: '180' })
    const { record } = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    const inspection = host.inspectContext(record.id)
    await expect(host.inspectContext(record.id)).rejects.toThrow('等待')
    await expect(host.compactContext(record.id)).rejects.toThrow('等待')
    await host.send(record.id, '诊断后的消息')
    expect(host.open(record.id).queue[0].status).toBe('queued')
    await inspection
    await waitFor(() => turnsDone(record.id) === 2)
    expect(host.open(record.id).items.some(i => i.kind === 'assistant' && i.text.includes('诊断后的消息'))).toBe(true)
    await host.compactContext(record.id)
    await waitFor(() => turnsDone(record.id) === 3)
    expect(host.open(record.id).items.some(i => i.kind === 'user' && i.text === '/compact')).toBe(true)
    expect(host.open(record.id).context).toMatchObject({ stale: true, compacting: false })
  })

  it('支持 get_context_usage 时启动和每轮结束自动取明细，运行中也能刷新且不进队列', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_USAGE: '1' })
    const { record } = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    await waitFor(() => !!host.open(record.id).context?.diagnostic && !host.open(record.id).context?.diagnosticStale)
    const after = host.open(record.id)
    expect(after.flags.contextLive).toBe(true)
    expect(after.context?.diagnostic).toMatchObject({
      detail: 'summary',
      window: 1000000,
      tools: [{ name: 'mcp__browser__open', source: 'browser' }],
      memory: [{ name: 'CLAUDE.md', source: 'Project' }],
      skills: [{ name: 'review', source: 'plugin' }],
    })
    expect(after.items.some(i => i.kind === 'user' && i.text === '/context')).toBe(false)
    await host.send(record.id, '慢慢说')
    await waitFor(() => host.open(record.id).state === 'running')
    const queued = host.open(record.id).queue.length
    const detail = await host.inspectContext(record.id, 'full')
    expect(detail).toMatchObject({ detail: 'full', used: 42000 })
    expect(host.open(record.id).queue).toHaveLength(queued)
    expect(host.open(record.id).state).toBe('running')
    await waitFor(() => turnsDone(record.id) === 2)
    const log = readFileSync(join(root, 'argv.usage.log'), 'utf8').trim().split(/\r?\n/)
    expect(log).toContain('full:running')
    expect(log.filter(l => l.startsWith('summary')).length).toBeGreaterThanOrEqual(2)
    expect(spawnArgs()).toHaveLength(1)
  })

  it('退出应用时不等引擎收尾：关了 stdin 也不退的进程 1 秒左右就被强制结束（原来等满 5 秒，更新重启时白等）', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_LINGER: '1' })
    const { record } = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    const start = Date.now()
    await host.shutdown()
    const took = Date.now() - start
    expect(took).toBeGreaterThanOrEqual(900)
    expect(took).toBeLessThan(3_000)
  })

  it('一轮结束后引擎自己接着干（后台任务通知）：算新的一轮，有运行状态、统计行和用量，空闲定时器不关进程', async () => {
    // 空闲时间 600ms：假引擎在第一轮结束 40ms 后发通知接着干。空闲短了（原来 60ms、后来 150ms）整套检查并行跑、
    // CPU 占满时假引擎的 40ms 会拖到空闲之后，进程被关，后续那一轮不来，测试等到超时
    const host = makeHost(600, { FAKE_CLAUDE_CONTINUE_MS: '900' })
    const { record } = setup(host)
    await host.send(record.id, '有后续')
    await waitFor(() => turnsDone(record.id) === 1)
    await waitFor(() => host.open(record.id).state === 'running')
    // 后续这一轮在跑（900ms）：超过空闲时间也不能关掉进程
    await new Promise(r => setTimeout(r, 700))
    await waitFor(() => turnsDone(record.id) === 2)
    const snap = host.open(record.id)
    expect(snap.state).toBe('idle')
    const kinds = snap.items.map(i => (i.kind === 'assistant' ? `assistant:${i.text}` : i.kind))
    expect(kinds.filter(k => k === 'turn_stats')).toHaveLength(2)
    expect(kinds.indexOf('assistant:先回答')).toBeLessThan(kinds.indexOf('assistant:清理完了'))
    expect(snap.items.find(i => i.kind === 'command')).toMatchObject({ status: 'completed' })
    expect(spawnArgs()).toHaveLength(1)
    // 重开：两轮的统计行和顺序都在
    const again = makeHost(60_000, { FAKE_CLAUDE_CONTINUE_MS: '200' })
    expect(again.open(record.id).items.map(i => i.kind)).toEqual(snap.items.map(i => i.kind))
  }, 15_000)

  it('这一轮说完了、后台子智能体还在跑：轮结束带上个数，会话列表标出来，空闲定时器不关进程；跑完接着的那一轮正常收尾', async () => {
    const host = makeHost(60, { FAKE_CLAUDE_AGENT_MS: '400' })
    const { record } = setup(host)
    await host.send(record.id, '派出')
    await waitFor(() => turnsDone(record.id) === 1)
    const first = sessionEvents(record.id).find(e => e.type === 'turn_completed')
    expect(first).toMatchObject({ outcome: 'completed', background: 1 })
    expect(host.open(record.id)).toMatchObject({ state: 'idle', background: 1 })
    expect(host.sessions().find(s => s.record.id === record.id)).toMatchObject({ state: 'idle', background: 1 })
    // 超过空闲时间（60ms）好几倍：进程还在，子智能体跑完后引擎接着汇总
    await waitFor(() => turnsDone(record.id) === 2)
    const last = sessionEvents(record.id)
      .filter(e => e.type === 'turn_completed')
      .at(-1)
    expect(last).toMatchObject({ outcome: 'completed' })
    expect(last).not.toHaveProperty('background')
    expect(host.open(record.id).background).toBe(0)
    expect(host.sessions().find(s => s.record.id === record.id)).not.toHaveProperty('background')
    expect(host.open(record.id).items.some(i => i.kind === 'assistant' && i.text === '汇总完成')).toBe(true)
    expect(spawnArgs()).toHaveLength(1)
  })

  it('后台子智能体都跑完、引擎没接着干：这时才开始空闲计时，到点关进程', async () => {
    const host = makeHost(60, { FAKE_CLAUDE_AGENT_MS: '300', FAKE_CLAUDE_AGENT_NO_WAKE: '1' })
    const { record } = setup(host)
    await host.send(record.id, '派出')
    await waitFor(() => turnsDone(record.id) === 1)
    await new Promise(r => setTimeout(r, 150))
    // 空闲时间早过了，但子智能体还在跑：没关（关了的话进程退出会把个数清零）
    expect(host.open(record.id).background).toBe(1)
    await waitFor(() => host.open(record.id).background === 0)
    await new Promise(r => setTimeout(r, 200))
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 2)
    // 子智能体跑完后空闲到点关了进程，这句在新进程里
    expect(spawnArgs()).toHaveLength(2)
  })

  it('未启动或旧版引擎的上下文诊断与压缩给出明确不可用原因', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await expect(host.inspectContext(record.id)).rejects.toThrow('先运行会话')
    await expect(host.compactContext(record.id)).rejects.toThrow('不支持原生压缩')
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    await expect(host.inspectContext(record.id)).rejects.toThrow('支持上下文诊断')
  })

  it('诊断进程退出后解锁队列，下条消息在新进程继续，诊断不写入聊天', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_CONTEXT: '1', FAKE_CLAUDE_CONTEXT_EXIT: '1' })
    const { record } = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    const inspection = host.inspectContext(record.id)
    const rejected = expect(inspection).rejects.toThrow('进程已退出')
    await host.send(record.id, '失败后继续')
    await rejected
    await waitFor(() => turnsDone(record.id) === 2)
    expect(host.open(record.id).queue).toHaveLength(0)
    expect(host.open(record.id).items.some(i => i.kind === 'assistant' && i.text.includes('失败后继续'))).toBe(true)
    expect(host.open(record.id).items.some(i => i.kind === 'user' && i.text === '/context')).toBe(false)
    expect(spawnArgs()).toHaveLength(2)
  })
  it('折叠到当前轮的引导保留流式内容与原 turnId，不新增一次普通发送', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_GUIDE: 'fold' }, undefined, true)
    const { record } = setup(host)
    await host.send(record.id, '慢慢说')
    await waitFor(
      () => host.open(record.id).flags.steerAvailable && sessionEvents(record.id).some(e => e.type === 'item_delta'),
    )
    const originalTurn = host.open(record.id).turnId!
    const guided = await host.send(record.id, '当前轮的补充')
    await host.steerQueued(record.id, guided.queueId, originalTurn)
    await waitFor(() => host.open(record.id).items.some(i => i.id === guided.queueId))
    expect(host.open(record.id).turnId).toBe(originalTurn)
    expect(host.open(record.id).items.find(i => i.id === guided.queueId)).toMatchObject({
      mode: 'guidance',
      turnId: originalTurn,
    })
    expect(host.open(record.id).items.some(i => i.kind === 'assistant' && i.text.length > 0)).toBe(true)
    await host.interrupt(record.id)
    expect(turnsDone(record.id)).toBe(1)
    expect(host.open(record.id).queue).toHaveLength(0)
  })
  it('Claude 补充输入在后一轮采纳时跟踪 UUID 与两个 result，不重复派发', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_GUIDE: '1' }, undefined, true)
    const { record } = setup(host)
    await host.send(record.id, '慢慢说')
    await waitFor(
      () => host.open(record.id).flags.steerAvailable && sessionEvents(record.id).some(e => e.type === 'item_delta'),
    )
    const guided = await host.send(record.id, '补充消息')
    await host.steerQueued(record.id, guided.queueId, host.open(record.id).turnId!)
    await host.send(record.id, '普通队列尾部')
    await waitFor(() => turnsDone(record.id) === 3)
    expect(host.open(record.id).queue).toHaveLength(0)
    const users = host.open(record.id).items.filter(i => i.kind === 'user')
    expect(users).toHaveLength(3)
    expect(users[1]).toMatchObject({ id: guided.queueId, mode: 'normal' })
    expect(new Set(users.map(i => (i.kind === 'user' ? i.turnId : undefined))).size).toBe(3)
  })

  it('停止会取消已交给 Claude 但未消费的补充输入，原文回宿主暂停队列', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_GUIDE: '1' }, undefined, true)
    const { record } = setup(host)
    await host.send(record.id, '慢慢说')
    await waitFor(() => host.open(record.id).flags.steerAvailable)
    const guided = await host.send(record.id, '尚未采纳的补充')
    await host.steerQueued(record.id, guided.queueId, host.open(record.id).turnId!)
    await host.interrupt(record.id)
    expect(host.open(record.id).queuePaused).toBe(true)
    expect(host.open(record.id).queue).toMatchObject([{ id: guided.queueId, status: 'queued', mode: 'normal' }])
    expect(turnsDone(record.id)).toBe(1)
    host.resumeQueue(record.id)
    await waitFor(() => turnsDone(record.id) === 2)
    expect(host.open(record.id).items.filter(i => i.kind === 'user' && i.text === '尚未采纳的补充')).toHaveLength(1)
  })

  it('仅 CLI 声明协议能力不能自行开放未经真实验证的引导', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_GUIDE: '1' })
    const { record } = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    expect(host.open(record.id).flags.steerAvailable).toBe(false)
  })
  it('Claude 初始化尚未完成时停止，延迟启动不会把旧消息重新送出', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_INIT_DELAY: '200' })
    const { record } = setup(host)
    await host.send(record.id, '慢慢说')
    await waitFor(() => host.open(record.id).turnId)
    await host.interrupt(record.id)
    await new Promise(r => setTimeout(r, 350))
    expect(host.open(record.id).state).toBe('idle')
    expect(host.open(record.id).items.some(i => i.kind === 'assistant')).toBe(false)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 2)
    expect(host.open(record.id).items.filter(i => i.kind === 'assistant')).toHaveLength(1)
  })
  it('平台会话使用独立网关设置、保留分组、记录平台用量；开始后可以换分组、切回自有并接上原对话', async () => {
    const settingsFile = join(root, 'gateway.json')
    writeFileSync(settingsFile, '{}')
    const host = makeHost(
      60_000,
      {
        ANTHROPIC_API_KEY: 'old-local-key',
        ANTHROPIC_BASE_URL: 'https://local.invalid',
        FAKE_CLAUDE_ENV_LOG: join(root, 'env.json'),
      },
      () => ({
        ANTHROPIC_AUTH_TOKEN: 'loopback-only',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
        PIXELSKY_GATEWAY_SETTINGS: settingsFile,
      }),
    )
    const { record } = setup(host)
    await host.update(record.id, { platform: { groupId: '7', account: 'test@example.com' }, model: 'real-model' })
    await host.send(record.id, '平台测试')
    await waitFor(() => turnsDone(record.id) === 1)
    // 重试设置是「跟随引擎」：平台线路默认只重试 3 次，合并进网关设置的副本
    const settingsArg = spawnArgs()[0][spawnArgs()[0].indexOf('--settings') + 1]
    expect(settingsArg.startsWith(settingsFile + '.retry-')).toBe(true)
    expect(JSON.parse(readFileSync(settingsArg, 'utf8')).env.CLAUDE_CODE_MAX_RETRIES).toBe('3')
    expect(JSON.parse(readFileSync(join(root, 'env.json'), 'utf8'))).toEqual({
      base: 'http://127.0.0.1:1234',
      token: 'loopback-only',
    })
    expect(host.open(record.id).record.platform?.groupId).toBe('7')
    expect(host.usageSummary({ range: 'today', filter: {}, now: Date.now() }).groups.route[0].key).toBe('pixelsky')

    // 同一账号换分组：不重启引擎（平台代理按请求读分组）
    await host.update(record.id, { platform: { groupId: '9', account: 'test@example.com' } })
    expect(host.record(record.id)?.platform?.groupId).toBe('9')
    await host.send(record.id, '换分组后')
    await waitFor(() => turnsDone(record.id) === 2)
    expect(spawnArgs()).toHaveLength(1)

    // 切回自有：关掉进程，下一条消息不带网关设置重新启动，并 --resume 原来的引擎会话
    await host.update(record.id, { platform: null, model: null })
    await host.send(record.id, '自有继续')
    await waitFor(() => turnsDone(record.id) === 3)
    const relaunch = spawnArgs()[1]
    expect(relaunch).not.toContain('--settings')
    expect(relaunch.slice(-2)).toEqual(['--resume', record.id])
    const selfEnv = JSON.parse(readFileSync(join(root, 'env.json'), 'utf8')) as Record<string, string | undefined>
    expect(selfEnv).toMatchObject({ base: 'https://local.invalid', key: 'old-local-key' })
    expect(selfEnv.token).not.toBe('loopback-only')
    expect(host.open(record.id).record.platform).toBeNull()
  })

  it('引擎本机配置：路径、追加的环境变量、压缩模型能保存和读回；变量名不对时拒绝', async () => {
    const host = makeHost()
    expect(host.engineConfig().claude).toMatchObject({ path: null, env: {}, compactModel: null })
    // 替换的命令保存前要能找到（docs/ui/engine-launch.md）
    const exe = join(root, 'tools', process.platform === 'win32' ? 'claude.exe' : 'claude')
    mkdirSync(join(root, 'tools'), { recursive: true })
    writeFileSync(exe, '')
    chmodSync(exe, 0o755)
    await host.setEngineConfig('claude', {
      path: ` ${exe} `,
      env: { FOO: 'bar', HTTPS_PROXY: 'http://127.0.0.1:7890' },
      compactModel: 'claude-sonnet-5-5',
    })
    expect(host.engineConfig().claude).toMatchObject({
      path: exe,
      env: { FOO: 'bar', HTTPS_PROXY: 'http://127.0.0.1:7890' },
      compactModel: 'claude-sonnet-5-5',
    })
    await expect(host.setEngineConfig('claude', { env: { 'BAD-NAME': 'x' } })).rejects.toThrow('环境变量名不对')
    // 重启应用后读回
    expect(makeHost().engineConfig().claude.compactModel).toBe('claude-sonnet-5-5')
    await host.setEngineConfig('claude', { path: null, env: {}, compactModel: null })
    expect(host.engineConfig().claude).toMatchObject({ path: null, env: {}, compactModel: null })
  })

  it('追加的环境变量传给 Claude Code；平台会话的网关变量仍然覆盖它', async () => {
    const projectsDir = join(root, 'claude-projects')
    const envLog = join(root, 'env.json')
    const make = (sessionEnv?: (r: SessionRecord) => NodeJS.ProcessEnv) => {
      const adapter = new ClaudeAdapter({
        sessionEnv,
        extraEnv: () => ({ ANTHROPIC_BASE_URL: 'https://from-settings.invalid' }),
        launcher: { command: process.execPath, args: [FAKE] },
        projectsDir,
        env: {
          ...process.env,
          FAKE_CLAUDE_PROJECTS: projectsDir,
          FAKE_CLAUDE_LOG: join(root, 'argv.log'),
          FAKE_CLAUDE_ENV_LOG: envLog,
        },
      })
      const h = new EngineHost({
        dataDir: join(root, 'data'),
        emit: e => events.push(e),
        adapters: { claude: adapter },
      })
      hosts.push(h)
      return h
    }
    const self = make()
    const a = setup(self).record
    await self.send(a.id, '你好')
    await waitFor(() => turnsDone(a.id) === 1)
    expect(JSON.parse(readFileSync(envLog, 'utf8')).base).toBe('https://from-settings.invalid')

    writeFileSync(join(root, 'gateway.json'), '{}')
    const plat = make(() => ({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
      ANTHROPIC_AUTH_TOKEN: 'loopback-only',
      PIXELSKY_GATEWAY_SETTINGS: join(root, 'gateway.json'),
    }))
    const b = setup(plat).record
    await plat.update(b.id, { platform: { groupId: '7', account: 'a@example.com' } })
    await plat.send(b.id, '你好')
    await waitFor(() => turnsDone(b.id) === 1)
    expect(JSON.parse(readFileSync(envLog, 'utf8')).base).toBe('http://127.0.0.1:1234')
  })

  it('上下文超过 200K 的自定义模型：启动、换模型时模型名带 [1m]，没在名单里的不带（docs/ui/custom-api.md §10）', async () => {
    const settingsFile = join(root, 'gateway.json')
    writeFileSync(settingsFile, '{}')
    const modelLog = join(root, 'models.log')
    const host = makeHost(60_000, { FAKE_CLAUDE_MODEL_LOG: modelLog }, () => ({
      ANTHROPIC_AUTH_TOKEN: 'loopback-only',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
      PIXELSKY_GATEWAY_SETTINGS: settingsFile,
      [LONG_CONTEXT_ENV]: JSON.stringify(['anthropic/claude-v4.1flash']),
    }))
    const { record } = setup(host)
    await host.update(record.id, { provider: { id: 'p1' }, model: 'anthropic/claude-v4.1flash' })
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    const args = spawnArgs()[0]
    expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-v4.1flash[1m]')
    expect(host.record(record.id)?.model).toBe('anthropic/claude-v4.1flash')
    await host.update(record.id, { model: 'deepseek-chat' })
    await host.update(record.id, { model: 'anthropic/claude-v4.1flash' })
    await waitFor(() => readFileSync(modelLog, 'utf8').trim().split('\n').length === 2)
    expect(readFileSync(modelLog, 'utf8').trim().split('\n')).toEqual([
      'deepseek-chat',
      'anthropic/claude-v4.1flash[1m]',
    ])
  })

  it('自定义 API 会话走本机网关：进程里只有本机地址和会话密钥；同一接口换模型不重启，平台 ↔ 自定义切换后 --resume', async () => {
    const settingsFile = join(root, 'gateway.json')
    writeFileSync(settingsFile, '{}')
    const seen: (string | null)[] = []
    const host = makeHost(
      60_000,
      { ANTHROPIC_API_KEY: 'old-local-key', FAKE_CLAUDE_ENV_LOG: join(root, 'env.json') },
      r => {
        seen.push(r.provider?.id ?? r.platform?.account ?? null)
        return {
          ANTHROPIC_AUTH_TOKEN: 'loopback-only',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
          PIXELSKY_GATEWAY_SETTINGS: settingsFile,
        }
      },
    )
    const { record } = setup(host)
    await expect(host.update(record.id, { provider: { id: '../x' } })).rejects.toThrow('无效的自定义接口')
    await host.update(record.id, { provider: { id: 'p1' }, model: 'deepseek-chat' })
    await host.send(record.id, '自定义测试')
    await waitFor(() => turnsDone(record.id) === 1)
    expect(spawnArgs()[0]).toContain(settingsFile)
    expect(JSON.parse(readFileSync(join(root, 'env.json'), 'utf8'))).toEqual({
      base: 'http://127.0.0.1:1234',
      token: 'loopback-only',
    })
    expect(host.usageSummary({ range: 'today', filter: {}, now: Date.now() }).groups.route[0].key).toBe('api-key')
    // 引擎报的费用不用：fake-model 对不上官方价格，只留 token
    const stats = host.open(record.id).items.find(i => i.kind === 'turn_stats')
    expect(stats?.kind === 'turn_stats' && stats.usage.models['fake-model']).toMatchObject({
      costUsd: null,
      costSource: 'estimate',
    })

    // 同一接口换模型：不重启
    await host.update(record.id, { model: 'deepseek-reasoner' })
    await host.send(record.id, '换模型')
    await waitFor(() => turnsDone(record.id) === 2)
    expect(spawnArgs()).toHaveLength(1)

    // 换到平台：自定义接口自动清掉，重启并接上原对话
    await host.update(record.id, { platform: { groupId: '7', account: 'a@example.com' } })
    expect(host.record(record.id)?.provider).toBeNull()
    await host.send(record.id, '平台继续')
    await waitFor(() => turnsDone(record.id) === 3)
    expect(spawnArgs()[1]).toEqual(expect.arrayContaining(['--resume', record.id, '--settings']))

    // 换回另一个自定义接口：平台清掉，再重启一次
    await host.update(record.id, { provider: { id: 'p2' } })
    expect(host.record(record.id)?.platform).toBeNull()
    await host.send(record.id, '另一个接口')
    await waitFor(() => turnsDone(record.id) === 4)
    expect(spawnArgs()).toHaveLength(3)
    expect(seen).toContain('p1')
    expect(seen).toContain('p2')
    await expect(
      host.update(record.id, { provider: { id: 'p2' }, platform: { groupId: '7', account: 'a@example.com' } }),
    ).rejects.toThrow('额度来源无效')
  })

  it('自定义 API 的费用按计价参照的官方模型估算', async () => {
    writeFileSync(join(root, 'gateway.json'), '{}')
    const host = makeHost(
      60_000,
      {},
      () => ({ ANTHROPIC_AUTH_TOKEN: 'loopback-only', PIXELSKY_GATEWAY_SETTINGS: join(root, 'gateway.json') }),
      false,
      { priceRef: (r, model) => (r.provider?.id === 'p1' && model === 'fake-model' ? 'claude-sonnet-4-5' : null) },
    )
    const { record } = setup(host)
    await host.update(record.id, { provider: { id: 'p1' } })
    await host.send(record.id, '算钱')
    await waitFor(() => turnsDone(record.id) === 1)
    const stats = host.open(record.id).items.find(i => i.kind === 'turn_stats')
    const m = stats?.kind === 'turn_stats' ? stats.usage.models['fake-model'] : undefined
    expect(m?.costSource).toBe('estimate')
    expect(m?.costUsd).toBeCloseTo((m!.input * 3 + m!.output * 15 + m!.cacheRead * 0.3 + m!.cacheWrite * 3.75) / 1e6)
  })

  it('网关模式没有网关设置文件时不启动，不落到引擎自己的登录上', async () => {
    const host = makeHost(60_000, {}, () => ({ ANTHROPIC_AUTH_TOKEN: 'loopback-only' }))
    const { record } = setup(host)
    await host.update(record.id, { provider: { id: 'p1' } })
    await host.send(record.id, '你好')
    await waitFor(() => host.open(record.id).queue[0]?.status === 'failed')
    expect(host.open(record.id).queue[0].error).toContain('本机网关不可用')
    expect(spawnArgs()).toHaveLength(0)
  })

  it('这一轮还在跑时可以切换额度来源：记录先改，当前这一轮仍用原来源，下一条消息换进程接上原对话', async () => {
    writeFileSync(join(root, 'gateway.json'), '{}')
    const modelLog = join(root, 'models.log')
    const seen: (string | null)[] = []
    const host = makeHost(60_000, { FAKE_CLAUDE_MODEL_LOG: modelLog }, r => {
      seen.push(r.provider?.id ?? r.platform?.account ?? null)
      return { ANTHROPIC_AUTH_TOKEN: 'loopback-only', PIXELSKY_GATEWAY_SETTINGS: join(root, 'gateway.json') }
    })
    const { record } = setup(host)
    await host.update(record.id, { platform: { groupId: '7', account: 'a@example.com' }, model: 'model-a' })
    await host.send(record.id, 'slow 慢一点')
    await waitFor(() => host.open(record.id).state === 'running')

    // 运行中换到自定义接口：不再报错，记录是新来源，正在执行的仍是原来源和原模型
    await host.update(record.id, { provider: { id: 'p1' }, model: 'deepseek-chat' })
    expect(host.open(record.id).record).toMatchObject({
      platform: null,
      provider: { id: 'p1' },
      model: 'deepseek-chat',
    })
    expect(host.record(record.id)).toMatchObject({
      platform: { groupId: '7', account: 'a@example.com' },
      provider: null,
      model: 'model-a',
    })
    expect(host.open(record.id).execution).toMatchObject({ platform: { account: 'a@example.com' }, provider: null })
    // 还没生效时再改新来源的模型，也不动当前这一轮
    await host.update(record.id, { model: 'deepseek-reasoner' })
    expect(host.record(record.id)?.model).toBe('model-a')
    // 同一来源下的其它设置照旧实时生效
    await host.update(record.id, { permissionMode: 'ask' })
    expect(host.record(record.id)?.permissionMode).toBe('ask')
    expect(host.open(record.id).state).toBe('running')
    await waitFor(() => turnsDone(record.id) === 1)
    expect(() => readFileSync(modelLog, 'utf8')).toThrow()
    expect(spawnArgs()).toHaveLength(1)
    expect(host.record(record.id)?.provider?.id).toBe('p1')

    // 下一条消息：换进程，--resume 接上原对话，用新来源和新模型
    await host.send(record.id, '换了来源')
    await waitFor(() => turnsDone(record.id) === 2)
    expect(spawnArgs()).toHaveLength(2)
    expect(spawnArgs()[1]).toEqual(expect.arrayContaining(['--resume', record.id]))
    expect(spawnArgs()[1][spawnArgs()[1].indexOf('--model') + 1]).toBe('deepseek-reasoner')
    expect(seen).toEqual(['a@example.com', 'p1'])
  })

  it('运行中同一账号换分组照旧实时生效，不算换来源', async () => {
    writeFileSync(join(root, 'gateway.json'), '{}')
    const host = makeHost(60_000, {}, () => ({
      ANTHROPIC_AUTH_TOKEN: 'loopback-only',
      PIXELSKY_GATEWAY_SETTINGS: join(root, 'gateway.json'),
    }))
    const { record } = setup(host)
    await host.update(record.id, { platform: { groupId: '7', account: 'a@example.com' } })
    await host.send(record.id, 'slow 慢一点')
    await waitFor(() => host.open(record.id).state === 'running')
    await host.update(record.id, { platform: { groupId: '9', account: 'a@example.com' } })
    expect(host.record(record.id)?.platform?.groupId).toBe('9')
    await waitFor(() => turnsDone(record.id) === 1)
    expect(spawnArgs()).toHaveLength(1)
  })

  it('发一条消息：流式回复、标题、引擎会话 id、保存后能重新读出', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)

    const snap = host.open(record.id)
    expect(snap.state).toBe('idle')
    expect(snap.items.map(i => i.kind)).toEqual(['user', 'assistant', 'turn_stats'])
    expect(snap.items[1]).toMatchObject({ text: '收到：你好', status: 'completed' })
    expect(snap.record).toMatchObject({ title: '你好', engineSessionId: record.id, lastOutcome: 'completed' })
    expect(snap.usage).toMatchObject({ contextWindow: 200000, contextTokens: 100 })

    const args = spawnArgs()[0]
    expect(args).toEqual(
      expect.arrayContaining(['--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--effort', 'high']),
    )
    expect(args.slice(-2)).toEqual(['--session-id', record.id])

    // 新的 host 实例（模拟重启应用）读出同样的会话和条目
    const again = makeHost()
    expect(again.sessions().map(s => s.record.title)).toEqual(['你好'])
    expect(again.open(record.id).items.map(i => i.kind)).toEqual(['user', 'assistant', 'turn_stats'])
  })

  it('审批：等待中 → 始终允许（本会话）→ 写入成功；之后同类操作不再问', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await host.send(record.id, '写文件')
    const req = await waitFor(() => host.open(record.id).pending[0])
    expect(host.open(record.id).state).toBe('waiting')
    expect(req).toMatchObject({ kind: 'file_change', title: '写入文件', alwaysScopes: ['session', 'project', 'user'] })
    expect(req.changes?.[0]).toMatchObject({ path: 'hello.txt', added: 1 })

    host.answer(record.id, req.requestId, { type: 'allow_always', scope: 'session' })
    await waitFor(() => turnsDone(record.id) === 1)
    const snap = host.open(record.id)
    expect(snap.items.map(i => i.kind)).toEqual(['user', 'file_change', 'assistant', 'turn_stats'])
    expect(snap.items[1]).toMatchObject({ status: 'completed' })
    expect(snap.record.permissionMode).toBe('ask')
    expect(permLog()).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'session' },
    ])

    await host.send(record.id, '再写文件')
    await waitFor(() => turnsDone(record.id) === 2)
    expect(sessionEvents(record.id).filter(e => e.type === 'approval_request')).toHaveLength(1)
  })

  it('审批：始终允许（本项目 / 所有项目）保存到对应的设置文件', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await host.send(record.id, '写文件')
    const req = await waitFor(() => host.open(record.id).pending[0])
    host.answer(record.id, req.requestId, { type: 'allow_always', scope: 'project' })
    await waitFor(() => turnsDone(record.id) === 1)
    expect(permLog()[0]).toMatchObject({ destination: 'localSettings' })

    const other = host.createSession({ projectId: record.projectId })
    await host.send(other.id, '写文件')
    const req2 = await waitFor(() => host.open(other.id).pending[0])
    host.answer(other.id, req2.requestId, { type: 'allow_always', scope: 'user' })
    await waitFor(() => turnsDone(other.id) === 1)
    expect(permLog()[1]).toMatchObject({ destination: 'userSettings' })
  })

  it('审批：拒绝 → 条目标成 declined，这一轮照常结束', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await host.send(record.id, '写文件')
    const req = await waitFor(() => host.open(record.id).pending[0])
    host.answer(record.id, req.requestId, { type: 'deny' })
    await waitFor(() => turnsDone(record.id) === 1)
    expect(host.open(record.id).items[1]).toMatchObject({ kind: 'file_change', status: 'declined' })
  })

  it('中断：这一轮结果是 interrupted，进程还在，能接着发', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await host.send(record.id, '慢一点数数')
    await waitFor(() => sessionEvents(record.id).some(e => e.type === 'item_delta'))
    await host.interrupt(record.id)
    await waitFor(() => turnsDone(record.id) === 1)
    expect(sessionEvents(record.id).find(e => e.type === 'turn_completed')).toMatchObject({ outcome: 'interrupted' })

    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 2)
    expect(spawnArgs()).toHaveLength(1)
  })

  it('引擎崩溃：保留失败消息并暂停，撤回后新消息重启并恢复会话', async () => {
    const host = makeHost()
    const { record } = setup(host)
    // 引擎意外退出默认会自动重连（queue.ts reconnect），这里测的是不重连时的失败处理
    host.setRetrySettings(0)
    await host.send(record.id, '崩溃吧')
    await waitFor(() => turnsDone(record.id) === 1)
    const done = sessionEvents(record.id).find(e => e.type === 'turn_completed')
    expect(done).toMatchObject({ outcome: 'failed' })
    expect(done?.type === 'turn_completed' && done.error).toContain('boom')

    expect(host.open(record.id).queuePaused).toBe(true)
    host.cancelQueued(record.id, host.open(record.id).queue[0].id)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 2)
    const second = spawnArgs()[1]
    expect(second).toEqual(expect.arrayContaining(['--resume', record.id]))
  })

  it('待处理：失败后会话摘要带错误和暂停的队列，重启后不打开会话也能看到，成功后清空', async () => {
    const host = makeHost()
    const { record } = setup(host)
    // 引擎意外退出默认会自动重连（queue.ts reconnect），这里测的是不重连时的失败处理
    host.setRetrySettings(0)
    await host.send(record.id, '崩溃吧')
    await waitFor(() => turnsDone(record.id) === 1)
    const summary = () => host.sessions().find(s => s.record.id === record.id)!
    expect(summary().record.lastError).toContain('boom')
    expect(summary().queue).toEqual({ queued: 0, failed: 1, paused: true })
    // 队列进入暂停时广播一次会话列表，待处理不用打开会话就能看到
    const broadcast = events.filter(e => e.kind === 'sessions').at(-1)
    expect(
      broadcast?.kind === 'sessions' && broadcast.sessions.find(s => s.record.id === record.id)?.queue?.paused,
    ).toBe(true)

    const restarted = makeHost()
    const cold = restarted.sessions().find(s => s.record.id === record.id)!
    expect(cold.queue).toEqual({ queued: 0, failed: 1, paused: true })
    expect(cold.record.lastError).toContain('boom')

    host.cancelQueued(record.id, host.open(record.id).queue[0].id)
    expect(summary().queue).toBeUndefined()
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 2)
    expect(summary().record).toMatchObject({ lastOutcome: 'completed', lastError: null })
  })

  it('最后一句回复：一轮结束后写进记录并持久化，没有回复的一轮不改旧值', async () => {
    const host = makeHost()
    const { record } = setup(host)
    expect(host.open(record.id).record.lastReply ?? null).toBeNull()
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    const reply = () => host.sessions().find(s => s.record.id === record.id)!.record.lastReply
    expect(reply()).toBe('收到：你好')
    // 和 lastOutcome 同一次保存：重启后冷读出来也在
    expect(
      makeHost()
        .sessions()
        .find(s => s.record.id === record.id)?.record.lastReply,
    ).toBe('收到：你好')

    // 只有用户消息的一轮（引擎崩了、没有任何回复）：outcome 变了，lastReply 保持上一次的
    await host.send(record.id, '崩溃吧')
    await waitFor(() => turnsDone(record.id) === 2)
    expect(host.open(record.id).record.lastOutcome).toBe('failed')
    expect(reply()).toBe('收到：你好')

    host.cancelQueued(record.id, host.open(record.id).queue[0].id)
    await host.send(record.id, '再来一次')
    await waitFor(() => turnsDone(record.id) === 3)
    expect(reply()).toBe('收到：再来一次')
  })

  it('会话里加提示：还没开始过的会话不加（加了就不算空会话，换引擎会改走接力）', async () => {
    const host = makeHost()
    const { record } = setup(host)
    host.addNotice(record.id, 'warn', '手机把模式改成了「只规划」')
    expect(host.open(record.id).items).toEqual([])
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    host.addNotice(record.id, 'warn', '手机把模型改成了「opus」')
    expect(host.open(record.id).items.at(-1)).toMatchObject({
      kind: 'notice',
      level: 'warn',
      text: '手机把模型改成了「opus」',
    })
  })

  it('空闲回收：进程被关掉后，下次发消息用 --resume 恢复', async () => {
    const host = makeHost(50)
    const { record } = setup(host)
    await host.send(record.id, '第一句')
    await waitFor(() => turnsDone(record.id) === 1)
    await new Promise(r => setTimeout(r, 300))
    await host.send(record.id, '第二句')
    await waitFor(() => turnsDone(record.id) === 2)
    const args = spawnArgs()
    expect(args).toHaveLength(2)
    expect(args[1].slice(-2)).toEqual(['--resume', record.id])
  })

  it('运行中改权限模式：实时生效；新消息入队，停止时保留并暂停', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await host.send(record.id, '慢慢说')
    await waitFor(() => sessionEvents(record.id).some(e => e.type === 'item_delta'))
    const queued = await host.send(record.id, '插话')
    expect(host.open(record.id).queue.find(q => q.id === queued.queueId)?.status).toBe('queued')
    const before = host.defaults().permissionMode
    await host.update(record.id, { permissionMode: 'full' })
    expect(host.open(record.id).record.permissionMode).toBe('full')
    // 完全放行不记成新会话的默认（docs/ui/full-access-confirm.md）；别的模式照旧记住
    expect(host.defaults().permissionMode).toBe(before)
    await host.update(record.id, { permissionMode: 'plan' })
    expect(host.defaults().permissionMode).toBe('plan')
    await host.update(record.id, { permissionMode: 'full' })
    await host.interrupt(record.id)
    await waitFor(() => turnsDone(record.id) === 1)
    expect(host.open(record.id).queuePaused).toBe(true)
    expect(host.open(record.id).queue.map(q => q.text)).toEqual(['插话'])
  })

  it('Ultracode：启动时打开，引擎报告可用；会话中途可以关掉', async () => {
    const host = makeHost()
    const { record } = setup(host, true)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    let snap = host.open(record.id)
    expect(snap.flags.ultracodeAvailable).toBe(true)
    expect(snap.record.ultracode).toBe(true)
    await host.update(record.id, { ultracode: false })
    snap = host.open(record.id)
    expect(snap.record.ultracode).toBe(false)
    expect(host.defaults().ultracode).toBe(false)
  })

  it('Ultracode：当前模型不支持时自动关掉并提示', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_NO_ULTRACODE: '1' })
    const { record } = setup(host, true)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    const snap = host.open(record.id)
    expect(snap.flags.ultracodeAvailable).toBe(false)
    expect(snap.record.ultracode).toBe(false)
    expect(snap.items.some(i => i.kind === 'notice' && i.text.includes('不支持 Ultracode'))).toBe(true)
  })

  it('Fast 模式：能开时打开，引擎报告 on', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await host.update(record.id, { fast: true })
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    const snap = host.open(record.id)
    expect(snap.record.fast).toBe(true)
    expect(snap.flags).toMatchObject({ fastState: 'on', fastAvailable: true })
    await host.update(record.id, { fast: false })
    expect(host.open(record.id).flags.fastState).toBe('off')
  })

  it('Fast 模式：账号不支持时自动关掉并提示原因', async () => {
    const host = makeHost(60_000, { FAKE_CLAUDE_FAST_BLOCKED: 'not_first_party' })
    const { record } = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    expect(host.open(record.id).flags).toMatchObject({ fastAvailable: false, fastBlocked: 'not_first_party' })
    await host.update(record.id, { fast: true })
    const snap = host.open(record.id)
    expect(snap.record.fast).toBe(false)
    expect(snap.items.some(i => i.kind === 'notice' && i.text.includes('只支持 Anthropic 官方接口'))).toBe(true)
  })

  it('显示思考摘要：启动时按设置发 summarized，关掉后发 omitted', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    await host.update(record.id, { thinkingSummaries: false })
    expect(thinkingLog()).toEqual(['summarized', 'omitted'])
    expect(host.open(record.id).record.thinkingSummaries).toBe(false)
  })

  it('子智能体：子智能体条、工具行标出子智能体、智能体追踪的总数', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await host.send(record.id, '派个子任务')
    await waitFor(() => turnsDone(record.id) === 1)
    const snap = host.open(record.id)
    expect(snap.subagents).toEqual([
      {
        id: 'agent1',
        label: '读 README',
        status: 'completed',
        message: '读完了',
        // 进度卡片「正在做什么」那一行用的（docs/ui/progress-card.md §9）
        toolUseId: expect.any(String),
        task: '读一下 README',
        lastTool: 'Read',
        result: '读完了',
      },
    ])
    const read = snap.items.find(i => i.kind === 'tool' && i.name === 'Read')
    expect(read).toMatchObject({ subagent: '读 README', status: 'completed' })
    expect(snap.runs.agents).toHaveLength(1)
    expect(snap.runs.agents[0]).toMatchObject({
      id: 'agent1',
      label: '读 README',
      type: 'general-purpose',
      model: 'claude-sonnet-5-5',
      tokens: 1500,
      state: 'completed',
    })
    // 子智能体是前台的，不算后台任务，不插结束提示
    expect(snap.items.some(i => i.kind === 'notice')).toBe(false)
  })

  it('输入建议：一轮结束后出现，发下一条消息时清掉', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => host.open(record.id).suggestion)
    expect(host.open(record.id).suggestion).toBe('接着说')
    await host.send(record.id, '再来')
    expect(host.open(record.id).suggestion).toBeNull()
    await waitFor(() => turnsDone(record.id) === 2)
  })

  it('后台任务：列出（不含 ambient）、进度、读输出、停止后消失并提示', async () => {
    const host = makeHost()
    const { record } = setup(host)
    await host.send(record.id, '起个后台服务')
    await waitFor(() => turnsDone(record.id) === 1)
    let snap = host.open(record.id)
    expect(snap.tasks).toEqual([{ id: 'bg1', kind: 'local_bash', description: 'npm run dev', message: '服务已启动' }])
    expect(await host.taskOutput(record.id, 'bg1')).toEqual({ output: 'listening on 3000\n', truncated: false })
    await host.stopTask(record.id, 'bg1')
    await waitFor(() => host.open(record.id).tasks.length === 0)
    snap = host.open(record.id)
    expect(snap.items.some(i => i.kind === 'notice' && i.text === '后台命令已停止：npm run dev')).toBe(true)
  })

  it('智能体追踪：重新打开的会话从保存的文件读出以前的编排和子智能体，能读子智能体的对话', async () => {
    const projectsDir = join(root, 'claude-projects')
    const host = makeHost()
    const { record } = setup(host)
    const enc = record.cwd.replace(/[^A-Za-z0-9]/g, '-')
    const sessionDir = join(projectsDir, enc, record.id)
    mkdirSync(join(sessionDir, 'workflows'), { recursive: true })
    mkdirSync(join(sessionDir, 'subagents', 'workflows', 'wf_1'), { recursive: true })
    writeFileSync(
      join(sessionDir, 'workflows', 'wf_1.json'),
      JSON.stringify({
        taskId: 'w1',
        workflowName: 'review',
        summary: '审查改动',
        status: 'completed',
        startTime: 100,
        durationMs: 3000,
        totalTokens: 5000,
        totalToolCalls: 4,
        workflowProgress: [
          { type: 'workflow_phase', index: 1, title: '查找' },
          {
            type: 'workflow_agent',
            agentId: 'a1',
            label: 'bugs-0',
            phaseIndex: 1,
            model: 'claude-sonnet-5-5',
            state: 'done',
            startedAt: 100,
            durationMs: 2000,
            tokens: 2500,
            toolCalls: 2,
            promptPreview: '找 bug',
          },
        ],
      }),
    )
    writeFileSync(
      join(projectsDir, enc, `${record.id}.jsonl`),
      [
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: 'Agent',
                input: { description: '读 a.txt', subagent_type: 'general-purpose' },
              },
            ],
          },
        },
        {
          type: 'user',
          timestamp: '2026-10-05T04:51:10.000Z',
          toolUseResult: {
            agentId: 'a9',
            status: 'completed',
            resolvedModel: 'claude-sonnet-5-5',
            totalTokens: 300,
            totalToolUseCount: 1,
            totalDurationMs: 4000,
          },
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'alpha' }] },
        },
      ]
        .map(r => JSON.stringify(r))
        .join('\n') + '\n',
    )
    writeFileSync(
      join(sessionDir, 'subagents', 'workflows', 'wf_1', 'agent-a1.jsonl'),
      [
        {
          type: 'user',
          message: { content: '[Workflow harness]\nThe computed task text follows:\n  找 bug\n  然后汇报' },
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: '看看文件' },
              { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: join(record.cwd, 'a.txt') } },
            ],
          },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'alpha' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '没发现问题' }] } },
      ]
        .map(r => JSON.stringify(r))
        .join('\n') + '\n',
    )
    const again = makeHost()
    const runs = again.open(record.id).runs
    expect(runs.workflows[0]).toMatchObject({
      id: 'w1',
      name: 'review',
      tokens: 5000,
      phases: [{ index: 1, title: '查找' }],
    })
    expect(runs.workflows[0].agents[0]).toMatchObject({ id: 'a1', label: 'bugs-0', phase: 1, prompt: '找 bug' })
    expect(runs.agents[0]).toMatchObject({ id: 'a9', label: '读 a.txt', tokens: 300, durationMs: 4000 })
    const items = await again.subagentTranscript(record.id, 'a1')
    expect(items.map(i => i.kind)).toEqual(['user', 'reasoning', 'tool', 'assistant'])
    expect(items[0]).toMatchObject({ text: '找 bug\n然后汇报' })
    expect(items[2]).toMatchObject({ name: 'Read', status: 'completed', output: 'alpha' })
    expect(() => again.subagentTranscript(record.id, '../x')).toThrow()
  })

  it('用量记录：每轮一条，进程重启后差值从零算起；统计行、汇总、CSV、清空', async () => {
    const host = makeHost(50)
    const { record, project } = setup(host)
    await host.send(record.id, '第一句')
    await waitFor(() => turnsDone(record.id) === 1)
    await host.send(record.id, '第二句')
    await waitFor(() => turnsDone(record.id) === 2)
    // 等空闲回收，第三句在新进程里（累计值从零开始）
    await new Promise(r => setTimeout(r, 300))
    await host.send(record.id, '第三句')
    await waitFor(() => turnsDone(record.id) === 3)
    expect(spawnArgs()).toHaveLength(2)

    const stats = host.open(record.id).items.filter(i => i.kind === 'turn_stats')
    expect(stats).toHaveLength(3)
    for (const s of stats) {
      if (s.kind !== 'turn_stats') continue
      expect(s.usage.models['fake-model']).toMatchObject({
        input: 10,
        cacheRead: 90,
        cacheWrite: 0,
        output: 5,
        requests: 1,
      })
      expect(s.usage.models['fake-model'].costUsd).toBeCloseTo(0.01)
    }

    const now = Date.now()
    const sum = host.usageSummary({ range: 'today', filter: {}, now })
    expect(sum.totals).toMatchObject({ input: 30, cacheRead: 270, output: 15, records: 3, turns: 3, requests: 3 })
    expect(sum.totals.costUsd).toBeCloseTo(0.03)
    expect(sum.groups.project[0]).toMatchObject({ key: project.name, records: 3 })
    expect(sum.groups.route[0]).toMatchObject({ key: 'cli' })

    const page = host.usageList({ range: '7d', filter: { model: 'fake-model' }, now, offset: 0, limit: 2 })
    expect(page).toMatchObject({ total: 3, offset: 0 })
    expect(page.records).toHaveLength(2)
    expect(page.records[0]).toMatchObject({
      sessionId: record.id,
      engine: 'claude',
      route: 'cli',
      outcome: 'completed',
      sessionTitle: '第一句',
    })

    const csv = host.usageCsv({ range: '30d', filter: {}, now })
    // 表头 + 3 条记录
    expect(csv.split(/\r\n/).filter(Boolean)).toHaveLength(4)
    expect(events.filter(e => e.kind === 'usage_recorded')).toHaveLength(3)

    // 重启应用后记录还在；清空后没有了
    const again = makeHost()
    expect(again.usageSummary({ range: 'today', filter: {}, now }).totals.records).toBe(3)
    again.usageClear()
    expect(again.usageSummary({ range: 'today', filter: {}, now }).totals.records).toBe(0)
  })
})

describe('回退到某条用户消息之前（Claude 假引擎，模拟真实记录链）', () => {
  const chainLog = () => join(root, 'chain.log')
  const visible = (): string[][] =>
    readFileSync(chainLog(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as string[])
  const chainHost = () => makeHost(60_000, { FAKE_CLAUDE_CHAIN: '1', FAKE_CLAUDE_CHAIN_LOG: chainLog() })
  const userTexts = (host: EngineHost, id: string) =>
    host.open(id).items.flatMap(i => (i.kind === 'user' ? [i.text] : []))

  it('移除这条及之后的对话，返回原文，下一轮从它之前的上下文接上', async () => {
    const host = chainHost(),
      { record } = setup(host)
    for (const [i, text] of ['一', '二', '三'].entries()) {
      await host.send(record.id, { text, clientMessageId: `m${i}` })
      await waitFor(() => turnsDone(record.id) === i + 1)
    }
    const second = host.open(record.id).items.find(i => i.kind === 'user' && i.text === '二')!
    await expect(host.rewind(record.id, second.id)).resolves.toEqual({ text: '二', undoable: true })
    expect(userTexts(host, record.id)).toEqual(['一'])
    expect(host.open(record.id).items.some(i => i.kind === 'turn_stats')).toBe(true)
    expect(host.open(record.id).record.pendingRewind).toBeTruthy()
    // 重启后对话记录仍是截断后的
    const reopened = makeHost(60_000, { FAKE_CLAUDE_CHAIN: '1', FAKE_CLAUDE_CHAIN_LOG: chainLog() })
    expect(userTexts(reopened, record.id)).toEqual(['一'])
    await host.send(record.id, { text: '改', clientMessageId: 'm3' })
    await waitFor(() => turnsDone(record.id) === 4)
    const args = spawnArgs().at(-1)!
    expect(args.some(a => a.startsWith('--resume-session-at='))).toBe(true)
    expect(visible().at(-1)).toEqual(['一'])
    expect(host.open(record.id).record.pendingRewind).toBeNull()
    expect(userTexts(host, record.id)).toEqual(['一', '改'])
  })

  it('回退第一条消息换新的引擎会话；运行中拒绝；只能回退自己的消息', async () => {
    const host = chainHost(),
      { record } = setup(host)
    await host.send(record.id, { text: '一', clientMessageId: 'a' })
    await waitFor(() => turnsDone(record.id) === 1)
    const oldSid = host.open(record.id).record.engineSessionId
    const assistant = host.open(record.id).items.find(i => i.kind === 'assistant')!
    await expect(host.rewind(record.id, assistant.id)).rejects.toThrow('自己发送')
    await host.rewind(record.id, 'a')
    expect(host.open(record.id).items).toEqual([])
    expect(host.open(record.id).record.engineSessionId).not.toBe(oldSid)
    await host.send(record.id, { text: '新', clientMessageId: 'b' })
    await waitFor(() => host.open(record.id).state === 'running')
    await expect(host.rewind(record.id, 'b')).rejects.toThrow('停止')
    await waitFor(() => turnsDone(record.id) === 2)
    expect(visible().at(-1)).toEqual([])
  })

  it('原生记录缺失时清除旧引擎会话，不能默默恢复被回退的上下文', async () => {
    const host = chainHost(),
      { record } = setup(host)
    await host.send(record.id, { text: '一', clientMessageId: 'lost-a' })
    await waitFor(() => turnsDone(record.id) === 1)
    const oldSid = host.open(record.id).record.engineSessionId
    rmSync(join(root, 'claude-projects'), { recursive: true, force: true })
    await host.rewind(record.id, 'lost-a')
    expect(host.open(record.id).record.engineSessionId).not.toBe(oldSid)
    expect(host.open(record.id).record.pendingRewind).toBeNull()
    // 回到最开头：没有保留的对话，不用提示也不用交接
    expect(host.open(record.id).items.some(i => i.kind === 'notice')).toBe(false)
    expect(host.open(record.id).record.engineSessions?.claude?.seen).toBeNull()
  })

  it('截断点在引擎记录里找不到时换新的引擎会话并提示，不再重复失败', async () => {
    const host = chainHost(),
      { record } = setup(host)
    await host.send(record.id, { text: '一', clientMessageId: 'a' })
    await waitFor(() => turnsDone(record.id) === 1)
    await host.send(record.id, { text: '二', clientMessageId: 'b' })
    await waitFor(() => turnsDone(record.id) === 2)
    await host.rewind(record.id, 'b')
    await host.update(record.id, {})
    ;(host as unknown as { runtimes: Map<string, { snapshot: { record: SessionRecord } }> }).runtimes.get(
      record.id,
    )!.snapshot.record.pendingRewind = 'missing-uuid'
    await host.send(record.id, { text: '三', clientMessageId: 'c' })
    await waitFor(() => turnsDone(record.id) === 3)
    expect(host.open(record.id).items.some(i => i.kind === 'notice' && i.text.includes('回退'))).toBe(true)
    expect(host.open(record.id).record.pendingRewind).toBeNull()
  })
})

describe('停止时连同后台子智能体', () => {
  const controlLog = (): string[] => {
    try {
      return readFileSync(join(root, 'argv.control.log'), 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  const start = async (host: EngineHost) => {
    const { record } = setup(host)
    await host.send(record.id, '并行跑')
    await waitFor(() => host.open(record.id).tasks.length === 4 && host.open(record.id).state !== 'idle')
    return record
  }
  const notices = (id: string) =>
    host0(id)
      .items.filter(i => i.kind === 'notice')
      .map(i => (i as { text: string }).text)
  let hostRef: EngineHost
  const host0 = (id: string) => hostRef.open(id)

  it('background: true：后台子智能体和编排都停，后台命令留着；只有一条汇总提示', async () => {
    const host = (hostRef = makeHost())
    const record = await start(host)
    await host.interrupt(record.id, { background: true })
    await waitFor(() => host.open(record.id).state === 'idle')
    await waitFor(() => host.open(record.id).tasks.length === 1)
    const snap = host.open(record.id)
    expect(snap.tasks.map(t => t.id)).toEqual(['bg1'])
    expect(snap.subagents.map(s => [s.label, s.status])).toEqual([
      ['甲', 'stopped'],
      ['乙', 'stopped'],
    ])
    const list = notices(record.id)
    expect(list.filter(t => t.startsWith('已停止，连同'))).toEqual(['已停止，连同 3 个后台子智能体（甲、乙、编排）'])
    expect(list.some(t => t.includes('已停止：'))).toBe(false)
    const log = controlLog()
    expect(log.indexOf('stop_task')).toBeGreaterThanOrEqual(0)
    expect(log.indexOf('stop_task')).toBeLessThan(log.lastIndexOf('interrupt'))
  })

  it('不带选项：四个后台任务都还在，没有汇总提示', async () => {
    const host = (hostRef = makeHost())
    const record = await start(host)
    await host.interrupt(record.id)
    await waitFor(() => host.open(record.id).state === 'idle')
    const snap = host.open(record.id)
    expect(snap.tasks).toHaveLength(4)
    expect(snap.background).toBe(3)
    expect(notices(record.id).some(t => t.startsWith('已停止，连同'))).toBe(false)
    expect(controlLog()).not.toContain('stop_task')
  })

  it('interruptTurn 不会停后台任务', async () => {
    const host = (hostRef = makeHost())
    const record = await start(host)
    const turnId = host.open(record.id).turnId as string
    expect(await host.interruptTurn(record.id, turnId)).toBe(true)
    await waitFor(() => host.open(record.id).state === 'idle')
    expect(host.open(record.id).tasks).toHaveLength(4)
    expect(controlLog()).not.toContain('stop_task')
  })
})
