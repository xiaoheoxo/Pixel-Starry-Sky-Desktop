// Codex 账号额度的真进程部分（docs/ui/account-quota.md §3.3、§7.1）：引擎用 test/fakes/fake-codex.mjs 代替
// - 没有会话进程：用适配器的只读 app-server 读；API Key / 没登录 ChatGPT → unsupported
// - 会话里 account/rateLimits/updated 空闲时也合并；平台 / 自定义接口的会话丢掉
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AccountQuota, HostEvent, SessionRecord } from '@pixelsky/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodexAdapter, EngineHost, type SessionContext } from '../src'

const FAKE = fileURLToPath(new URL('./fakes/fake-codex.mjs', import.meta.url))
const CHATGPT = JSON.stringify({
  account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
  requiresOpenaiAuth: true,
})

let root: string
let host: EngineHost | undefined
let adapter: CodexAdapter | undefined
let quotas: AccountQuota[]
let events: HostEvent[]

function make(env: Record<string, string> = {}): CodexAdapter {
  adapter = new CodexAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    env: { ...process.env, FAKE_CODEX_LOG: join(root, 'rpc.jsonl'), ...env },
    launchOptions: () => ({ askQuestions: true, steeringValidated: true }),
    sessionEnv: () => ({ PIXELSKY_CODEX_BASE_URL: 'http://127.0.0.1:1/v1', PIXELSKY_CODEX_TOKEN: 'loopback-only' }),
  })
  return adapter
}

function makeHost(env: Record<string, string> = {}): EngineHost {
  host = new EngineHost({
    dataDir: join(root, 'engine'),
    adapters: { codex: make(env) },
    emit: e => events.push(e),
    onQuota: q => quotas.push(q),
    idleMs: 60_000,
  })
  return host
}

const rpc = (): { method?: string; params?: Record<string, unknown> }[] => {
  try {
    return readFileSync(join(root, 'rpc.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** 额度自己发的 account/rateLimits/read（检测时 catalog 读的那次不带参数；额度的要重置卡明细，显式传 false） */
const quotaReads = () =>
  rpc().filter(m => m.method === 'account/rateLimits/read' && m.params?.excludeResetCreditDetails === false)

async function waitFor<T>(pick: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = pick()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 20))
  }
}
const turnsDone = (id: string): number =>
  events.filter(e => e.kind === 'session' && e.sessionId === id && e.event.type === 'turn_completed').length

const update = (percent: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 1_792_400_400 },
    secondary: null,
    credits: null,
    planType: null,
    rateLimitReachedType: null,
    ...extra,
  })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-codex-quota-'))
  mkdirSync(join(root, 'engine'))
  quotas = []
  events = []
})
afterEach(async () => {
  await host?.shutdown()
  await adapter?.close()
  host = undefined
  adapter = undefined
  rmSync(root, { recursive: true, force: true })
})

describe('Codex 账号额度：只读进程', () => {
  it('ChatGPT 登录：用只读 app-server 读，带上邮箱，不碰线程', async () => {
    const reading = await make({ FAKE_CODEX_ACCOUNT: CHATGPT }).accountQuota()
    if (reading.kind !== 'ok') throw new Error(`expected ok, got ${reading.kind}`)
    expect(reading.account).toBe('user@example.com')
    expect(reading.plan).toBe('plus')
    expect(reading.windows.map(w => [w.id, w.usedPercent])).toEqual([
      ['five_hour', 42],
      ['seven_day', 18],
    ])
    expect(reading.extras.credits?.balance).toBe(120)
    expect(reading.extras.models?.length).toBe(2)
    const calls = rpc().flatMap(m => (m.method ? [m.method] : []))
    expect(calls).toContain('account/rateLimits/read')
    expect(calls.some(m => m.startsWith('thread/'))).toBe(false)
    // 检测时 catalog 还会读一次（不带参数），额度自己读的显式带 excludeResetCreditDetails: false（要重置卡明细）
    expect(quotaReads()).toHaveLength(1)
  })

  it('用 API Key（account/read 不是 chatgpt）→ unsupported，不去读额度', async () => {
    expect(await make().accountQuota()).toEqual({ kind: 'unsupported' })
    expect(rpc().some(m => m.method === 'account/rateLimits/read')).toBe(false)
  })

  it('读额度时报 authentication required → unsupported', async () => {
    const reading = await make({
      FAKE_CODEX_ACCOUNT: CHATGPT,
      FAKE_CODEX_RATE_LIMITS_ERROR: 'codex account authentication required to read rate limits',
    }).accountQuota()
    expect(reading).toEqual({ kind: 'unsupported' })
  })

  it('别的错误原样抛出', async () => {
    await expect(
      make({ FAKE_CODEX_ACCOUNT: CHATGPT, FAKE_CODEX_RATE_LIMITS_ERROR: 'backend exploded' }).accountQuota(),
    ).rejects.toThrow('backend exploded')
  })

  it('回包形状不对（没有 rateLimits）→ 抛「没有拿到额度数据」', async () => {
    await expect(make({ FAKE_CODEX_ACCOUNT: CHATGPT, FAKE_CODEX_RATE_LIMITS: '{}' }).accountQuota()).rejects.toThrow(
      '没有拿到额度数据',
    )
  })

  it('经宿主读取：账号、套餐、窗口都在快照里', async () => {
    const h = makeHost({ FAKE_CODEX_ACCOUNT: CHATGPT })
    const q = await h.refreshAccountQuota('chatgpt')
    expect(q).toMatchObject({ provider: 'chatgpt', status: 'ok', plan: 'plus', account: 'user@example.com' })
    expect(q.windows).toHaveLength(2)
    expect(quotas.at(-1)).toBe(q)
  })
})

