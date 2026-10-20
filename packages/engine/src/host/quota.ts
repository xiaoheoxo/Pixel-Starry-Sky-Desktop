// 账号额度（docs/ui/account-quota.md §4）：按「引擎 + 账号」存一份，所有对话共用。
// 主动读取优先借自有会话活着的进程，没有才让适配器起临时进程（Claude）/ 用只读进程（Codex）；对话里顺带收到的事件合并进同一份。
// 单飞、节流、失败退避、变化去重后广播。
import type { AccountQuota, EngineId, EngineQuotaProvider, QuotaRefreshOptions } from '@pixelsky/protocol'
import { describeError, logger } from '../log'
import { classifyQuotaError, mergeQuota, type AccountQuotaPatch, type QuotaReading } from '../quota'
import type { HostContext } from './context'

const log = logger('engine.quota')

/** 额度属于哪个引擎 */
const QUOTA_ENGINE: Record<EngineQuotaProvider, EngineId> = { claude: 'claude', chatgpt: 'codex' }
const QUOTA_HOST: Record<EngineQuotaProvider, 'claude.ai' | 'chatgpt.com'> = {
  claude: 'claude.ai',
  chatgpt: 'chatgpt.com',
}

/** 打开弹窗：超过 1 分钟没主动取就取 */
export const DEFAULT_MAX_AGE_MS = 60_000
/** 渲染层第一次显示按钮时传 */
export const FIRST_SHOW_MAX_AGE_MS = 10 * 60_000
/** 手动刷新最短间隔 */
export const FORCE_MIN_GAP_MS = 5_000
/** 每轮结束补取（只借会话进程） */
export const AFTER_TURN_MAX_AGE_MS = 5 * 60_000
/** 连续失败后非手动的读取：第 1、2、3 次及以后失败各等多久 */
export const ERROR_BACKOFF_MS = [30_000, 2 * 60_000, 5 * 60_000] as const
/** 不支持的账号多久再试 */
export const UNSUPPORTED_RECHECK_MS = 10 * 60_000

/** 当前账号：键（可能经过别名）、检测到的邮箱、引擎是否可用、EngineInfo 对应的键、引擎版本 */
interface Identity {
  key: string
  email: string | null
  ready: boolean
  infoKey: string
  version: string | null
}

/** 借来的会话进程在读取途中退出 / 被重启：改用临时进程再读一次，不当作引擎不可用 */
const interrupted = (error: unknown): boolean =>
  /进程已退出|process exited/i.test(error instanceof Error ? error.message : String(error ?? ''))

interface Entry {
  quota: AccountQuota
  inflight: Promise<AccountQuota> | null
  /** 最近一次主动读取开始的时间 */
  lastAttempt: number
  /** 连续失败次数（退避用） */
  failures: number
  /** 判定 refreshable: false（引擎不认识 get_usage）时的引擎版本；版本变了（更新 / 重装）就重新试 */
  unrefreshableVersion: string | null
}

const providerOfEngine = (engine: EngineId): EngineQuotaProvider | null =>
  engine === 'claude' ? 'claude' : engine === 'codex' ? 'chatgpt' : null

const hasData = (q: Pick<AccountQuota, 'windows' | 'extras' | 'blocked'>): boolean =>
  q.windows.length > 0 || Object.keys(q.extras).length > 0 || q.blocked !== null

function emptyQuota(provider: EngineQuotaProvider, account: string | null): AccountQuota {
  return {
    provider,
    status: 'empty',
    plan: null,
    account,
    windows: [],
    extras: {},
    blocked: null,
    observedAt: null,
    fetchedAt: null,
    source: 'usage',
    refreshable: true,
    error: null,
  }
}

export class HostQuota {
  private readonly entries = new Map<string, Entry>()
  /** 有人看过的 provider（refresh 调过）：本次运行内一直有效，每轮结束的补取只对它们做 */
  private readonly watched = new Set<EngineQuotaProvider>()
  /** 上一次广播的内容（不含 observedAt）：一样就不再发 */
  private readonly sent = new Map<EngineQuotaProvider, string>()
  /** 回包里的账号和 EngineInfo.account 对不上时：EngineInfo 的键 → 实际存的键（重新检测后对上了就撤掉） */
  private readonly alias = new Map<string, string>()
  /** 为哪个对不上的组合重新检测过（EngineInfo 的键 → 回包账号）：同一组合只检测一次，免得每次刷新都起检测进程 */
  private readonly redetected = new Map<string, string>()
  /** 各会话最近一次额度事件（自动换账号时取用完的窗口和恢复时间） */
  private readonly lastEvents = new Map<string, AccountQuotaPatch>()

