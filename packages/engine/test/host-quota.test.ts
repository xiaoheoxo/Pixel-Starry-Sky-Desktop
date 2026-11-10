// 宿主的账号额度（docs/ui/account-quota.md §4、§7.1）：按「引擎 + 账号」存一份、单飞、节流、退避、借会话进程、事件合并去重。
// 直接用假的适配器和运行时搭 HostQuota；真进程的部分在 claude-quota-process.test.ts / codex-quota.test.ts
import { sourceKey, type AccountQuota, type EngineId } from '@pixelsky/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostContext } from '../src/host/context'
import { HostQuota, resetAutoPeriod } from '../src/host/quota'
import type { AccountQuotaPatch, QuotaReading } from '../src/quota'

const T0 = Date.UTC(2026, 9, 19, 8, 0, 0)

const window = (id: string, usedPercent: number) => ({
  id,
  durationMins: id === 'five_hour' ? 300 : 10_080,
  usedPercent,
  resetsAt: T0 + 3_600_000,
})
function okReading(percent = 4, extra: Partial<Extract<QuotaReading, { kind: 'ok' }>> = {}): QuotaReading {
  return {
    kind: 'ok',
    plan: 'max',
    account: null,
    windows: [window('five_hour', percent), window('seven_day', 68)],
    extras: {},
    blocked: null,
    observedAt: Date.now(),
    ...extra,
  }
}
const patch = (percent: number): AccountQuotaPatch => ({
  windows: [window('five_hour', percent)],
  allowed: true,
  observedAt: Date.now(),
})

interface Rig {
  quota: HostQuota
  sent: AccountQuota[]
  adapterCalls: { claude: number; codex: number }
  /** 下一次适配器读取返回什么 */
  next: { claude: () => Promise<QuotaReading>; codex: () => Promise<QuotaReading> }
  account: { claude: string | null; codex: string | null; status: 'ready' | 'unauthenticated'; version: string | null }
  ctx: HostContext
  runtimes: Map<string, unknown>
  engines: ReturnType<typeof vi.fn>
  /** 切号后还没检测完的引擎：额度认账号前等它 */
  detecting: Map<EngineId, Promise<unknown>>
  /** sessionSource 默认按 record 算（进程启动时的来源）；传 undefined 以外的值可以模拟「记录后来改了、进程还是旧的」 */
  addSession(
    id: string,
    engine: EngineId,
    ask: (() => Promise<QuotaReading> | null) | null,
    record?: Record<string, unknown>,
    sessionSource?: string | null,
  ): void
}

function rig(): Rig {
  const adapterCalls = { claude: 0, codex: 0 }
  const next = {
    claude: async (): Promise<QuotaReading> => okReading(),
    codex: async (): Promise<QuotaReading> => okReading(),
  }
  const account = {
    claude: 'a@example.com' as string | null,
    codex: 'c@example.com' as string | null,
    status: 'ready' as 'ready' | 'unauthenticated',
    version: '1.0.0' as string | null,
  }
  const adapter = (id: 'claude' | 'codex') => ({
    info: async () => ({
      id,
      status: account.status,
      version: account.version,
      ...(account[id] ? { account: { email: account[id] } } : {}),
    }),
    accountQuota: () => {
      adapterCalls[id]++
      return next[id]()
    },
  })
  const sent: AccountQuota[] = []
  const runtimes = new Map<string, unknown>()
  const engines = vi.fn(async () => [])
  const detecting = new Map<EngineId, Promise<unknown>>()
  const ctx = {
    adapters: { claude: adapter('claude'), codex: adapter('codex') },
    runtimes,
    closing: false,
    opts: { onQuota: (q: AccountQuota) => sent.push(q) },
    m: {
      settings: { engines, resetCreditAuto: () => null, resetCreditUsed: () => 0 },
      accounts: { detected: (e: EngineId) => detecting.get(e) },
    },
  } as unknown as HostContext
  return {
    quota: new HostQuota(ctx),
    ctx,
    sent,
    adapterCalls,
    next,
    account,
    runtimes,
    engines,
    detecting,
    addSession(id, engine, ask, record = {}, sessionSource) {
      runtimes.set(id, {
        snapshot: { record: { id, engine, ...record } },
        execution: null,
        session: ask ? { accountQuota: ask } : {},
        sessionSource: sessionSource === undefined ? sourceKey(record) : sessionSource,
      })
    },
  }
}

