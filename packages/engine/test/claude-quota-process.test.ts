// Claude 账号额度的真进程部分（docs/ui/account-quota.md §3.2、§7.1）：引擎用 test/fakes/fake-claude.mjs 代替
// - 有会话进程：借它发 get_usage（运行中也能发，不进对话、不新起进程）
// - 没有会话进程：起临时进程问完就关；应用退出时 close() 杀掉；旧版不认识 get_usage 时降级
// - 网关会话（平台 / 自定义接口）的 rate_limit_event 不上报
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AccountQuota, HostEvent, SessionRecord } from '@pixelsky/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter, EngineHost, type SessionContext } from '../src'
import { ownClaudePids } from '../src/claude/process'

const FAKE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))

let root: string
let events: HostEvent[]
let quotas: AccountQuota[]
let hosts: EngineHost[]

function adapterFor(env: NodeJS.ProcessEnv = {}, sessionEnv?: (record: SessionRecord) => NodeJS.ProcessEnv) {
  return new ClaudeAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    projectsDir: join(root, 'claude-projects'),
    sessionEnv,
    // 配置目录指到临时目录：不读本机真实的 ~/.claude（套餐倍数从那里的凭据文件取，tier.ts）
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
      FAKE_CLAUDE_LOG: join(root, 'argv.log'),
      ...env,
    },
  })
}

function makeHost(env: NodeJS.ProcessEnv = {}, sessionEnv?: (record: SessionRecord) => NodeJS.ProcessEnv): EngineHost {
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    emit: e => events.push(e),
    onQuota: q => quotas.push(q),
    adapters: { claude: adapterFor(env, sessionEnv) },
  })
  hosts.push(host)
  return host
}