  constructor(private readonly ctx: HostContext) {}

  /** 读当前账号的快照，不发请求；还没读过为 null */
  async get(provider: EngineQuotaProvider): Promise<AccountQuota | null> {
    try {
      const { key } = await this.identity(provider)
      return this.entries.get(key)?.quota ?? null
    } catch {
      return null
    }
  }

  /** 这个会话最近一次额度事件；没有为 null */
  lastEvent(sessionId: string): AccountQuotaPatch | null {
    return this.lastEvents.get(sessionId) ?? null
  }

  /** 按邮箱同步取某个账号的快照（自动换账号前取原账号用完的窗口，docs/ui/engine-accounts-claude.md §3.2）；没有为 null */
  peek(provider: EngineQuotaProvider, email: string | null): AccountQuota | null {
    if (!email) return null
    const infoKey = `${provider}:${email}`
    const direct = this.entries.get(this.alias.get(infoKey) ?? infoKey)
    if (direct) return direct.quota
    // 邮箱大小写不一样
    const lower = infoKey.toLowerCase()
    for (const [key, entry] of this.entries) if (key.toLowerCase() === lower) return entry.quota
    return null
  }

  /** 按需读取（见 §4.2）；不抛错：失败时返回 status 'error' 的快照 */
  async refresh(provider: EngineQuotaProvider, opts: QuotaRefreshOptions = {}): Promise<AccountQuota> {
    this.watched.add(provider)
    return this.load(provider, opts, false)
  }

  /** 事件进来：核对来源（只认自有的 Claude / Codex 会话）后合并进当前账号的快照并广播 */
  observe(sessionId: string, patch: AccountQuotaPatch): void {
    const provider = this.processProvider(sessionId)
    if (!provider) return
    // 同步记一份：额度用完的事件和这一轮的失败常在同一块输出里，自动换账号时合并可能还没做完
    this.lastEvents.delete(sessionId)
    this.lastEvents.set(sessionId, patch)
    if (this.lastEvents.size > 200) this.lastEvents.delete(this.lastEvents.keys().next().value!)
    void this.merge(provider, patch).catch(error =>
      log.warn('合并额度事件失败', { provider, error: describeError(error) }),
    )
  }

  /** 一轮结束：这个 provider 有人看过、快照超过 5 分钟没主动取、这个会话的进程还活着才取；绝不为它起临时进程 */
  afterTurn(sessionId: string): void {
    const provider = this.processProvider(sessionId)
    if (!provider || !this.watched.has(provider)) return
    void this.load(provider, { maxAgeMs: AFTER_TURN_MAX_AGE_MS }, true).catch(() => undefined)
  }

  // ---------------------------------------------------------------------------

  /**
   * 这个会话的进程算不算用户自己的订阅：按进程启动时的来源（rt.sessionSource，null = 自己的账号）判断，不读当前记录——
   * 对话中途把通道换成「我的账号」要等下一条消息才换进程，期间旧的走网关进程还活着。平台 / 自定义接口、别的引擎的不算
   */
  private processProvider(sessionId: string): EngineQuotaProvider | null {
    const rt = this.ctx.runtimes.get(sessionId)
    if (!rt?.session || rt.sessionSource !== null) return null
    return providerOfEngine((rt.execution ?? rt.snapshot.record).engine)
  }

  /** 当前账号的键：adapter.info() 有缓存，基本不花时间 */
  private async identity(provider: EngineQuotaProvider): Promise<Identity> {
    const adapter = this.ctx.adapters[QUOTA_ENGINE[provider]]
    if (!adapter) throw new Error('引擎不可用')
    const info = await adapter.info()
    const email = info.account?.email?.trim() || null
    const infoKey = `${provider}:${email ?? '?'}`
    return {
      key: this.alias.get(infoKey) ?? infoKey,
      email,
      ready: info.status === 'ready',
      infoKey,
      version: info.version ?? null,
    }
  }