describe('Codex 账号额度：登录 / 退出登录时关掉只读进程', () => {
  const reading = (a: CodexAdapter): boolean => (a as unknown as { reader: { running: boolean } }).reader.running

  it('logout 前后各关一次，下次读额度重新起进程（不留着缓存旧登录的进程）', async () => {
    const codex = make({ FAKE_CODEX_ACCOUNT: CHATGPT })
    await codex.accountQuota()
    expect(reading(codex)).toBe(true)
    await codex.logout()
    expect(reading(codex)).toBe(false)
    const before = rpc().filter(m => m.method === 'initialize').length
    await codex.accountQuota()
    expect(rpc().filter(m => m.method === 'initialize').length).toBeGreaterThan(before)
  })

  it('login 开始时关掉，结束后再关一次', async () => {
    const codex = make({ FAKE_CODEX_ACCOUNT: CHATGPT })
    await codex.accountQuota()
    expect(reading(codex)).toBe(true)
    const proc = await codex.login('browser', () => undefined)
    expect(reading(codex)).toBe(false)
    // 登录进行中读额度又起了进程：登录结束后要关掉，免得缓存的还是旧账号
    await codex.accountQuota()
    expect(reading(codex)).toBe(true)
    proc.kill()
    await proc.done.catch(() => undefined)
    await waitFor(() => !reading(codex))
  })
})

describe('Codex 账号额度：会话里的滚动更新', () => {
  function startSession(h: EngineHost) {
    return h.createSession({
      projectId: h.addProject(root).id,
      engine: 'codex',
      model: 'fake-codex',
      effort: 'high',
      permissionMode: 'ask',
    })
  }

  it('updated 通知合并进快照（只带 primary，保留之前读到的 secondary 和点数），空闲时到的也合并', async () => {
    const h = makeHost({
      FAKE_CODEX_ACCOUNT: CHATGPT,
      FAKE_CODEX_RATE_UPDATE: update(50),
      FAKE_CODEX_RATE_UPDATE_IDLE: update(77),
    })
    await h.refreshAccountQuota('chatgpt')
    const record = startSession(h)
    await h.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    // 最后一条是一轮结束后空闲时到的 77%
    await waitFor(() => quotas.at(-1)?.windows.find(w => w.id === 'five_hour')?.usedPercent === 77)
    const last = quotas.at(-1)!
    expect(last).toMatchObject({ source: 'event', plan: 'plus' })
    expect(last.windows.find(w => w.id === 'seven_day')?.usedPercent).toBe(18)
    expect(last.extras.credits?.balance).toBe(120)
    // 中间还收到过 50%（线程启动 / 一轮开始时）
    expect(quotas.some(q => q.windows.find(w => w.id === 'five_hour')?.usedPercent === 50)).toBe(true)
  })

  it('弹窗刷新借活着的会话进程，不再起只读进程', async () => {
    const h = makeHost({ FAKE_CODEX_ACCOUNT: CHATGPT })
    const record = startSession(h)
    await h.send(record.id, '你好')
    await waitFor(() => turnsDone(record.id) === 1)
    const before = rpc().filter(m => m.method === 'initialize').length
    const q = await h.refreshAccountQuota('chatgpt', { force: true })
    expect(q).toMatchObject({ status: 'ok', source: 'usage', plan: 'plus' })
    expect(rpc().filter(m => m.method === 'initialize')).toHaveLength(before)
    expect(quotaReads()).toHaveLength(1)
  })
})

