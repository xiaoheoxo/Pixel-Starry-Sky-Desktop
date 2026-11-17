// 订阅账号多开（docs/ui/engine-accounts.md、engine-accounts-claude.md）：账号列表、切换、添加 / 重新登录 / 移除、
// 各账号额度、额度用完自动换账号。Codex 和 Claude Code。当前账号是全局的：适配器启动引擎时按 currentDir() 换
// CODEX_HOME / CLAUDE_CONFIG_DIR，launchKey 带上账号 id，切换后正在跑的这一轮不受影响，下一条消息前换进程接上原对话。
import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  DEFAULT_ACCOUNT,
  viaGateway,
  type AccountAutoSwitch,
  type AccountEngine,
  type AccountPatch,
  type EngineAccount,
  type EngineAccountQuota,
  type EngineAccounts,
  type EngineId,
  type EngineLogin,
  type AccountQuota,
  type EngineQuotaProvider,
  type QuotaWindow,
  type NoticeAccountSwitch,
  type NoticePlatformFallback,
  type QueuedMessage,
  type SessionRecord,
} from '@pixelsky/protocol'
import type { AccountProbe } from '../adapter'
import { logger } from '../log'
import type { HostContext, PlatformRouteResult } from './context'
import { providerOfEngine } from './quota'

const log = logger('engine.accounts')

const ENGINES: readonly AccountEngine[] = ['codex', 'claude']
/** 账号额度在 HostQuota 里的 provider */
const QUOTA_PROVIDER: Record<AccountEngine, EngineQuotaProvider> = { codex: 'chatgpt', claude: 'claude' }
/** 自动换过账号后，每轮结束最多隔多久去看一次原账号恢复没有（没有恢复时间时） */
const SWITCH_BACK_CHECK_MS = 10 * 60_000
const ACCOUNT_ID = /^a_[a-f0-9]{12}$/
const LABEL_MAX = 40
/** 各账号额度缓存多久 */
const QUOTA_TTL = 60_000
/** 改用平台时挑线路最多等多久：平台目录读不到也不能让这条一直挂着 */
const ROUTE_TIMEOUT_MS = 30_000

export const DEFAULT_AUTO: AccountAutoSwitch = {
  enabled: false,
  order: 'list',
  switchBack: true,
  notice: true,
  platform: false,
}

/** 订阅额度都用完、要改用平台的这条消息（platformFallback 判断，fallbackToPlatform 去挑线路） */
export interface PlatformFallbackPlan {
  engine: AccountEngine
  /** 用完的订阅账号 */
  from: string
  fromName: string
  /** 会话现在的模型（挑线路按它，换回订阅时恢复它）；null 是引擎默认 */
  model: string | null
  window: NoticePlatformFallback['window']
  resetsAt: number | null
}

interface EngineState {
  current: string
  accounts: EngineAccount[]
  auto: AccountAutoSwitch
  /** 自动换账号之前用的那个：额度恢复后换回去（auto.switchBack） */
  switchedFrom: string | null
  /** 原账号的恢复时间（毫秒）：到了才去读它的额度；不知道为 null */
  switchedFromResetsAt: number | null
  /** 原来的账号在像素星空里删掉（隐藏）了：不列出、不会被用到（终端里照常）。只在还有添加的账号时成立 */
  hideDefault: boolean
  /** 删除了、凭据文件还没删的添加账号：有进程在用（换账号之前开的对话）时先留着，进程没了再删 */
  cleanup: string[]
}

const text = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null

function readAuto(raw: unknown): AccountAutoSwitch {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    enabled: o.enabled === true,
    order: o.order === 'most' ? 'most' : 'list',
    switchBack: o.switchBack !== false,
    notice: o.notice !== false,
    platform: o.platform === true,
  }
}

function readAccount(raw: unknown): EngineAccount | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const id = typeof o.id === 'string' ? o.id : ''
  if (id !== DEFAULT_ACCOUNT && !ACCOUNT_ID.test(id)) return null
  return {
    id,
    email: text(o.email),
    plan: text(o.plan, 40),
    label: text(o.label, LABEL_MAX),
    addedAt: typeof o.addedAt === 'number' && Number.isFinite(o.addedAt) ? o.addedAt : 0,
    status: o.status === 'ok' || o.status === 'expired' ? o.status : 'unknown',
  }
}

/** 设置文件是用户可改的 JSON：读出来再过一遍，不合法的项丢掉 */
export function readAccountsFile(raw: unknown): Partial<Record<AccountEngine, EngineState>> {
  const out: Partial<Record<AccountEngine, EngineState>> = {}
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  for (const engine of ENGINES) {
    const e = o[engine] && typeof o[engine] === 'object' ? (o[engine] as Record<string, unknown>) : null
    if (!e) continue
    const accounts: EngineAccount[] = []
    for (const a of Array.isArray(e.accounts) ? e.accounts : []) {
      const account = readAccount(a)
      if (account && !accounts.some(x => x.id === account.id)) accounts.push(account)
    }
    // 原来的账号隐藏着：要还有添加的账号才成立（不然没有账号可用），这时列表里不留它
    const hideDefault = e.hideDefault === true && accounts.some(a => a.id !== DEFAULT_ACCOUNT)
    const list = hideDefault ? accounts.filter(a => a.id !== DEFAULT_ACCOUNT) : accounts
    const known = (id: unknown): id is string => typeof id === 'string' && list.some(a => a.id === id)
    const cleanup: string[] = []
    for (const id of Array.isArray(e.cleanup) ? e.cleanup : [])
      if (typeof id === 'string' && ACCOUNT_ID.test(id) && !known(id) && !cleanup.includes(id) && cleanup.length < 100)
        cleanup.push(id)
    out[engine] = {
      current: known(e.current) ? e.current : hideDefault ? list[0].id : DEFAULT_ACCOUNT,
      accounts: list,
      auto: readAuto(e.auto),
      switchedFrom: known(e.switchedFrom) ? e.switchedFrom : null,
      switchedFromResetsAt:
        known(e.switchedFrom) && typeof e.switchedFromResetsAt === 'number' && Number.isFinite(e.switchedFromResetsAt)
          ? e.switchedFromResetsAt
          : null,
      hideDefault,
      cleanup,
    }
  }
  return out
}