function lines(file: string): string[] {
  try {
    return readFileSync(join(root, file), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}
const spawns = (): string[][] => lines('argv.log').map(l => JSON.parse(l) as string[])
const controls = (): string[] => lines('argv.control.log')

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
const turnsDone = (id: string): number => sessionEvents(id).filter(e => e.type === 'turn_completed').length

function setup(host: EngineHost) {
  const projectDir = mkdtempSync(join(root, 'proj-'))
  const project = host.addProject(projectDir)
  return host.createSession({ projectId: project.id, permissionMode: 'ask', effort: 'high' })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-quota-'))
  mkdirSync(join(root, 'claude-projects'))
  events = []
  quotas = []
  hosts = []
  // Claude Code 的 shell 里设了这两个；它们会影响假引擎的启动和自动压缩，测试里不要带
  vi.stubEnv('NoDefaultCurrentDirectoryInExePath', '')
  vi.stubEnv('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', '')
})

afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('Claude 账号额度：借会话进程', () => {
  it('弹窗刷新借活着的会话进程：运行中也能取，不新起进程，不进对话', async () => {
    const host = makeHost({ FAKE_CLAUDE_QUOTA: '1' })
    const record = setup(host)
    await host.send(record.id, '慢一点')
    await waitFor(() => sessionEvents(record.id).some(e => e.type === 'turn_started'))
    await waitFor(() => controls().includes('initialize'))
    // 进程起来之后、这一轮还在跑
    await waitFor(() => sessionEvents(record.id).some(e => e.type === 'item_delta'))
    const items = host.open(record.id).items.length
    const q = await host.refreshAccountQuota('claude', { force: true })
    expect(q).toMatchObject({ provider: 'claude', status: 'ok', plan: 'max', source: 'usage', refreshable: true })
    expect(q.windows.map(w => [w.id, w.usedPercent])).toEqual([
      ['five_hour', 4],
      ['seven_day', 68],
    ])
    expect(q.extras.models?.[0]).toMatchObject({ name: 'Fable', usedPercent: 0 })
    expect(spawns()).toHaveLength(1)
    expect(controls().filter(c => c === 'get_usage')).toHaveLength(1)
    expect(host.open(record.id).items.length).toBeGreaterThanOrEqual(items)
    expect(host.open(record.id).items.some(i => JSON.stringify(i).includes('get_usage'))).toBe(false)
    await waitFor(() => turnsDone(record.id) === 1)
    expect(await host.accountQuota('claude')).toBe(q)
    expect(quotas.at(-1)).toBe(q)
  })

  it('对话里的 rate_limit_event 合并进快照并广播；一轮结束后不重复 get_usage（刚取过）', async () => {
    const host = makeHost({ FAKE_CLAUDE_QUOTA: '1', FAKE_CLAUDE_RATE_EVENT: '1' })
    const record = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    await waitFor(() => quotas.length > 0)
    expect(quotas[0]).toMatchObject({ provider: 'claude', status: 'ok', source: 'event', fetchedAt: null })
    expect(quotas[0].windows.map(w => [w.id, w.usedPercent])).toEqual([
      ['five_hour', 3],
      ['seven_day', 67],
    ])
    // 事件里没有的字段不动：这时还没有 get_usage 的数据
    const q = await host.refreshAccountQuota('claude')
    expect(q).toMatchObject({ source: 'usage', plan: 'max' })
    expect(q.windows[0].usedPercent).toBe(4)
    expect(spawns()).toHaveLength(1)
    // 再聊一轮：事件把百分比改回 3 / 67，不再另外发 get_usage（5 分钟内取过）
    await host.send(record.id, '再来一句')
    await waitFor(() => turnsDone(record.id) === 2)
    await waitFor(() => quotas.at(-1)?.source === 'event')
    expect(controls().filter(c => c === 'get_usage')).toHaveLength(1)
    expect((await host.accountQuota('claude'))?.windows[0].usedPercent).toBe(3)
    expect((await host.accountQuota('claude'))?.plan).toBe('max')
  })

  it('平台会话收到的 rate_limit_event 不算到用户自己的账号上', async () => {
    const settingsFile = join(root, 'gateway.json')
    writeFileSync(settingsFile, '{}')
    const host = makeHost({ FAKE_CLAUDE_RATE_EVENT: '1' }, () => ({
      ANTHROPIC_AUTH_TOKEN: 'loopback-only',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
      PIXELSKY_GATEWAY_SETTINGS: settingsFile,
    }))
    const record = setup(host)
    await host.update(record.id, { platform: { groupId: '7', account: 'test@example.com' }, model: 'real-model' })
    await host.send(record.id, '平台')
    await waitFor(() => turnsDone(record.id) === 1)
    await new Promise(r => setTimeout(r, 100))
    expect(quotas).toEqual([])
    expect(await host.accountQuota('claude')).toBeNull()
  })
})

describe('Claude 账号额度：会话层的网关过滤', () => {
  /** 直接用适配器建会话，ctx 是手写的：不经过宿主的核对，单独验证适配器这一层 */
  async function runTurn(extra: Partial<SessionRecord>) {
    const adapter = adapterFor({ FAKE_CLAUDE_RATE_EVENT: '1' }, () => ({
      PIXELSKY_GATEWAY_SETTINGS: join(root, 'gateway.json'),
    }))
    writeFileSync(join(root, 'gateway.json'), '{}')
    await adapter.info()
    const reported: unknown[] = []
    const emitted: { type: string; outcome?: string }[] = []
    const record = {
      id: 'sess-1',
      projectId: 'p',
      cwd: root,
      engine: 'claude',
      engineSessionId: '11111111-1111-4111-8111-111111111111',
      permissionMode: 'ask',
      effort: 'high',
      model: null,
      ...extra,
    } as unknown as SessionRecord
    const ctx = {
      record: () => record,
      emit: (e: { type: string; outcome?: string }) => emitted.push(e),
      setEngineSessionId: () => undefined,
      setPermissionMode: () => undefined,
      setUltracode: () => undefined,
      setFast: () => undefined,
      reportQuota: (patch: unknown) => reported.push(patch),
    } as unknown as SessionContext
    const session = adapter.createSession(ctx)
    try {
      session.send('你好', 'turn-1', 'user-1')
      await waitFor(() => emitted.some(e => e.type === 'turn_completed'))
      // 不是起不来导致没有上报
      expect(emitted.find(e => e.type === 'turn_completed')?.outcome).toBe('completed')
    } finally {
      await session.close()
    }
    return reported
  }

  it('自有会话上报；平台和自定义接口的会话丢掉', async () => {
    const own = await runTurn({})
    expect(own).toHaveLength(1)
    expect(own[0]).toMatchObject({
      allowed: true,
      windows: [
        { id: 'five_hour', usedPercent: 3 },
        { id: 'seven_day', usedPercent: 67 },
      ],
    })
    expect(await runTurn({ platform: { groupId: '7', account: 'x@example.com' } } as Partial<SessionRecord>)).toEqual(
      [],
    )
    expect(await runTurn({ provider: { id: 'p1' } } as Partial<SessionRecord>)).toEqual([])
  })
})

describe('Claude 账号额度：进程启动时的来源', () => {
  /** 记录可以中途改（模拟对话中途换通道，进程要等下一条消息才换）；session 是直接用适配器建的 */
  async function start(extra: Partial<SessionRecord>) {
    const adapter = adapterFor({ FAKE_CLAUDE_RATE_EVENT: '1', FAKE_CLAUDE_QUOTA: '1' }, () => ({
      PIXELSKY_GATEWAY_SETTINGS: join(root, 'gateway.json'),
    }))
    writeFileSync(join(root, 'gateway.json'), '{}')
    await adapter.info()
    const reported: unknown[] = []
    const emitted: { type: string; outcome?: string }[] = []
    const record = {
      id: 'sess-1',
      projectId: 'p',
      cwd: root,
      engine: 'claude',
      engineSessionId: '22222222-2222-4222-8222-222222222222',
      permissionMode: 'ask',
      effort: 'high',
      model: null,
      ...extra,
    } as unknown as SessionRecord
    const ctx = {
      record: () => record,
      emit: (e: { type: string; outcome?: string }) => emitted.push(e),
      setEngineSessionId: () => undefined,
      setPermissionMode: () => undefined,
      setUltracode: () => undefined,
      setFast: () => undefined,
      reportQuota: (patch: unknown) => reported.push(patch),
    } as unknown as SessionContext
    const session = adapter.createSession(ctx)
    let turns = 0
    const turn = async (): Promise<void> => {
      const n = ++turns
      session.send('你好', 'turn-' + n, 'user-' + n)
      await waitFor(() => emitted.filter(e => e.type === 'turn_completed').length === n)
    }
    return { session, record: record as unknown as Record<string, unknown>, reported, turn }
  }

  it('进程是自己账号起的，记录中途改成平台：仍然可以借、事件仍然上报（进程没换）', async () => {
    const t = await start({})
    try {
      await t.turn()
      expect(t.reported).toHaveLength(1)
      t.record.platform = { groupId: '7', account: 'x@example.com' }
      expect(t.session.accountQuota?.()).not.toBeNull()
      await t.turn()
      expect(t.reported).toHaveLength(2)
    } finally {
      await t.session.close()
    }
  })

  it('进程是网关起的，记录中途改成我的账号（平台 → 我的账号）：不借来问 get_usage，事件也不上报', async () => {
    const t = await start({ platform: { groupId: '7', account: 'x@example.com' } } as Partial<SessionRecord>)
    try {
      await t.turn()
      expect(t.reported).toEqual([])
      delete t.record.platform
      expect(t.session.accountQuota?.()).toBeNull()
      await t.turn()
      expect(t.reported).toEqual([])
      expect(controls().filter(c => c === 'get_usage')).toHaveLength(0)
    } finally {
      await t.session.close()
    }
  })
})

describe('Claude 账号额度：临时进程', () => {
  it('不同账号的读取不共用一个临时进程：等前一个结束再起自己的', async () => {
    const adapter = adapterFor({ FAKE_CLAUDE_QUOTA: '1', FAKE_CLAUDE_QUOTA_DELAY: '300' })
    const info = (await adapter.info()) as { account?: { email: string } }
    info.account = { email: 'a@example.com' }
    const first = adapter.accountQuota()
    await waitFor(() => controls().includes('get_usage'))
    info.account = { email: 'b@example.com' }
    const second = adapter.accountQuota()
    await new Promise(r => setTimeout(r, 50))
    // 前一个还没结束：没有为 B 另起进程，也没有拿 A 的结果顶替
    expect(spawns()).toHaveLength(1)
    const [a, b] = await Promise.all([first, second])
    expect(spawns()).toHaveLength(2)
    expect(a).not.toBe(b)
  })

  it('close() 之后不再起临时进程', async () => {
    const adapter = adapterFor({ FAKE_CLAUDE_QUOTA: '1' })
    await adapter.close({ quick: true })
    await expect(adapter.accountQuota()).rejects.toThrow(/unavailable/)
    expect(spawns()).toHaveLength(0)
  })

  it('等前一个读取期间应用退出：不再起下一个', async () => {
    const adapter = adapterFor({ FAKE_CLAUDE_QUOTA: '1', FAKE_CLAUDE_QUOTA_DELAY: '60000' })
    const info = (await adapter.info()) as { account?: { email: string } }
    info.account = { email: 'a@example.com' }
    const first = adapter.accountQuota().catch(() => undefined)
    await waitFor(() => controls().includes('get_usage'))
    info.account = { email: 'b@example.com' }
    const second = adapter.accountQuota()
    const outcome = second.then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await adapter.close({ quick: true })
    await first
    expect(await outcome).toMatch(/unavailable/)
    expect(spawns()).toHaveLength(1)
  })

  it('没有会话进程：起一个临时进程问完就退出，进程登记回到原样', async () => {
    const host = makeHost({ FAKE_CLAUDE_QUOTA: '1', FAKE_CLAUDE_ACCOUNT: 'someone@example.com' })
    const before = new Set(ownClaudePids)
    const q = await host.refreshAccountQuota('claude')
    expect(q).toMatchObject({ status: 'ok', plan: 'max', account: 'someone@example.com', refreshable: true })
    expect(q.windows[0].usedPercent).toBe(4)
    // 问完就关
    await waitFor(() => ownClaudePids.size === before.size)
    expect([...ownClaudePids].sort()).toEqual([...before].sort())
    // 只起了一个进程，不带会话参数，只发了 initialize 和 get_usage
    expect(spawns()).toHaveLength(1)
    expect(spawns()[0]).not.toContain('--session-id')
    expect(spawns()[0]).not.toContain('--resume')
    expect(controls()).toEqual(['initialize', 'get_usage'])
    // 回包里的账号带出来了：当前账号的快照读得到
    expect(await host.accountQuota('claude')).toMatchObject({ account: 'someone@example.com' })
  })

  it('并发读取只起一个临时进程（适配器单飞）', async () => {
    const adapter = adapterFor({ FAKE_CLAUDE_QUOTA: '1' })
    const [a, b] = await Promise.all([adapter.accountQuota(), adapter.accountQuota()])
    expect(a).toBe(b)
    expect(spawns()).toHaveLength(1)
  })

  it('adapter.close() 杀掉还在问的临时进程', async () => {
    const adapter = adapterFor({ FAKE_CLAUDE_QUOTA: '1', FAKE_CLAUDE_QUOTA_DELAY: '60000' })
    // 上一个用例的临时进程是 kill 之后异步退出的，等登记清空再数
    await waitFor(() => ownClaudePids.size === 0)
    const before = ownClaudePids.size
    const asking = adapter.accountQuota()
    const outcome = asking.then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await waitFor(() => controls().includes('get_usage'))
    expect(ownClaudePids.size).toBe(before + 1)
    await adapter.close({ quick: true })
    expect(ownClaudePids.size).toBe(before)
    expect(await outcome).toMatch(/进程已退出/)
  })

  it('读取失败（引擎回错误）：抛出带原因的错误，进程照样关掉', async () => {
    const adapter = adapterFor({ FAKE_CLAUDE_QUOTA: '1', FAKE_CLAUDE_QUOTA_FAIL: '1' })
    const before = ownClaudePids.size
    await expect(adapter.accountQuota()).rejects.toThrow('usage endpoint failed')
    await waitFor(() => ownClaudePids.size === before)
  })

  it('API Key 登录（rate_limits_available=false）→ unsupported', async () => {
    const adapter = adapterFor({ FAKE_CLAUDE_QUOTA: 'off' })
    expect(await adapter.accountQuota()).toEqual({ kind: 'unsupported' })
  })
})

describe('Claude 账号额度：旧版降级', () => {
  it('旧版报「不认识的控制请求」→ no-request，之后不再起临时进程，重新检测后重新试', async () => {
    const adapter = adapterFor({ FAKE_CLAUDE_QUOTA: 'old' })
    expect(await adapter.accountQuota()).toEqual({ kind: 'no-request' })
    expect(spawns()).toHaveLength(1)
    expect(await adapter.accountQuota()).toEqual({ kind: 'no-request' })
    expect(spawns()).toHaveLength(1)
    // 重新检测（也可能是更新 / 安装）清掉记下的结果
    await adapter.info(true)
    expect(await adapter.accountQuota()).toEqual({ kind: 'no-request' })
    expect(spawns()).toHaveLength(2)
  })

  it('旧版回 {} 也是 no-request；宿主记成 refreshable: false，只靠事件', async () => {
    const host = makeHost()
    const q = await host.refreshAccountQuota('claude')
    expect(q).toMatchObject({ status: 'empty', refreshable: false, windows: [], error: null })
    const again = await host.refreshAccountQuota('claude', { force: true })
    expect(again.refreshable).toBe(false)
  })

  it('会话进程上的旧版：借会话得到 no-request，再用临时进程试一次，也不认识才判 refreshable: false', async () => {
    const host = makeHost({ FAKE_CLAUDE_QUOTA: 'old' })
    const record = setup(host)
    await host.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    const q = await host.refreshAccountQuota('claude')
    expect(q).toMatchObject({ refreshable: false, status: 'empty' })
    // 会话进程 + 一个临时进程
    expect(spawns()).toHaveLength(2)
  })
})