describe('Codex 账号额度：会话层的网关过滤', () => {
  it('以进程启动时的来源为准：平台进程中途改成我的账号（反过来亦然），借进程和事件都不变', async () => {
    for (const startedOnGateway of [true, false]) {
      const codex = make({ FAKE_CODEX_ACCOUNT: CHATGPT, FAKE_CODEX_RATE_UPDATE: update(61) })
      await codex.info()
      const patches: unknown[] = []
      const emitted: { type: string }[] = []
      const record = {
        id: 'sess-1',
        projectId: 'p',
        title: '额度测试',
        cwd: root,
        engine: 'codex',
        engineSessionId: null,
        permissionMode: 'ask',
        effort: 'high',
        model: 'fake-codex',
        ...(startedOnGateway ? { platform: { groupId: '7', account: 'x@example.com' } } : {}),
      } as unknown as SessionRecord & Record<string, unknown>
      const ctx = {
        record: () => record,
        emit: (e: { type: string }) => emitted.push(e),
        setEngineSessionId: () => undefined,
        setPermissionMode: () => undefined,
        setUltracode: () => undefined,
        setFast: () => undefined,
        reportQuota: (patch: unknown) => patches.push(patch),
      } as unknown as SessionContext
      const session = codex.createSession(ctx)
      try {
        session.send('你好', 'turn-1', 'user-1')
        await waitFor(() => emitted.some(e => e.type === 'turn_completed'))
        // 一轮结束后换通道（进程要等下一条消息才换）
        if (startedOnGateway) delete record.platform
        else record.platform = { groupId: '7', account: 'x@example.com' }
        session.send('再来', 'turn-2', 'user-2')
        await waitFor(() => emitted.filter(e => e.type === 'turn_completed').length === 2)
        await new Promise(r => setTimeout(r, 100))
        expect(patches.length > 0).toBe(!startedOnGateway)
        expect(session.accountQuota?.() === null).toBe(startedOnGateway)
      } finally {
        await session.close()
      }
    }
  })

  /** 直接用适配器建会话，ctx 是手写的：不经过宿主的核对，单独验证适配器这一层 */
  async function reported(extra: Partial<SessionRecord>): Promise<unknown[]> {
    const codex = make({ FAKE_CODEX_ACCOUNT: CHATGPT, FAKE_CODEX_RATE_UPDATE: update(61) })
    await codex.info()
    const patches: unknown[] = []
    const emitted: { type: string; outcome?: string }[] = []
    const record = {
      id: 'sess-1',
      projectId: 'p',
      title: '额度测试',
      cwd: root,
      engine: 'codex',
      engineSessionId: null,
      permissionMode: 'ask',
      effort: 'high',
      model: 'fake-codex',
      ...extra,
    } as unknown as SessionRecord
    const ctx = {
      record: () => record,
      emit: (e: { type: string; outcome?: string }) => emitted.push(e),
      setEngineSessionId: () => undefined,
      setPermissionMode: () => undefined,
      setUltracode: () => undefined,
      setFast: () => undefined,
      reportQuota: (patch: unknown) => patches.push(patch),
    } as unknown as SessionContext
    const session = codex.createSession(ctx)
    try {
      session.send('你好', 'turn-1', 'user-1')
      await waitFor(() => emitted.some(e => e.type === 'turn_completed'))
      await new Promise(r => setTimeout(r, 100))
      // 不是起不来导致没有上报
      expect(emitted.find(e => e.type === 'turn_completed')?.outcome).toBe('completed')
    } finally {
      await session.close()
    }
    return patches
  }

  it('自有会话上报；平台和自定义接口的会话丢掉', async () => {
    const own = await reported({})
    expect(own.length).toBeGreaterThan(0)
    expect(own[0]).toMatchObject({ windows: [{ id: 'five_hour', usedPercent: 61, durationMins: 300 }] })
    expect(await reported({ platform: { groupId: '7', account: 'x@example.com' } } as Partial<SessionRecord>)).toEqual(
      [],
    )
    expect(await reported({ provider: { id: 'p1' } } as Partial<SessionRecord>)).toEqual([])
  })
})