/** 窗口里用得最多的百分比；被拒、读不到算 100 */
const usedOf = (q: EngineAccountQuota | undefined): number | null =>
  !q
    ? null
    : q.blocked
      ? 100
      : q.windows.length
        ? Math.max(...q.windows.map(w => (w.rejected ? 100 : w.usedPercent)))
        : null

export const accountEngine = (engine: EngineId): AccountEngine => {
  if (!(ENGINES as readonly string[]).includes(engine)) throw new Error('这个引擎还不支持多账号')
  return engine as AccountEngine
}

export class HostAccounts {
  private state: Partial<Record<AccountEngine, EngineState>>
  private readonly quotas = new Map<string, EngineAccountQuota>()
  private readonly quotaAt = new Map<AccountEngine, number>()
  private readonly reading = new Map<AccountEngine, Promise<EngineAccountQuota[]>>()
  /** 换了当前账号后的重新检测：检测完之前适配器的 info() 还是上一个账号的 */
  private readonly detecting = new Map<EngineId, Promise<unknown>>()
  /** 自动换过账号的队列项：同一条消息只换一次，所有账号都用完时不来回换 */
  private readonly autoSwitched = new Set<string>()
  /** 每轮结束看原账号恢复没有：上次去读的时间、正在读的 */
  private readonly backCheckedAt = new Map<AccountEngine, number>()
  private readonly backChecking = new Set<AccountEngine>()
  /** 改用过平台的队列项：同一条消息只改一次 */
  private readonly platformSwitched = new Set<string>()
  /** 改用了平台的会话，每轮结束看订阅额度恢复没有：上次去读的时间、正在读的 */
  private readonly fallbackCheckedAt = new Map<string, number>()
  private readonly fallbackChecking = new Set<string>()

  constructor(private readonly ctx: HostContext) {
    this.state = readAccountsFile(ctx.store.loadAccounts())
  }

  private engineState(engine: AccountEngine): EngineState {
    return (this.state[engine] ??= {
      current: DEFAULT_ACCOUNT,
      accounts: [],
      auto: { ...DEFAULT_AUTO },
      switchedFrom: null,
      switchedFromResetsAt: null,
      hideDefault: false,
      cleanup: [],
    })
  }

  private adapter(engine: AccountEngine) {
    const adapter = this.ctx.adapters[engine]
    if (!adapter?.accountProbe || !adapter.accountLogin || !adapter.accountLogout)
      throw new Error('这个引擎还不支持多账号')
    return adapter as typeof adapter & Required<Pick<typeof adapter, 'accountProbe' | 'accountLogin' | 'accountLogout'>>
  }

  /** 账号的目录；原来的账号是 null（用户本来的 CODEX_HOME） */
  dir(engine: AccountEngine, id: string): string | null {
    return id === DEFAULT_ACCOUNT ? null : join(this.ctx.opts.dataDir, 'accounts', engine, id)
  }

  currentId(engine: EngineId): string {
    const s = (this.state as Partial<Record<EngineId, EngineState>>)[engine]
    if (!s) return DEFAULT_ACCOUNT
    if (s.accounts.some(a => a.id === s.current)) return s.current
    // 原来的账号隐藏着时不会回到它
    return s.hideDefault && s.accounts.length ? s.accounts[0].id : DEFAULT_ACCOUNT
  }

  /** 适配器启动引擎时用的目录 */
  currentDir(engine: AccountEngine): string | null {
    return this.dir(engine, this.currentId(engine))
  }

  /** 固定账号的 Dot 连接只能读取仍在账号库里的目录，不能拼接外部传入的路径。 */
  knownDir(engine: AccountEngine, id: string): string | null {
    const s = this.engineState(engine)
    // 原有登录由 list() 动态列出，未添加其它账号时不写进 accounts 文件。
    if (id === DEFAULT_ACCOUNT && !s.hideDefault) return null
    if (!s.accounts.some(a => a.id === id)) throw new Error('Saved ChatGPT account unavailable')
    return this.dir(engine, id)
  }

  private save(): void {
    try {
      this.ctx.store.saveAccounts({ version: 1, ...this.state })
    } catch (error) {
      log.warn('save accounts failed', { error: (error as Error).message })
    }
  }

  private publish(engine: AccountEngine): void {
    if (!this.ctx.closing) this.ctx.opts.emit({ kind: 'engine_accounts', accounts: this.snapshot(engine) })
  }

  private snapshot(engine: AccountEngine): EngineAccounts {
    const s = this.engineState(engine)
    return {
      engine,
      current: this.currentId(engine),
      accounts: s.accounts.map(a => ({ ...a })),
      auto: { ...s.auto },
      defaultHidden: s.hideDefault,
    }
  }