/** 让 observe 里的异步合并跑完 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const advance = (ms: number): void => void vi.setSystemTime(Date.now() + ms)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => vi.useRealTimers())

describe('HostQuota.refresh', () => {
  it('切号后检测没完：刷新等检测完按新账号读，不把旧账号的额度当成当前的', async () => {
    const r = rig()
    r.next.claude = async () => okReading(4, { account: 'a@example.com' })
    await r.quota.refresh('claude', { force: true })
    let detected!: () => void
    r.detecting.set('claude', new Promise<void>(resolve => (detected = resolve)))
    r.next.claude = async () => okReading(50, { account: 'b@example.com' })
    let done: AccountQuota | null = null
    const forced = r.quota.refresh('claude', { force: true }).then(q => (done = q))
    await flush()
    expect(done).toBeNull()
    r.account.claude = 'b@example.com'
    detected()
    await forced
    expect(done).toMatchObject({ account: 'b@example.com', windows: [{ usedPercent: 50 }, {}] })
    expect(r.sent.at(-1)?.account).toBe('b@example.com')
  })

  it('两个并发 refresh 只调一次适配器（单飞），手动刷新也并进去', async () => {
    const r = rig()
    let release!: (v: QuotaReading) => void
    r.next.claude = () => new Promise(resolve => (release = resolve))
    const a = r.quota.refresh('claude')
    const b = r.quota.refresh('claude', { force: true })
    await flush()
    release(okReading())
    const [x, y] = await Promise.all([a, b])
    expect(r.adapterCalls.claude).toBe(1)
    expect(x).toBe(y)
    expect(x).toMatchObject({
      provider: 'claude',
      status: 'ok',
      plan: 'max',
      account: 'a@example.com',
      source: 'usage',
      refreshable: true,
      fetchedAt: T0,
      observedAt: T0,
      error: null,
    })
    expect(x.windows.map(w => w.id)).toEqual(['five_hour', 'seven_day'])
  })

  it('1 分钟内不再取；超过 maxAgeMs 才取；maxAgeMs 可调', async () => {
    const r = rig()
    await r.quota.refresh('claude')
    advance(59_000)
    await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(1)
    advance(2_000)
    await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(2)
    // 第一次显示传 10 分钟：1 分钟前取过的不再取
    advance(120_000)
    await r.quota.refresh('claude', { maxAgeMs: 10 * 60_000 })
    expect(r.adapterCalls.claude).toBe(2)
    await r.quota.refresh('claude', { maxAgeMs: 0 })
    expect(r.adapterCalls.claude).toBe(3)
  })

  it('force 跳过 maxAge，但 5 秒内连点只取一次', async () => {
    const r = rig()
    await r.quota.refresh('claude')
    advance(1_000)
    await r.quota.refresh('claude', { force: true })
    expect(r.adapterCalls.claude).toBe(1)
    advance(5_000)
    await r.quota.refresh('claude', { force: true })
    expect(r.adapterCalls.claude).toBe(2)
    advance(1_000)
    await r.quota.refresh('claude', { force: true })
    expect(r.adapterCalls.claude).toBe(2)
  })

  it('失败后返回 error 快照（保留上次的数据）并按 30 秒 / 2 分钟 / 5 分钟退避；手动刷新不受退避限制', async () => {
    const r = rig()
    await r.quota.refresh('claude')
    r.next.claude = async () => {
      throw new Error('Claude Code 没有回应 get_usage')
    }
    advance(61_000)
    const failed = await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(2)
    expect(failed).toMatchObject({
      status: 'error',
      error: { code: 'timeout', message: '读取额度超时' },
      refreshable: true,
    })
    expect(failed.windows).toHaveLength(2)
    expect(failed.fetchedAt).toBe(T0)
    // 退避期内（30 秒）：非手动不再取
    advance(20_000)
    expect(await r.quota.refresh('claude', { maxAgeMs: 0 })).toBe(failed)
    expect(r.adapterCalls.claude).toBe(2)
    // 手动刷新不受退避限制（过了 5 秒间隔即可）
    await r.quota.refresh('claude', { force: true })
    expect(r.adapterCalls.claude).toBe(3)
    // 第二次连续失败：退避 2 分钟
    advance(100_000)
    await r.quota.refresh('claude', { maxAgeMs: 0 })
    expect(r.adapterCalls.claude).toBe(3)
    advance(30_000)
    await r.quota.refresh('claude', { maxAgeMs: 0 })
    expect(r.adapterCalls.claude).toBe(4)
    // 成功后退避清零
    r.next.claude = async () => okReading(9)
    advance(6 * 60_000)
    const good = await r.quota.refresh('claude')
    expect(good).toMatchObject({ status: 'ok', error: null })
    expect(good.windows[0].usedPercent).toBe(9)
  })

  it('no-request → refreshable: false，数据不动，之后非手动不再取', async () => {
    const r = rig()
    r.next.claude = async () => ({ kind: 'no-request' })
    const first = await r.quota.refresh('claude')
    expect(first).toMatchObject({ status: 'empty', refreshable: false, windows: [] })
    // 对话里收到的事件让它有数据
    r.addSession('s1', 'claude', null)
    r.quota.observe('s1', patch(30))
    await flush()
    advance(120_000)
    const again = await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(1)
    expect(again).toMatchObject({ status: 'ok', refreshable: false, source: 'event' })
    expect(again.windows[0].usedPercent).toBe(30)
  })

  it('unsupported → status unsupported 并清空数据，10 分钟内不再试，手动刷新可以', async () => {
    const r = rig()
    await r.quota.refresh('claude')
    r.next.claude = async () => ({ kind: 'unsupported' })
    advance(61_000)
    const q = await r.quota.refresh('claude')
    expect(q).toMatchObject({ status: 'unsupported', plan: null, windows: [], extras: {}, blocked: null })
    advance(61_000)
    await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(2)
    advance(10 * 60_000)
    await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(3)
    advance(6_000)
    await r.quota.refresh('claude', { force: true })
    expect(r.adapterCalls.claude).toBe(4)
  })

  it('引擎没登录 / 不可用 → unsupported 快照，不存', async () => {
    const r = rig()
    r.account.status = 'unauthenticated'
    const q = await r.quota.refresh('claude')
    expect(q.status).toBe('unsupported')
    expect(r.adapterCalls.claude).toBe(0)
    expect(await r.quota.get('claude')).toBeNull()
    expect(r.sent).toEqual([])
  })

  it('读取抛错也不抛出：适配器同步抛错、info 抛错都变成 error 快照', async () => {
    const r = rig()
    r.next.claude = () => {
      throw new Error('ECONNRESET')
    }
    expect((await r.quota.refresh('claude')).error).toEqual({ code: 'network', message: '连不上 claude.ai' })
    const broken = rig()
    broken.runtimes.clear()
    ;(broken.quota as unknown as { ctx: { adapters: object } }).ctx.adapters = {}
    expect(await broken.quota.refresh('claude')).toMatchObject({ status: 'error' })
  })

  it('Claude 和 ChatGPT 各存各的', async () => {
    const r = rig()
    r.next.codex = async () => okReading(50, { plan: 'plus' })
    await r.quota.refresh('claude')
    await r.quota.refresh('chatgpt')
    expect((await r.quota.get('claude'))?.windows[0].usedPercent).toBe(4)
    expect(await r.quota.get('chatgpt')).toMatchObject({ provider: 'chatgpt', plan: 'plus', account: 'c@example.com' })
    expect(r.adapterCalls).toEqual({ claude: 1, codex: 1 })
  })
})

describe('HostQuota 账号', () => {
  it('换账号：各存各的，get 只给当前的，换回去还在', async () => {
    const r = rig()
    await r.quota.refresh('claude')
    r.account.claude = 'b@example.com'
    expect(await r.quota.get('claude')).toBeNull()
    r.next.claude = async () => okReading(77)
    const b = await r.quota.refresh('claude')
    expect(b).toMatchObject({ account: 'b@example.com' })
    expect(b.windows[0].usedPercent).toBe(77)
    expect((await r.quota.get('claude'))?.windows[0].usedPercent).toBe(77)
    r.account.claude = 'a@example.com'
    expect((await r.quota.get('claude'))?.windows[0].usedPercent).toBe(4)
  })

  it('没有邮箱用 ? 做键', async () => {
    const r = rig()
    r.account.claude = null
    const q = await r.quota.refresh('claude')
    expect(q.account).toBeNull()
    expect(await r.quota.get('claude')).toBe(q)
  })

  it('回包里的账号和检测到的不一样：以回包为准存到那个键下，重新检测一次，不反复检测', async () => {
    const r = rig()
    r.next.claude = async () => okReading(11, { account: 'new@example.com' })
    const q = await r.quota.refresh('claude')
    expect(q.account).toBe('new@example.com')
    await flush()
    expect(r.engines).toHaveBeenCalledTimes(1)
    expect(r.engines).toHaveBeenCalledWith(true)
    // 重新检测后邮箱还是对不上（格式不同）：仍然读得到回包那份，且不再检测
    expect((await r.quota.get('claude'))?.windows[0].usedPercent).toBe(11)
    advance(61_000)
    await r.quota.refresh('claude')
    await flush()
    expect(r.engines).toHaveBeenCalledTimes(1)
    // 重新检测后邮箱对上了：别名撤掉，照常按邮箱存
    const fixed = rig()
    fixed.next.claude = async () => okReading(12, { account: 'b@example.com' })
    fixed.engines.mockImplementation(async () => {
      fixed.account.claude = 'b@example.com'
      return []
    })
    await fixed.quota.refresh('claude')
    await flush()
    expect((await fixed.quota.get('claude'))?.windows[0].usedPercent).toBe(12)
  })
})

describe('HostQuota 借会话进程', () => {
  it('有活着的自有会话时借会话，不调适配器', async () => {
    const r = rig()
    const ask = vi.fn(async () => okReading(21))
    r.addSession('s1', 'claude', ask)
    const q = await r.quota.refresh('claude')
    expect(ask).toHaveBeenCalledTimes(1)
    expect(r.adapterCalls.claude).toBe(0)
    expect(q.windows[0].usedPercent).toBe(21)
  })

  it('会话没有进程（accountQuota 返回 null）才调适配器', async () => {
    const r = rig()
    r.addSession('s1', 'claude', () => null)
    await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(1)
  })

  it('平台 / 自定义来源的会话、别的引擎的会话不借', async () => {
    const r = rig()
    const ask = vi.fn(async () => okReading(99))
    r.addSession('platform', 'claude', ask, { platform: { account: 'x' } })
    r.addSession('custom', 'claude', ask, { provider: { id: 'p' } })
    r.addSession('codex', 'codex', ask)
    await r.quota.refresh('claude')
    expect(ask).not.toHaveBeenCalled()
    expect(r.adapterCalls.claude).toBe(1)
  })

  it('借会话失败（不是 no-request）就不再换适配器，按失败算', async () => {
    const r = rig()
    r.addSession('s1', 'claude', () => Promise.reject(new Error('Claude Code 没有回应 get_usage')))
    const q = await r.quota.refresh('claude')
    expect(q).toMatchObject({ status: 'error', error: { code: 'timeout' } })
    expect(r.adapterCalls.claude).toBe(0)
  })

  it('借会话得到 no-request、临时进程也不认识 → refreshable: false', async () => {
    const r = rig()
    r.next.claude = async () => ({ kind: 'no-request' })
    r.addSession('s1', 'claude', async () => ({ kind: 'no-request' }))
    expect(await r.quota.refresh('claude')).toMatchObject({ refreshable: false, status: 'empty' })
    expect(r.adapterCalls.claude).toBe(1)
  })

  it('借会话得到 no-request（更新前开着的旧版进程）：改用临时进程再试，临时进程认识就不判 refreshable: false', async () => {
    const r = rig()
    const ask = vi.fn(async (): Promise<QuotaReading> => ({ kind: 'no-request' }))
    r.addSession('s1', 'claude', ask)
    const q = await r.quota.refresh('claude')
    expect(ask).toHaveBeenCalledTimes(1)
    expect(r.adapterCalls.claude).toBe(1)
    expect(q).toMatchObject({ status: 'ok', refreshable: true })
  })

  it('借来的会话进程在读取途中退出 / 被重启：改用临时进程再读一次，不进退避', async () => {
    const r = rig()
    r.addSession('s1', 'claude', () => Promise.reject(new Error('Claude Code 进程已退出')))
    const q = await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(1)
    expect(q).toMatchObject({ status: 'ok', error: null })
    // 没有进退避：过了 maxAge 马上又可以读
    advance(61_000)
    await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(2)
  })

  it('每轮结束的补取遇到会话进程被打断：不起临时进程，也不记失败', async () => {
    const r = rig()
    r.quota.refresh('claude')
    await flush()
    r.addSession('s1', 'claude', () => Promise.reject(new Error('Claude Code 进程已退出')))
    advance(10 * 60_000)
    r.quota.afterTurn('s1')
    await flush()
    expect(r.adapterCalls.claude).toBe(1)
    expect((await r.quota.get('claude'))?.status).toBe('ok')
    expect(r.sent).toHaveLength(1)
  })

  it('对话中途平台 → 我的账号：进程还是网关进程（sessionSource 是平台），记录已是我的账号，不借它问', async () => {
    const r = rig()
    const ask = vi.fn(async () => okReading(99))
    // 记录已经改成「我的账号」，但进程是按平台来源起的、下一条消息才会换
    r.addSession('s1', 'claude', ask, {}, 'platform:x')
    const q = await r.quota.refresh('claude')
    expect(ask).not.toHaveBeenCalled()
    expect(r.adapterCalls.claude).toBe(1)
    expect(q.windows[0].usedPercent).toBe(4)
  })

  it('反过来：进程是自己账号起的，记录已改成平台（还没换进程），仍然可以借', async () => {
    const r = rig()
    const ask = vi.fn(async () => okReading(21))
    r.addSession('s1', 'claude', ask, { platform: { account: 'x' } }, null)
    const q = await r.quota.refresh('claude')
    expect(ask).toHaveBeenCalledTimes(1)
    expect(q.windows[0].usedPercent).toBe(21)
  })

  it('一轮刚结束 rt.execution 已清空时，同样按进程启动时的来源判断', async () => {
    const r = rig()
    const ask = vi.fn(async () => okReading(99))
    r.addSession('s1', 'claude', ask, {}, 'custom:p1')
    ;(r.runtimes.get('s1') as { execution: unknown }).execution = null
    await r.quota.refresh('claude')
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('HostQuota 账号变化与退出', () => {
  it('读取途中换了账号：旧账号的结果只存进它自己的记录，不当作当前账号广播', async () => {
    const r = rig()
    let release!: (v: QuotaReading) => void
    r.next.claude = () => new Promise(resolve => (release = resolve))
    const pending = r.quota.refresh('claude')
    await flush()
    // 读取还没回来，用户退出登录换成了 B
    r.account.claude = 'b@example.com'
    release(okReading(55))
    const a = await pending
    expect(a).toMatchObject({ account: 'a@example.com', status: 'ok' })
    expect(r.sent).toEqual([])
    // 当前账号 B 还没有数据；换回 A 时 A 的数据在
    expect(await r.quota.get('claude')).toBeNull()
    r.account.claude = 'a@example.com'
    expect((await r.quota.get('claude'))?.windows[0].usedPercent).toBe(55)
  })

  it('读取途中换了账号：失败、unsupported 也不广播给新账号', async () => {
    const r = rig()
    let fail!: (e: Error) => void
    r.next.claude = () => new Promise((_, reject) => (fail = reject))
    const pending = r.quota.refresh('claude')
    await flush()
    r.account.claude = 'b@example.com'
    fail(new Error('Claude Code 没有回应 get_usage'))
    expect((await pending).status).toBe('error')
    expect(r.sent).toEqual([])
    r.account.claude = 'a@example.com'
    expect((await r.quota.get('claude'))?.status).toBe('error')
    const u = rig()
    let done!: (v: QuotaReading) => void
    u.next.claude = () => new Promise(resolve => (done = resolve))
    const p2 = u.quota.refresh('claude')
    await flush()
    u.account.claude = null
    done({ kind: 'unsupported' })
    await p2
    expect(u.sent).toEqual([])
  })

  it('读取途中换了账号、回包账号对不上检测邮箱：不建别名（别名属于当时的检测结果），不广播', async () => {
    const r = rig()
    let release!: (v: QuotaReading) => void
    r.next.claude = () => new Promise(resolve => (release = resolve))
    const pending = r.quota.refresh('claude')
    await flush()
    r.account.claude = 'b@example.com'
    release(okReading(33, { account: 'other@example.com' }))
    await pending
    await flush()
    expect(r.sent).toEqual([])
    expect(r.engines).not.toHaveBeenCalled()
    expect(await r.quota.get('claude')).toBeNull()
  })

  it('回包账号后来等于检测到的邮箱：撤掉别名，写回原键', async () => {
    const r = rig()
    r.next.claude = async () => okReading(11, { account: 'new@example.com' })
    await r.quota.refresh('claude')
    expect((await r.quota.get('claude'))?.account).toBe('new@example.com')
    // 之后回包账号又和检测到的邮箱（a@example.com）一致了：映射撤掉，当前账号读的是 a 自己的记录
    r.next.claude = async () => okReading(22, { account: 'A@example.com' })
    advance(61_000)
    const q = await r.quota.refresh('claude')
    expect(q.windows[0].usedPercent).toBe(22)
    expect(r.sent.at(-1)).toMatchObject({ account: 'A@example.com' })
    // get 读的是原键（撤掉别名前会读到 new@ 那份的 11）
    expect((await r.quota.get('claude'))?.windows[0].usedPercent).toBe(22)
    // 借会话（回包没有账号）的下一次读取落在原键上，不再被带去 new@
    r.next.claude = async () => okReading(33)
    advance(61_000)
    await r.quota.refresh('claude')
    expect((await r.quota.get('claude'))?.windows[0].usedPercent).toBe(33)
    expect((await r.quota.get('claude'))?.account).toBe('a@example.com')
  })

  it('判定 refreshable: false 后，引擎版本变了（更新 / 重装）就重新试，同版本不试', async () => {
    const r = rig()
    r.next.claude = async () => ({ kind: 'no-request' })
    expect(await r.quota.refresh('claude')).toMatchObject({ refreshable: false })
    advance(61_000)
    await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(1)
    // 更新后版本变了；新版认识 get_usage
    r.account.version = '2.0.0'
    r.next.claude = async () => okReading(8)
    advance(61_000)
    const q = await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(2)
    expect(q).toMatchObject({ status: 'ok', refreshable: true })
    expect(q.windows[0].usedPercent).toBe(8)
  })

  it('应用正在退出：不再读，不调适配器（不起临时进程）', async () => {
    const r = rig()
    ;(r.ctx as { closing: boolean }).closing = true
    const q = await r.quota.refresh('claude', { force: true })
    expect(r.adapterCalls.claude).toBe(0)
    expect(q.status).toBe('empty')
    expect(r.sent).toEqual([])
  })

  it('observe 也按进程启动时的来源核对：网关进程的事件丢掉，没有进程的会话也丢掉', async () => {
    const r = rig()
    r.addSession('gw', 'claude', null, {}, 'platform:x')
    r.addSession('self', 'codex', null, { platform: { account: 'x' } }, null)
    r.runtimes.set('gone', { snapshot: { record: { id: 'gone', engine: 'claude' } }, execution: null, session: null })
    r.quota.observe('gw', patch(90))
    r.quota.observe('gone', patch(90))
    await flush()
    expect(r.sent).toEqual([])
    r.quota.observe('self', patch(10))
    await flush()
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0].provider).toBe('chatgpt')
  })
})

describe('HostQuota.observe（对话里收到的事件）', () => {
  it('平台 / 自定义来源的会话收到的事件被丢掉，不广播、不合并', async () => {
    const r = rig()
    r.addSession('platform', 'claude', null, { platform: { account: 'x' } })
    r.addSession('custom', 'codex', null, { provider: { id: 'p' } })
    r.quota.observe('platform', patch(90))
    r.quota.observe('custom', patch(90))
    r.quota.observe('missing', patch(90))
    await flush()
    expect(r.sent).toEqual([])
    expect(await r.quota.get('claude')).toBeNull()
    expect(await r.quota.get('chatgpt')).toBeNull()
  })

  it('自有会话的事件合并进当前账号的快照并广播；内容没变不再广播', async () => {
    const r = rig()
    r.addSession('s1', 'claude', null)
    await r.quota.refresh('claude')
    expect(r.sent).toHaveLength(1)
    r.quota.observe('s1', patch(30))
    await flush()
    expect(r.sent).toHaveLength(2)
    expect(r.sent[1]).toMatchObject({ source: 'event', fetchedAt: T0 })
    expect(r.sent[1].windows.find(w => w.id === 'five_hour')?.usedPercent).toBe(30)
    expect(r.sent[1].windows.find(w => w.id === 'seven_day')?.usedPercent).toBe(68)
    // 同样的百分比再来一条（只有 observedAt 变）：不广播
    advance(2_000)
    r.quota.observe('s1', patch(30))
    await flush()
    expect(r.sent).toHaveLength(2)
    expect((await r.quota.get('claude'))?.observedAt).toBe(T0 + 2_000)
    // 百分比变了才广播
    r.quota.observe('s1', patch(31))
    await flush()
    expect(r.sent).toHaveLength(3)
  })

  it('ChatGPT 的事件进 chatgpt 的快照', async () => {
    const r = rig()
    r.addSession('c1', 'codex', null)
    r.quota.observe('c1', patch(12))
    await flush()
    expect(r.sent).toHaveLength(1)
    expect(r.sent[0]).toMatchObject({ provider: 'chatgpt', status: 'ok', source: 'event', fetchedAt: null })
  })

  it('没有读取过也能合并（fetchedAt 为 null，第一次显示照样会去读）', async () => {
    const r = rig()
    r.addSession('s1', 'claude', null)
    r.quota.observe('s1', patch(5))
    await flush()
    expect(await r.quota.get('claude')).toMatchObject({ status: 'ok', fetchedAt: null })
    await r.quota.refresh('claude', { maxAgeMs: 10 * 60_000 })
    expect(r.adapterCalls.claude).toBe(1)
  })
})

describe('HostQuota.afterTurn', () => {
  it('没人看过：不取', async () => {
    const r = rig()
    const ask = vi.fn(async () => okReading())
    r.addSession('s1', 'claude', ask)
    r.quota.afterTurn('s1')
    await flush()
    expect(ask).not.toHaveBeenCalled()
  })

  it('有人看过、超过 5 分钟、会话进程活着才取，且只借会话进程', async () => {
    const r = rig()
    const ask = vi.fn(async () => okReading(33))
    r.addSession('s1', 'claude', () => null)
    await r.quota.refresh('claude')
    expect(r.adapterCalls.claude).toBe(1)
    r.runtimes.clear()
    r.addSession('s1', 'claude', ask)
    // 刚取过：不取
    advance(4 * 60_000)
    r.quota.afterTurn('s1')
    await flush()
    expect(ask).not.toHaveBeenCalled()
    // 超过 5 分钟：借会话进程取
    advance(2 * 60_000)
    r.quota.afterTurn('s1')
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(r.adapterCalls.claude).toBe(1)
    expect((await r.quota.get('claude'))?.windows[0].usedPercent).toBe(33)
  })

  it('会话进程没了：绝不调适配器的临时读取，也不记这次尝试', async () => {
    const r = rig()
    await r.quota.refresh('claude')
    r.addSession('s1', 'claude', () => null)
    advance(10 * 60_000)
    r.quota.afterTurn('s1')
    await flush()
    expect(r.adapterCalls.claude).toBe(1)
  })

  it('平台来源的会话结束一轮不取', async () => {
    const r = rig()
    await r.quota.refresh('claude')
    const ask = vi.fn(async () => okReading())
    r.addSession('s1', 'claude', ask, { platform: { account: 'x' } })
    advance(10 * 60_000)
    r.quota.afterTurn('s1')
    await flush()
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('HostQuota.reset（登录 / 换账号后，docs/ui/claude-login-recovery.md §1 第 1 条）', () => {
  it('失效期间记成「不支持」：reset 先广播「读取中」，马上重读，不等 10 分钟', async () => {
    const r = rig()
    r.next.claude = async () => ({ kind: 'unsupported' })
    await r.quota.refresh('claude')
    expect((await r.quota.get('claude'))?.status).toBe('unsupported')
    r.next.claude = async () => okReading(18)
    advance(5_000)
    r.sent.length = 0
    await r.quota.reset('claude')
    expect(r.sent[0]).toMatchObject({ status: 'empty', pending: true, account: 'a@example.com' })
    expect(r.sent.at(-1)).toMatchObject({ status: 'ok' })
    expect(r.sent.at(-1)?.pending).toBeUndefined()
    expect(r.adapterCalls.claude).toBe(2)
  })

  it('失败等待也清掉：退避期间 reset 照样读', async () => {
    const r = rig()
    r.next.claude = async () => {
      throw new Error('boom')
    }
    await r.quota.refresh('claude')
    r.next.claude = async () => okReading()
    await r.quota.reset('claude')
    expect(r.adapterCalls.claude).toBe(2)
    expect((await r.quota.get('claude'))?.status).toBe('ok')
  })

  it('引擎还没登录好：告诉界面不显示，不留「读取中」，不读', async () => {
    const r = rig()
    r.account.status = 'unauthenticated'
    await r.quota.reset('claude')
    expect(r.sent).toEqual([expect.objectContaining({ status: 'unsupported' })])
    expect(r.sent[0].pending).toBeUndefined()
    expect(r.adapterCalls.claude).toBe(0)
  })

  it('应用正在退出：什么都不做', async () => {
    const r = rig()
    r.ctx.closing = true
    await r.quota.reset('claude')
    expect(r.sent).toEqual([])
    expect(r.adapterCalls.claude).toBe(0)
  })
})

describe('resetAutoPeriod：周限快到时要不要自动用重置卡', () => {
  const NOW = 1_800_000_000_000
  const H = 3_600_000
  const rule = { threshold: 95, minLeftHours: 24, perWeek: 1 }
  const q = (week: Partial<QuotaWindowLike>, available = 1): AccountQuota =>
    ({
      provider: 'chatgpt',
      status: 'ok',
      windows: [
        { id: 'five_hour', durationMins: 300, usedPercent: 100, resetsAt: NOW + H },
        { id: 'seven_day', durationMins: 10_080, usedPercent: 96, resetsAt: NOW + 72 * H, ...week },
      ],
      extras: { resetCredits: { available, credits: null } },
    }) as unknown as AccountQuota
  type QuotaWindowLike = { usedPercent: number; resetsAt: number | null; rejected: boolean }
  const none = () => 0

  it('全部满足时返回周期（恢复时间按小时取整）', () => {
    expect(resetAutoPeriod(q({}), rule, none, NOW)).toBe(Math.round((NOW + 72 * H) / H))
  })
  it('没开、没卡、没到阈值都不用；只满的是 5 小时窗口也不用', () => {
    expect(resetAutoPeriod(q({}), null, none, NOW)).toBeNull()
    expect(resetAutoPeriod(q({}, 0), rule, none, NOW)).toBeNull()
    expect(resetAutoPeriod(q({ usedPercent: 90 }), rule, none, NOW)).toBeNull()
  })
  it('被拒绝按 100% 算', () => {
    expect(resetAutoPeriod(q({ usedPercent: 50, rejected: true }), rule, none, NOW)).not.toBeNull()
  })
  it('离恢复不到下限、或不知道恢复时间时不用；下限 0 不看', () => {
    expect(resetAutoPeriod(q({ resetsAt: NOW + 10 * H }), rule, none, NOW)).toBeNull()
    expect(resetAutoPeriod(q({ resetsAt: null }), rule, none, NOW)).toBeNull()
    expect(resetAutoPeriod(q({ resetsAt: NOW + 10 * H }), { ...rule, minLeftHours: 0 }, none, NOW)).not.toBeNull()
  })
  it('这个周期用满张数就不再用', () => {
    expect(resetAutoPeriod(q({}), rule, () => 1, NOW)).toBeNull()
    expect(resetAutoPeriod(q({}), { ...rule, perWeek: 2 }, () => 1, NOW)).not.toBeNull()
  })
})

describe('自动用重置卡', () => {
  const H = 3_600_000
  function setup(onQuota: boolean) {
    const used = new Map<number, number>()
    const consume = vi.fn(async () => {
      throw new Error('超时')
    })
    const ctx = {
      adapters: { codex: { consumeResetCredit: consume } },
      runtimes: new Map(),
      closing: false,
      opts: onQuota ? { onQuota: () => undefined } : {},
      m: {
        settings: {
          resetCreditAuto: () => ({ threshold: 95, minLeftHours: 0, perWeek: 1 }),
          resetCreditUsed: (p: number) => used.get(p) ?? 0,
          noteResetCreditUsed: (p: number) => used.set(p, (used.get(p) ?? 0) + 1),
        },
        queue: { wakeLimited: vi.fn() },
      },
    } as unknown as HostContext
    const quota = new HostQuota(ctx)
    const full = {
      provider: 'chatgpt',
      status: 'ok',
      windows: [{ id: 'seven_day', durationMins: 10_080, usedPercent: 99, resetsAt: Date.now() + 72 * H }],
      extras: { resetCredits: { available: 1, credits: null } },
    } as unknown as AccountQuota
    // 直接走广播后的判断（publish 内部调用）
    const check = () => (quota as unknown as { checkAutoReset(q: AccountQuota): void }).checkAutoReset(full)
    return { consume, used, check }
  }

  it('consume 报错也记一张：同一个周期不再自动用', async () => {
    const { consume, used, check } = setup(true)
    check()
    await vi.waitFor(() => expect(used.size).toBe(1))
    expect(consume).toHaveBeenCalledTimes(1)
  })

  it('远程机器（没有 onQuota）不自动用', () => {
    const { consume, check } = setup(false)
    check()
    expect(consume).not.toHaveBeenCalled()
  })
})