  private entry(key: string, provider: EngineQuotaProvider, email: string | null): Entry {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        quota: emptyQuota(provider, email),
        inflight: null,
        lastAttempt: 0,
        failures: 0,
        unrefreshableVersion: null,
      }
      this.entries.set(key, entry)
    }
    return entry
  }

  private publish(provider: EngineQuotaProvider, quota: AccountQuota): void {
    const json = JSON.stringify({ ...quota, observedAt: null })
    if (this.sent.get(provider) === json) return
    this.sent.set(provider, json)
    if (!this.ctx.closing) this.ctx.opts.onQuota?.(quota)
  }

  private async merge(provider: EngineQuotaProvider, patch: AccountQuotaPatch): Promise<void> {
    const { key, email } = await this.identity(provider)
    const entry = this.entry(key, provider, email)
    entry.quota = mergeQuota(entry.quota, patch)
    this.publish(provider, entry.quota)
  }

  /** 借一个自有、活着的会话进程问；没有返回 null。「自有」按进程启动时的来源判断，见 processProvider */
  private borrow(provider: EngineQuotaProvider): Promise<QuotaReading> | null {
    const engine = QUOTA_ENGINE[provider]
    for (const [id, rt] of this.ctx.runtimes) {
      if ((rt.execution ?? rt.snapshot.record).engine !== engine || this.processProvider(id) !== provider) continue
      const asked = rt.session?.accountQuota?.()
      if (asked) return asked
    }
    return null
  }

  private async load(
    provider: EngineQuotaProvider,
    opts: QuotaRefreshOptions,
    borrowOnly: boolean,
  ): Promise<AccountQuota> {
    // 应用正在退出：不再读，更不能为它起临时进程
    if (this.ctx.closing) return (await this.get(provider)) ?? emptyQuota(provider, null)
    let id: Identity
    try {
      id = await this.identity(provider)
    } catch (error) {
      return this.failed(provider, null, error)
    }
    // 引擎不可用 / 没登录：没有订阅额度（不存）
    if (!id.ready) return { ...emptyQuota(provider, id.email), status: 'unsupported' }
    const entry = this.entry(id.key, provider, id.email)
    // 单飞：手动刷新也并进去
    if (entry.inflight) return entry.inflight
    const now = Date.now()
    const q = entry.quota
    if (opts.force) {
      if (now - entry.lastAttempt < FORCE_MIN_GAP_MS) return q
    } else {
      const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS
      if (q.fetchedAt !== null && now - q.fetchedAt < maxAge) return q
      // 引擎不认识 get_usage：同一个版本不再试；重新检测 / 更新后版本变了就重新试
      if (!q.refreshable && entry.unrefreshableVersion === (id.version ?? '')) return q
      if (q.status === 'unsupported' && now - entry.lastAttempt < UNSUPPORTED_RECHECK_MS) return q
      if (entry.failures > 0 && now - entry.lastAttempt < ERROR_BACKOFF_MS[Math.min(entry.failures, 3) - 1]) return q
    }
    const adapter = this.ctx.adapters[QUOTA_ENGINE[provider]]
    let borrowed: Promise<QuotaReading> | null
    try {
      borrowed = this.borrow(provider)
    } catch (error) {
      borrowed = Promise.reject(error)
    }
    // 每轮结束只借会话进程，没有就算了，也不记这次尝试
    if (borrowOnly && !borrowed) return q
    const lastAttemptBefore = entry.lastAttempt
    entry.lastAttempt = now
    // 适配器自己的读取（Claude 临时进程 / Codex 只读进程）
    const viaAdapter = (): Promise<QuotaReading> => {
      try {
        return adapter?.accountQuota ? adapter.accountQuota() : Promise.resolve({ kind: 'unsupported' as const })
      } catch (error) {
        return Promise.reject(error)
      }
    }
    // null：这次不算（每轮结束的补取遇到会话进程被打断 / 不认识 get_usage）：不起临时进程，不记失败，也不记这次尝试
    let asked: Promise<QuotaReading | null>
    if (!borrowed) asked = viaAdapter()
    else if (borrowOnly)
      asked = borrowed.then(
        reading => (reading.kind === 'no-request' ? null : reading),
        error => (interrupted(error) ? null : Promise.reject(error)),
      )
    else
      asked = borrowed.then(
        // 会话进程可能是更新前开着的旧版（不认识 get_usage），或在读取途中被打断 / 重启：改用临时进程再读一次再下结论
        reading => (reading.kind === 'no-request' ? viaAdapter() : reading),
        error => (interrupted(error) ? viaAdapter() : Promise.reject(error)),
      )
    entry.inflight = asked
      .then(
        reading => {
          if (reading) return this.settle(provider, id, entry, reading)
          entry.lastAttempt = lastAttemptBefore
          return entry.quota
        },
        error => this.settleError(provider, id, entry, error),
      )
      .finally(() => {
        entry.inflight = null
      })
    return entry.inflight
  }

  /** 这个键现在还是不是当前账号的键：读取花了好几十秒，期间用户可能退出 / 换了账号 */
  private async isCurrent(provider: EngineQuotaProvider, key: string): Promise<boolean> {
    const now = await this.identity(provider).catch(() => null)
    return !!now && now.key === key
  }

  /** 读取成功：按结果换掉快照（§4.2 第 7 步）；只有结果属于读完时的当前账号才广播，否则只存进对应账号的记录 */
  private async settle(
    provider: EngineQuotaProvider,
    id: Identity,
    entry: Entry,
    reading: QuotaReading,
  ): Promise<AccountQuota> {
    const now = Date.now()
    entry.failures = 0
    // 读完时重新取一次当前账号（adapter.info() 有缓存）
    const current = await this.identity(provider).catch(() => null)
    // 检测到的账号和读取开始时一样：才可以改别名；不一样说明用户已经退出 / 换了账号
    const sameDetected = !!current && current.infoKey === id.infoKey
    if (reading.kind === 'ok') {
      // 回包里的账号和检测到的不一样（用户在终端里换过账号）：以回包为准，存到那个键下，并重新检测一次；
      // 一样了（重新检测后对上、或本来就一样）：撤掉别名，写回原键
      const account = reading.account
      let targetKey = id.key
      let target = entry
      if (account) {
        const mismatch = account.toLowerCase() !== (id.email ?? '').toLowerCase()
        targetKey = mismatch ? `${provider}:${account}` : id.infoKey
        if (targetKey !== id.key) {
          target = this.entry(targetKey, provider, account)
          target.lastAttempt = entry.lastAttempt
        }
        if (sameDetected) {
          if (mismatch) {
            this.alias.set(id.infoKey, targetKey)
            this.redetect(provider, id.infoKey, account)
          } else {
            this.alias.delete(id.infoKey)
            this.redetected.delete(id.infoKey)
          }
        }
      }
      const data = { windows: reading.windows, extras: reading.extras, blocked: reading.blocked }
      target.quota = {
        ...target.quota,
        status: hasData(data) ? 'ok' : 'empty',
        plan: reading.plan,
        account: account ?? id.email,
        ...data,
        observedAt: now,
        fetchedAt: now,
        source: 'usage',
        refreshable: true,
        error: null,
      }
      target.unrefreshableVersion = null
      if (current && (this.alias.get(current.infoKey) ?? current.infoKey) === targetKey)
        this.publish(provider, target.quota)
      return target.quota
    }
    if (reading.kind === 'unsupported') {
      entry.quota = {
        ...entry.quota,
        status: 'unsupported',
        plan: null,
        windows: [],
        extras: {},
        blocked: null,
        observedAt: now,
        fetchedAt: now,
        error: null,
      }
    } else {
      // 引擎版本不支持主动读取：只靠对话里的事件；记下判定时的版本，版本变了再试
      entry.quota = {
        ...entry.quota,
        status: hasData(entry.quota) ? 'ok' : 'empty',
        refreshable: false,
        error: null,
      }
      entry.unrefreshableVersion = id.version ?? ''
    }
    if (current && current.key === id.key) this.publish(provider, entry.quota)
    return entry.quota
  }

  private async settleError(
    provider: EngineQuotaProvider,
    id: Identity,
    entry: Entry,
    error: unknown,
  ): Promise<AccountQuota> {
    entry.failures++
    const classified = classifyQuotaError(error, QUOTA_HOST[provider])
    log.warn('读取账号额度失败', { provider, code: classified.code, error: describeError(error) })
    entry.quota = { ...entry.quota, status: 'error', error: classified }
    if (await this.isCurrent(provider, id.key)) this.publish(provider, entry.quota)
    return entry.quota
  }

  /** 连引擎信息都拿不到时的失败快照（不存） */
  private failed(provider: EngineQuotaProvider, email: string | null, error: unknown): AccountQuota {
    return { ...emptyQuota(provider, email), status: 'error', error: classifyQuotaError(error, QUOTA_HOST[provider]) }
  }

  /** 重新检测引擎（账号变了）；重新检测后邮箱对上了就不再需要别名 */
  private redetect(provider: EngineQuotaProvider, infoKey: string, account: string): void {
    // 已经为这个对不上的组合重新检测过一次：不再反复起检测进程
    if (this.redetected.get(infoKey) === account) return
    this.redetected.set(infoKey, account)
    void this.ctx.m.settings
      .engines(true)
      .then(async () => {
        const next = await this.identity(provider).catch(() => null)
        if (next && next.email?.toLowerCase() === account.toLowerCase()) {
          this.alias.delete(infoKey)
          this.redetected.delete(infoKey)
        }
      })
      .catch(() => undefined)
  }
}