  /** 换了当前账号：重新检测（引擎卡片上的邮箱、套餐跟着变），广播列表 */
  private changed(engine: AccountEngine, redetect: boolean): void {
    this.save()
    this.publish(engine)
    if (!redetect) return
    // 当前账号换了（切换、重新登录、自动换）：重新检测后，额度按新账号清掉重读（docs/ui/claude-login-recovery.md §1 第 1 条）
    const provider = providerOfEngine(engine)
    const run = this.ctx.m.settings.engines(true)
    this.detecting.set(
      engine,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    void run.then(() => (provider ? this.ctx.m.quota.reset(provider) : undefined)).catch(() => undefined)
  }

  /** 额度按账号认之前先等它：切号后的检测没完时，按旧检测结果会把上一个账号的额度当成当前的 */
  detected(engine: EngineId): Promise<unknown> | undefined {
    return this.detecting.get(engine)
  }

  /**
   * 列表。原来的账号：在用它时按检测结果更新邮箱和套餐；还没添加过别的账号时，登录着就作为唯一一项列出（不写进文件）
   */
  async list(engine: EngineId): Promise<EngineAccounts> {
    const e = accountEngine(engine)
    const s = this.engineState(e)
    this.sweep(e)
    const info = await this.ctx.adapters[e]?.info().catch(() => null)
    if (this.currentId(e) === DEFAULT_ACCOUNT && info) {
      const email = text(info.account?.email),
        plan = text(info.account?.plan, 40)
      const row = s.accounts.find(a => a.id === DEFAULT_ACCOUNT)
      if (row && (row.email !== email || row.plan !== plan) && email) {
        Object.assign(row, { email, plan, status: 'ok' as const })
        this.save()
      }
      if (!s.accounts.length && email)
        return {
          ...this.snapshot(e),
          accounts: [{ id: DEFAULT_ACCOUNT, email, plan, label: null, addedAt: 0, status: 'ok' }],
        }
    }
    return this.snapshot(e)
  }

  /** 添加账号：登录到一个新目录，成功后读出邮箱加进列表，不换掉当前账号 */
  add(engine: EngineId, method: 'browser' | 'device'): EngineLogin {
    const e = accountEngine(engine)
    const adapter = this.adapter(e)
    const id = 'a_' + randomBytes(6).toString('hex')
    const dir = this.dir(e, id)
    return this.ctx.m.login.loginEngine(e, method, {
      target: 'add',
      login: (m, onLine) => adapter.accountLogin(dir, m, onLine),
      verify: () => this.added(e, id),
    })
  }

  /**
   * 重新登录某个账号。添加的账号先登录到一个新目录，核对是同一个邮箱后这一行才改用新目录（id 跟着换）；
   * 授权时登成了别的账号就退出新目录、原目录和原来的登录一点不动（直接登录进原目录的话，别人的凭据会盖掉它，
   * 下次探测这一行就变成了别的账号）。Claude 在 macOS 上的凭据按目录存在钥匙串里，所以不搬文件、换目录。
   * 原来的账号（用户本来的配置目录）仍直接登录进去：那就是用户自己的 Claude Code / Codex 登录
   */
  relogin(engine: EngineId, id: string, method: 'browser' | 'device'): EngineLogin {
    const e = accountEngine(engine)
    const adapter = this.adapter(e)
    const row = this.find(e, id)
    if (row.id !== DEFAULT_ACCOUNT) {
      const fresh = 'a_' + randomBytes(6).toString('hex')
      const dir = this.dir(e, fresh)
      // 没用上的新目录：和删除账号一样不跑退出登录（只在像素星空里生效），凭据文件等没有进程在用时删掉
      const reject = (message: string): string => {
        this.forgetLater(e, fresh)
        return message
      }
      return this.ctx.m.login.loginEngine(e, method, {
        target: row.id,
        login: (m, onLine) => adapter.accountLogin(dir, m, onLine),
        verify: async () => {
          const probe = await adapter.accountProbe(dir)
          if (!probe.signedIn) return reject('登录命令结束了，但还没有登录成功')
          // 登录期间这一行可能被移除了
          const live = this.engineState(e).accounts.find(a => a.id === row.id)
          if (!live) return reject('这个账号已经不在列表里了')
          const email = probe.email?.toLowerCase()
          if (live.email && email && live.email.toLowerCase() !== email)
            return reject(`登录的是 ${probe.email}，不是 ${live.email}。要添加新账号请用「添加账号」`)
          const other = this.engineState(e).accounts.find(a => a !== live && a.email?.toLowerCase() === email)
          if (email && other) return reject(`${probe.email} 已经在列表里了`)
          this.renameRow(e, live, fresh)
          this.applyProbe(e, live, probe)
          this.changed(e, this.currentId(e) === live.id)
          return null
        },
      })
    }
    const dir = this.dir(e, row.id)
    return this.ctx.m.login.loginEngine(e, method, {
      target: row.id,
      login: (m, onLine) => adapter.accountLogin(dir, m, onLine),
      verify: async () => {
        const probe = await adapter.accountProbe(dir)
        if (!probe.signedIn) return '登录命令结束了，但还没有登录成功'
        if (row.email && probe.email && row.email.toLowerCase() !== probe.email.toLowerCase())
          return `登录的是 ${probe.email}，不是 ${row.email}。要添加新账号请用「添加账号」`
        this.applyProbe(e, row, probe)
        this.changed(e, this.currentId(e) === row.id)
        return null
      },
    })
  }

  /**
   * 重新登录成功：这一行改用新目录。当前账号、换回去的原账号、额度记录跟着换 id；旧目录和删除账号一样不跑退出登录，
   * 本机的凭据文件等没有进程在用时删掉（还在用旧目录的对话下一条消息前就按新 id 换进程了）
   */
  private renameRow(engine: AccountEngine, row: EngineAccount, id: string): void {
    const s = this.engineState(engine)
    const old = row.id
    row.id = id
    if (s.current === old) s.current = id
    if (s.switchedFrom === old) s.switchedFrom = id
    const quota = this.quotas.get(`${engine}:${old}`)
    this.quotas.delete(`${engine}:${old}`)
    if (quota) this.quotas.set(`${engine}:${id}`, { ...quota, id })
    this.forgetLater(engine, old)
  }

  /** 这个添加账号的目录不再用了：记进 cleanup，没有进程在用时删掉本机的凭据文件（sweep） */
  private forgetLater(engine: AccountEngine, id: string): void {
    const s = this.engineState(engine)
    if (id === DEFAULT_ACCOUNT || s.accounts.some(a => a.id === id)) return
    if (!s.cleanup.includes(id)) s.cleanup.push(id)
    this.save()
    this.sweep(engine)
  }

  private find(engine: AccountEngine, id: string): EngineAccount {
    const row = this.engineState(engine).accounts.find(a => a.id === id)
    if (!row) throw new Error('没有这个账号')
    return row
  }

  private applyProbe(engine: AccountEngine, row: EngineAccount, probe: AccountProbe): void {
    row.status = probe.signedIn ? 'ok' : 'expired'
    if (probe.email) row.email = probe.email
    if (probe.plan) row.plan = probe.plan
    const q = probe.quota
    this.quotas.set(`${engine}:${row.id}`, {
      id: row.id,
      windows: q?.kind === 'ok' ? q.windows : [],
      blocked: q?.kind === 'ok' ? !!q.blocked : false,
      observedAt: Date.now(),
    })
  }

  /** 添加的账号登录成功：读邮箱；已经在列表里的不重复添加（退出新目录里的登录） */
  private async added(engine: AccountEngine, id: string): Promise<string | null> {
    const adapter = this.adapter(engine)
    const dir = this.dir(engine, id)
    const probe = await adapter.accountProbe(dir)
    if (!probe.signedIn) return '登录命令结束了，但还没有登录成功'
    const s = this.engineState(engine)
    // 第一次添加：原来的账号登录着就先放进列表（排第一）。读它的时候另一个添加可能已经放进去了
    // （两个浏览器差不多同时登录完），放之前再看一次，免得原来的账号出现两次
    if (!s.accounts.length && !s.hideDefault) {
      const original = await adapter.accountProbe(null).catch(() => null)
      if (original?.signedIn && !s.hideDefault && !s.accounts.some(a => a.id === DEFAULT_ACCOUNT)) {
        const row: EngineAccount = {
          id: DEFAULT_ACCOUNT,
          email: null,
          plan: null,
          label: null,
          addedAt: 0,
          status: 'ok',
        }
        this.applyProbe(engine, row, original)
        s.accounts.unshift(row)
      }
    }
    const same = probe.email && s.accounts.find(a => a.email && a.email.toLowerCase() === probe.email!.toLowerCase())
    if (same) {
      // 不跑退出登录（只在像素星空里生效）：新目录里刚写的凭据文件删掉
      if (!s.cleanup.includes(id)) s.cleanup.push(id)
      this.changed(engine, false)
      this.sweep(engine)
      return `${probe.email} 已经在列表里了`
    }
    const row: EngineAccount = { id, email: null, plan: null, label: null, addedAt: Date.now(), status: 'ok' }
    this.applyProbe(engine, row, probe)
    s.accounts.push(row)
    this.changed(engine, false)
    return null
  }

  async switchTo(engine: EngineId, id: string): Promise<EngineAccounts> {
    const e = accountEngine(engine)
    const s = this.engineState(e)
    const row = this.find(e, id)
    if (row.status === 'expired') throw new Error('这个账号的登录已失效，请先重新登录')
    if (this.currentId(e) !== id) {
      s.current = id
      // 手动换过就不再自动换回去
      s.switchedFrom = null
      s.switchedFromResetsAt = null
      this.changed(e, true)
    }
    return this.snapshot(e)
  }

  /**
   * 删除账号（只在像素星空里生效，docs/ui/engine-accounts.md §5.1）：不跑退出登录命令、不联网，终端里的引擎和
   * 别处登录的同一账号都不受影响。
   * - 添加的账号：移出列表；账号目录里本机的凭据文件等没有进程在用时删掉（换账号之前开的对话照常用到进程结束）。
   * - 原来的账号：只是隐藏（不列出、不会被用到），要还有别的可用账号才行；「显示原来的账号」放回来。
   * 删的是当前账号时先换到别的：列表里第一个没失效的，都没有时回到原来的账号。删完没有添加的账号了，原来的账号回来
   */
  async remove(engine: EngineId, id: string): Promise<EngineAccounts> {
    const e = accountEngine(engine)
    const s = this.engineState(e)
    this.find(e, id)
    const before = this.currentId(e)
    const others = s.accounts.filter(a => a.id !== id)
    const usable = others.find(a => a.status !== 'expired')
    if (id === DEFAULT_ACCOUNT && !usable)
      throw new Error('没有别的可用账号，原来的账号不能删除。先添加一个账号，或者把失效的账号重新登录')
    if (id === before) {
      s.current = usable?.id ?? DEFAULT_ACCOUNT
      s.switchedFrom = null
      s.switchedFromResetsAt = null
    }
    s.accounts = others
    if (id === DEFAULT_ACCOUNT) s.hideDefault = true
    else if (!s.cleanup.includes(id)) s.cleanup.push(id)
    if (s.switchedFrom === id) {
      s.switchedFrom = null
      s.switchedFromResetsAt = null
    }
    this.quotas.delete(`${e}:${id}`)
    // 没有添加的账号了：原来的账号不能再隐藏，列表清空，界面回到单账号
    if (!s.accounts.some(a => a.id !== DEFAULT_ACCOUNT)) {
      s.accounts = []
      s.hideDefault = false
      s.current = DEFAULT_ACCOUNT
    }
    this.changed(e, this.currentId(e) !== before)
    this.sweep(e)
    return this.snapshot(e)
  }

  /** 把删除（隐藏）了的原来的账号放回列表（排第一），读一次它现在的登录状态 */
  async showDefault(engine: EngineId): Promise<EngineAccounts> {
    const e = accountEngine(engine)
    const s = this.engineState(e)
    if (!s.hideDefault) return this.snapshot(e)
    s.hideDefault = false
    const row: EngineAccount = {
      id: DEFAULT_ACCOUNT,
      email: null,
      plan: null,
      label: null,
      addedAt: 0,
      status: 'unknown',
    }
    s.accounts.unshift(row)
    this.changed(e, false)
    const probe = await this.adapter(e)
      .accountProbe(null)
      .catch(() => null)
    if (probe && s.accounts.includes(row)) {
      this.applyProbe(e, row, probe)
      this.changed(e, false)
    }
    return this.snapshot(e)
  }

  /** 删除了的添加账号：没有进程在用了就删掉账号目录里本机的凭据文件；删不掉的（文件被占着）下次再试 */
  private sweep(engine: AccountEngine): void {
    const s = this.engineState(engine)
    if (!s.cleanup.length) return
    const adapter = this.ctx.adapters[engine]
    const left = s.cleanup.filter(id => {
      const dir = this.dir(engine, id)
      if (!dir || !adapter?.accountForget) return false
      if (adapter.accountInUse?.(dir)) return true
      try {
        adapter.accountForget(dir)
        return false
      } catch (error) {
        log.warn('forget account failed', { engine, error: (error as Error).message })
        return true
      }
    })
    if (left.length === s.cleanup.length) return
    s.cleanup = left
    this.save()
  }

  update(engine: EngineId, id: string, patch: AccountPatch): EngineAccounts {
    const e = accountEngine(engine)
    const s = this.engineState(e)
    const row = this.find(e, id)
    if (patch.label !== undefined) {
      if (patch.label !== null && typeof patch.label !== 'string') throw new Error('备注不对')
      row.label = text(patch.label, LABEL_MAX)
    }
    if (patch.move === 'up') {
      const i = s.accounts.indexOf(row)
      if (i > 0) s.accounts.splice(i - 1, 2, row, s.accounts[i - 1])
    }
    this.changed(e, false)
    return this.snapshot(e)
  }

  setAuto(engine: EngineId, patch: Partial<AccountAutoSwitch>): EngineAccounts {
    const e = accountEngine(engine)
    const s = this.engineState(e)
    const next = { ...s.auto }
    for (const key of ['enabled', 'switchBack', 'notice', 'platform'] as const)
      if (patch[key] !== undefined) {
        if (typeof patch[key] !== 'boolean') throw new Error('自动切换的设置不对')
        next[key] = patch[key]
      }
    if (patch.order !== undefined) {
      if (patch.order !== 'list' && patch.order !== 'most') throw new Error('自动切换的设置不对')
      next.order = patch.order
    }
    s.auto = next
    if (!next.enabled || !next.switchBack) {
      s.switchedFrom = null
      s.switchedFromResetsAt = null
    }
    this.changed(e, false)
    return this.snapshot(e)
  }

  /** 各账号的额度和登录状态：一个一个起临时进程读，缓存 60 秒；读完看要不要换回原来的账号 */
  async quota(engine: EngineId, force = false): Promise<EngineAccountQuota[]> {
    const e = accountEngine(engine)
    const s = this.engineState(e)
    const rows = (): EngineAccountQuota[] => s.accounts.flatMap(a => this.quotas.get(`${e}:${a.id}`) ?? [])
    if (!force && Date.now() - (this.quotaAt.get(e) ?? 0) < QUOTA_TTL) return rows()
    const running = this.reading.get(e)
    if (running) return running
    const task = (async () => {
      const adapter = this.adapter(e)
      let statusChanged = false
      for (const row of [...s.accounts]) {
        if (this.ctx.closing) break
        const before = JSON.stringify([row.status, row.email, row.plan])
        try {
          this.applyProbe(e, row, await adapter.accountProbe(this.dir(e, row.id)))
        } catch (error) {
          const prev = this.quotas.get(`${e}:${row.id}`)
          this.quotas.set(`${e}:${row.id}`, {
            id: row.id,
            windows: prev?.windows ?? [],
            blocked: prev?.blocked ?? false,
            observedAt: prev?.observedAt ?? 0,
            error: (error as Error).message,
          })
        }
        if (JSON.stringify([row.status, row.email, row.plan]) !== before) statusChanged = true
      }
      this.quotaAt.set(e, Date.now())
      const back = this.switchBack(e)
      if (statusChanged || back) this.changed(e, back)
      return rows()
    })().finally(() => this.reading.delete(e))
    this.reading.set(e, task)
    return task
  }

  /** 自动换过账号、原来那个额度恢复了：换回去（下一条消息起） */
  private switchBack(engine: AccountEngine): boolean {
    const s = this.engineState(engine)
    const from = s.switchedFrom
    if (!s.auto.enabled || !s.auto.switchBack || !from || from === this.currentId(engine)) return false
    const row = s.accounts.find(a => a.id === from)
    const used = usedOf(this.quotas.get(`${engine}:${from}`))
    if (!row || row.status !== 'ok' || used === null || used >= 100) return false
    s.current = from
    s.switchedFrom = null
    s.switchedFromResetsAt = null
    log.info('switched back account', { engine })
    return true
  }

  /**
   * 一轮结束：自动换过账号、开着「额度恢复后换回」时，看原账号恢复没有，恢复了就换回去（从下一条消息起）。
   * 只读原账号这一个；知道恢复时间时到了才读，不知道时最多 10 分钟读一次（docs/ui/engine-accounts-claude.md §7）
   */
  afterTurn(engine: EngineId, sessionId?: string): void {
    if (!(ENGINES as readonly string[]).includes(engine)) return
    if (sessionId) this.fallbackBack(sessionId)
    const e = engine as AccountEngine
    const s = this.engineState(e)
    const from = s.switchedFrom
    if (!s.auto.enabled || !s.auto.switchBack || !from || from === this.currentId(e) || this.backChecking.has(e)) return
    const now = Date.now()
    const due =
      s.switchedFromResetsAt !== null
        ? now >= s.switchedFromResetsAt
        : now - (this.backCheckedAt.get(e) ?? 0) >= SWITCH_BACK_CHECK_MS
    if (!due) return
    const row = s.accounts.find(a => a.id === from)
    if (!row) return
    this.backChecking.add(e)
    this.backCheckedAt.set(e, now)
    void (async () => {
      try {
        this.applyProbe(e, row, await this.adapter(e).accountProbe(this.dir(e, from)))
        if (this.switchBack(e)) this.changed(e, true)
        // 读到了还没恢复：按新的恢复时间再等（不知道就按 10 分钟）
        else if (s.switchedFrom === from) s.switchedFromResetsAt = resetOf(this.quotas.get(`${e}:${from}`))
      } catch (error) {
        log.warn('check switch back failed', { engine: e, error: (error as Error).message })
      } finally {
        this.backChecking.delete(e)
      }
    })()
  }

  /** 下一个还有额度的账号：跳过当前的、登录失效的、上次读到已用完的 */
  private pickNext(engine: AccountEngine): EngineAccount | null {
    const s = this.engineState(engine)
    const current = this.currentId(engine)
    const i = s.accounts.findIndex(a => a.id === current)
    const ordered = [...s.accounts.slice(i + 1), ...s.accounts.slice(0, Math.max(0, i))]
    const usable = ordered.filter(a => {
      if (a.id === current || a.status === 'expired') return false
      const used = usedOf(this.quotas.get(`${engine}:${a.id}`))
      return used === null || used < 100
    })
    if (s.auto.order === 'most') {
      // 读到过额度的按已用从少到多，没读到的排在后面
      const rank = (a: EngineAccount): number => usedOf(this.quotas.get(`${engine}:${a.id}`)) ?? 101
      usable.sort((a, b) => rank(a) - rank(b))
    }
    return usable[0] ?? null
  }

  /**
   * 一轮因为额度用完失败（usageLimitExceeded：Codex 报的、Claude 收到 rejected 额度事件）：开了自动切换、会话走的是
   * 自己的订阅时换到下一个账号。返回提示条要用的信息；没换返回 null。同一条消息只换一次
   */
  autoSwitch(sessionId: string, queueId: string): NoticeAccountSwitch | null {
    const rt = this.ctx.runtimes.get(sessionId)
    if (!rt) return null
    const record = rt.execution ?? rt.snapshot.record
    if (!(ENGINES as readonly string[]).includes(record.engine) || viaGateway(record)) return null
    const e = record.engine as AccountEngine
    const s = this.engineState(e)
    if (!s.auto.enabled || s.accounts.length < 2 || this.autoSwitched.has(queueId)) return null
    const current = this.currentId(e)
    // 用完的是这个进程启动时的账号（rt.sessionAccount）：它晚到的失败不能记到别人头上——期间可能手动换过，
    // 或者同一账号的另一个会话已经先换走了；账号已经删了也不算到当前账号头上
    const from = rt.sessionAccount ?? current
    const fromRow = s.accounts.find(a => a.id === from)
    // 用完的是哪个窗口、几点恢复：换之前按原账号的邮箱取（换完再取就是新账号的了）
    const used = this.usedFor(sessionId, e, fromRow)
    // 启动时的账号已经删了：不记到任何账号上（当前账号还能用就留在它上面重发）
    if (fromRow) this.markUsed(e, from)
    // 当前账号已经不是用完的那个（换过了）、而且还能用：不再往下换，这条在当前账号上重发
    const currentRow = from !== current ? s.accounts.find(a => a.id === current) : undefined
    const stay =
      currentRow && currentRow.status !== 'expired' && (usedOf(this.quotas.get(`${e}:${current}`)) ?? 0) < 100
    const next = stay ? currentRow : this.pickNext(e)
    if (!next) return null
    this.autoSwitched.add(queueId)
    if (this.autoSwitched.size > 500) this.autoSwitched.delete(this.autoSwitched.values().next().value!)
    if (s.switchedFrom === null && !stay && fromRow) {
      s.switchedFrom = from
      s.switchedFromResetsAt = used.resetsAt
    }
    // 刚用完：不知道恢复时间时也先等 10 分钟再去看
    this.backCheckedAt.set(e, Date.now())
    if (!stay) {
      s.current = next.id
      log.info('auto switched account', { engine: e, sessionId })
      this.changed(e, true)
    } else this.publish(e)
    return {
      engine: e,
      from,
      to: next.id,
      fromName: nameOf(fromRow) ?? '原来的账号',
      toName: nameOf(next) ?? '另一个账号',
      window: used.window,
      resetsAt: used.resetsAt,
    }
  }

  /**
   * 额度用完又没换成账号 / 平台时，限流卡片要写的窗口和恢复时间（docs/ui/rate-limit-resume.md）：
   * 只对走自己订阅的会话读额度事件；经网关的平台 / 自定义接口、只有一条 429 的（kind 为 rate）都是 null
   */
  limitReading(sessionId: string, kind: 'quota' | 'rate'): Pick<NoticeAccountSwitch, 'window' | 'resetsAt'> {
    const none = { window: null, resetsAt: null }
    const rt = this.ctx.runtimes.get(sessionId)
    if (!rt || kind !== 'quota') return none
    const record = rt.execution ?? rt.snapshot.record
    if (!(ENGINES as readonly string[]).includes(record.engine) || viaGateway(record)) return none
    const e = record.engine as AccountEngine
    const s = this.engineState(e)
    const from = rt.sessionAccount ?? this.currentId(e)
    return this.usedFor(
      sessionId,
      e,
      s.accounts.find(a => a.id === from),
    )
  }

  /** 用完的是哪个窗口、几点恢复：先看这个会话最近的额度事件，没有时按这个账号的额度快照 */
  private usedFor(
    sessionId: string,
    engine: AccountEngine,
    row: EngineAccount | undefined,
  ): Pick<NoticeAccountSwitch, 'window' | 'resetsAt'> {
    const event = usedWindow(this.ctx.m.quota.lastEvent(sessionId))
    return event.resetsAt !== null || event.window !== null
      ? event
      : usedWindow(this.ctx.m.quota.peek(QUOTA_PROVIDER[engine], row?.email ?? null))
  }

  /** 用完的账号记成用完：「剩余最多」、换回去、要不要改用平台都按它算 */
  private markUsed(engine: AccountEngine, id: string): void {
    const prev = this.quotas.get(`${engine}:${id}`)
    this.quotas.set(`${engine}:${id}`, { id, windows: prev?.windows ?? [], blocked: true, observedAt: Date.now() })
  }

  /**
   * 一轮因为额度用完失败、又没换成账号（autoSwitch 返回 null）时：开了「订阅额度都用完时改用平台」、会话走的是自己的
   * 订阅、订阅账号都用不了（开着自动换账号时别的账号也用完 / 失效了）时，返回要改用平台的这条的信息；不改返回 null。
   * 之后 events.ts 让这条在队首等着重发、调 fallbackToPlatform 挑线路（docs/ui/engine-accounts.md §5.2）
   */
  platformFallback(sessionId: string, queueId: string): PlatformFallbackPlan | null {
    if (!this.ctx.opts.platformRoute) return null
    const rt = this.ctx.runtimes.get(sessionId)
    if (!rt) return null
    const record = rt.execution ?? rt.snapshot.record
    if (!(ENGINES as readonly string[]).includes(record.engine) || viaGateway(record)) return null
    const e = record.engine as AccountEngine
    const s = this.engineState(e)
    if (!s.auto.platform || this.platformSwitched.has(queueId)) return null
    const current = this.currentId(e)
    const from = rt.sessionAccount ?? current
    const fromRow = s.accounts.find(a => a.id === from)
    const used = this.usedFor(sessionId, e, fromRow)
    if (fromRow) this.markUsed(e, from)
    // 开着自动换账号、还有能换的（这次没换是因为同一条消息已经换过一次）：不改用平台，下一条消息再换账号
    const usable = (a: EngineAccount): boolean =>
      a.id !== from && a.status !== 'expired' && (usedOf(this.quotas.get(`${e}:${a.id}`)) ?? 0) < 100
    if (s.auto.enabled && s.accounts.some(usable)) return null
    return {
      engine: e,
      from,
      fromName: nameOf(fromRow) ?? ownName(e),
      model: rt.snapshot.record.model ?? null,
      window: used.window,
      resetsAt: used.resetsAt,
    }
  }

  /**
   * 改用平台（platformFallback 之后，这条已经在队首等着重发；rt.sourceSwitching 挡着派发，免得又用订阅发一次）。
   * 挑到线路：这个会话改用它和选到的模型、记下 platformFallback，排在后面按订阅排的消息一起改，加提示，接着派发；
   * 挑不到：这条照常算失败，错误后面写明为什么没改用平台。等的时候停止了、删了这条、自己改了来源或模型：什么都不改
   */
  async fallbackToPlatform(
    sessionId: string,
    queueId: string,
    plan: PlatformFallbackPlan,
    error: string | null,
  ): Promise<void> {
    const { ctx } = this
    const rt = ctx.runtimes.get(sessionId)
    const route = ctx.opts.platformRoute
    if (!rt || !route) return
    this.platformSwitched.add(queueId)
    if (this.platformSwitched.size > 500) this.platformSwitched.delete(this.platformSwitched.values().next().value!)
    rt.sourceSwitching = true
    let picked: PlatformRouteResult
    try {
      picked = await withTimeout(route({ engine: plan.engine, model: plan.model }), ROUTE_TIMEOUT_MS)
    } catch (err) {
      picked = { error: (err as Error).message || '读取平台线路失败' }
    } finally {
      rt.sourceSwitching = false
    }
    if (ctx.closing || ctx.runtimes.get(sessionId) !== rt) return
    const m = ctx.m
    const item = rt.snapshot.queue.find(q => q.id === queueId)
    const record = rt.snapshot.record
    const waiting = !!item?.reconnect?.account && item.status === 'queued' && !rt.snapshot.queuePaused
    if (
      !waiting ||
      viaGateway(record) ||
      record.model !== plan.model ||
      (record.nextEngine ?? record.engine) !== plan.engine
    ) {
      this.platformSwitched.delete(queueId)
      void m.turn.pump(sessionId)
      return
    }
    if ('error' in picked) {
      // 登录平台、充值后重试这条还能再改
      this.platformSwitched.delete(queueId)
      log.info('platform fallback unavailable', { engine: plan.engine, sessionId })
      m.queue.changeQueue(sessionId, queueId, {
        status: 'failed',
        error: `${error || '额度用完了'}\n没有改用平台：${picked.error}`,
        reconnect: undefined,
      })
      rt.snapshot = { ...rt.snapshot, queuePaused: true }
      m.queue.publishQueue(sessionId)
      m.events.armIdle(sessionId)
      return
    }
    const platform = { groupId: picked.groupId, account: picked.account }
    m.events.patchRecord(sessionId, {
      platform,
      provider: null,
      model: picked.model,
      platformFallback: { account: plan.from, model: plan.model, resetsAt: plan.resetsAt },
      updatedAt: Date.now(),
    })
    rt.snapshot = {
      ...rt.snapshot,
      queue: rt.snapshot.queue.map(q =>
        q.id !== queueId && queuedOn(q, null, plan.model, plan.engine)
          ? { ...q, settings: { ...q.settings, platform, provider: null, model: picked.model } }
          : q,
      ),
    }
    m.queue.publishQueue(sessionId)
    // 刚用完：不知道恢复时间时也先等 10 分钟再去看
    this.fallbackCheckedAt.set(sessionId, Date.now())
    if (this.fallbackCheckedAt.size > 500) this.fallbackCheckedAt.delete(this.fallbackCheckedAt.keys().next().value!)
    log.info('fell back to platform', { engine: plan.engine, sessionId })
    if (this.noticeOn(plan.engine))
      m.events.apply(sessionId, {
        type: 'item_completed',
        item: {
          kind: 'notice',
          id: `platform-fallback-${randomUUID()}`,
          level: 'info',
          text: `${plan.fromName} 的订阅额度用完了，已改用平台（${picked.group} · ${picked.model}）继续`,
          fallback: {
            engine: plan.engine,
            kind: 'platform',
            fromName: plan.fromName,
            group: picked.group,
            model: picked.model,
            selfModel: plan.model,
            window: plan.window,
            resetsAt: plan.resetsAt,
          },
        },
      })
    void m.turn.pump(sessionId)
  }

  /**
   * 一轮结束：这个会话因为订阅额度用完改用了平台、开着「额度恢复后换回」时，看订阅额度恢复没有；恢复了就换回自己的订阅
   * 和原来的模型（下一条消息起）。知道恢复时间时到了才读，不知道时最多 10 分钟读一次；读的是当前账号（换回去用的就是它）
   */
  private fallbackBack(sessionId: string): void {
    const rt = this.ctx.runtimes.get(sessionId)
    const record = rt?.snapshot.record
    const fb = record?.platformFallback
    if (!rt || !record || !fb || !record.platform || this.fallbackChecking.has(sessionId)) return
    if (!(ENGINES as readonly string[]).includes(record.engine)) return
    const e = record.engine as AccountEngine
    if (!this.engineState(e).auto.switchBack) return
    const current = this.currentId(e)
    const now = Date.now()
    const due =
      fb.resetsAt !== null && fb.account === current
        ? now >= fb.resetsAt
        : now - (this.fallbackCheckedAt.get(sessionId) ?? 0) >= SWITCH_BACK_CHECK_MS
    if (!due) return
    this.fallbackChecking.add(sessionId)
    this.fallbackCheckedAt.set(sessionId, now)
    void (async () => {
      try {
        const probe = await this.adapter(e).accountProbe(this.dir(e, current))
        const row = this.engineState(e).accounts.find(a => a.id === current)
        if (row) this.applyProbe(e, row, probe)
        const quota: EngineAccountQuota | undefined =
          probe.signedIn && probe.quota?.kind === 'ok'
            ? { id: current, windows: probe.quota.windows, blocked: !!probe.quota.blocked, observedAt: Date.now() }
            : undefined
        const used = usedOf(quota)
        const latest = this.ctx.runtimes.get(sessionId) === rt ? rt.snapshot.record : null
        // 等的时候自己改了来源、线路或模型（platformFallback 清掉了）：不换
        if (
          this.ctx.closing ||
          !latest?.platformFallback ||
          latest.platform?.groupId !== record.platform?.groupId ||
          latest.model !== record.model
        )
          return
        if (used === null || used >= 100) {
          // 还没恢复：按读到的恢复时间再等（不知道就按 10 分钟）
          this.ctx.m.events.patchRecord(sessionId, {
            platformFallback: { ...latest.platformFallback, account: current, resetsAt: resetOf(quota) },
          })
          return
        }
        this.switchToOwn(sessionId, e, latest, nameOf(row) ?? ownName(e))
      } catch (error) {
        log.warn('check platform fallback back failed', { engine: e, error: (error as Error).message })
      } finally {
        this.fallbackChecking.delete(sessionId)
      }
    })()
  }

  /** 订阅额度恢复了：会话换回自己的订阅和原来的模型，排在后面按这条线路排的消息一起换回 */
  private switchToOwn(sessionId: string, engine: AccountEngine, record: SessionRecord, name: string): void {
    const m = this.ctx.m
    const rt = m.sessions.runtime(sessionId)
    const fb = record.platformFallback!
    m.events.patchRecord(sessionId, {
      platform: null,
      provider: null,
      model: fb.model,
      platformFallback: null,
      updatedAt: Date.now(),
    })
    rt.snapshot = {
      ...rt.snapshot,
      queue: rt.snapshot.queue.map(q =>
        queuedOn(q, record.platform ?? null, record.model, engine)
          ? { ...q, settings: { ...q.settings, platform: null, provider: null, model: fb.model } }
          : q,
      ),
    }
    m.queue.publishQueue(sessionId)
    this.fallbackCheckedAt.delete(sessionId)
    log.info('switched back from platform', { engine, sessionId })
    if (this.noticeOn(engine))
      m.events.apply(sessionId, {
        type: 'item_completed',
        item: {
          kind: 'notice',
          id: `platform-back-${randomUUID()}`,
          level: 'info',
          text: `${name} 的订阅额度恢复了，从下一条消息起换回订阅`,
          fallback: {
            engine,
            kind: 'back',
            fromName: name,
            group: '',
            model: fb.model ?? '',
            selfModel: fb.model,
            window: null,
            resetsAt: null,
          },
        },
      })
  }

  /** 自动换了账号、改用了平台要不要在对话里提示 */
  noticeOn(engine: AccountEngine): boolean {
    return this.engineState(engine).auto.notice
  }
}

/** 列表里没有这个账号（只登了原来的一个）时提示条里的名字 */
const ownName = (engine: AccountEngine): string => (engine === 'codex' ? 'ChatGPT 账号' : 'Claude 账号')

/** 还在排队、按这个来源（null 是自己的订阅）和模型排的消息：改用平台 / 换回订阅时一起改 */
function queuedOn(
  q: QueuedMessage,
  platform: SessionRecord['platform'] | null,
  model: string | null,
  engine: AccountEngine,
): boolean {
  const s = q.settings
  return (
    q.status === 'queued' &&
    !q.reconnect &&
    (s.engine ?? engine) === engine &&
    !s.provider &&
    (s.platform?.groupId ?? null) === (platform?.groupId ?? null) &&
    (s.platform?.account ?? null) === (platform?.account ?? null) &&
    s.model === model
  )
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('读取平台线路超时')), ms)
    timer.unref?.()
  })
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer))
}

/** 提示条里的账号名：邮箱优先（和样式稿一样），没有邮箱用备注 */
const nameOf = (a: EngineAccount | undefined): string | null => a?.email || a?.label || null

/** 账号额度（快照或一次事件）里用完的窗口和恢复时间：先认明确拒绝 / 用满的 5 小时、本周窗口，再看整体被拒的 */
export function usedWindow(
  q: Pick<AccountQuota, 'windows' | 'blocked'> | { windows?: QuotaWindow[]; blocked?: AccountQuota['blocked'] } | null,
): Pick<NoticeAccountSwitch, 'window' | 'resetsAt'> {
  if (!q) return { window: null, resetsAt: null }
  const full = (q.windows ?? []).filter(w => w.rejected || w.usedPercent >= 100)
  // 两个都满了：要等更晚恢复的那个
  full.sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))
  const w = full.find(x => x.id === 'five_hour' || x.id === 'seven_day') ?? full[0]
  if (w) return { window: w.id === 'five_hour' || w.id === 'seven_day' ? w.id : null, resetsAt: w.resetsAt }
  return { window: null, resetsAt: q.blocked?.resetsAt ?? null }
}

/** 账号表里的额度什么时候恢复（用满的窗口里最晚的）；没用满、不知道为 null */
function resetOf(q: EngineAccountQuota | undefined): number | null {
  if (!q) return null
  const times = q.windows.filter(w => w.rejected || w.usedPercent >= 100).flatMap(w => (w.resetsAt ? [w.resetsAt] : []))
  return times.length ? Math.max(...times) : null
}
