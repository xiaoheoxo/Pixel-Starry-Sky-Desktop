// 账号额度的界面端存储（docs/ui/account-quota.md §6.4）：模块级 Map + 监听者，useSyncExternalStore 订阅。
// Claude / ChatGPT 经 window.pixelsky.quota（主进程按「引擎 + 账号」存一份，推 quota:changed）；
// 平台用账号模块现成的 AccountInfo 换算（platformQuota.ts）；演示模式不碰 bridge。
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type {
  AccountQuota,
  EngineQuotaProvider,
  QuotaProvider,
  QuotaRefreshOptions,
  ResetCreditOutcome,
} from '@pixelsky/protocol'
import { tr } from '@/i18n/core'
import type { QuotaBridge } from '../../../../../shared/types/quota'
import { isDemo, demo } from '@/data/demo'
import { useAccount } from '@/features/account/useAccount'
import { platformPlanLimits, platformQuota } from './platformQuota'
import type { PlanLimit } from './quotaModel'

/** 第一次显示按钮时：快照比这个旧（或没有）才去读 */
export const FIRST_SHOW_MAX_AGE_MS = 10 * 60_000
/** 打开弹窗时 */
export const OPEN_MAX_AGE_MS = 60_000
/** 演示模式里「刷新」假装读多久 */
const DEMO_REFRESH_MS = 600

interface Entry {
  quota: AccountQuota | null
  loading: boolean
  /** 已经向主进程要过缓存 */
  asked: boolean
}
const EMPTY: Entry = { quota: null, loading: false, asked: false }
const EMPTY_LOADING: Entry = { quota: null, loading: true, asked: false }

let entries: Partial<Record<EngineQuotaProvider, Entry>> = {}
/** 各 provider 在途的读取个数（重叠的读取不能让先回来的那个把 loading 清掉） */
const pending: Partial<Record<EngineQuotaProvider, number>> = {}
/**
 * 各 provider 当前通道的账号（引擎检测到的邮箱，null = 检测不到）。没设过（undefined）不比对。
 * 存的每份数据都带着快照自己的 account；和这里对不上就是上一个账号留下的，读和写都要丢掉
 */
const wanted: Partial<Record<EngineQuotaProvider, string | null>> = {}
const listeners = new Set<() => void>()
let listening = false

const norm = (account: string | null | undefined): string => (account ?? '').trim().toLowerCase()
/** 账号一样：忽略大小写；null 只等于 null，null 和有邮箱之间互换也算换了账号 */
export const sameAccount = (a: string | null | undefined, b: string | null | undefined): boolean => norm(a) === norm(b)
function belongs(quota: AccountQuota, account: string | null | undefined): boolean {
  return account === undefined || sameAccount(quota.account, account)
}

/** window.pixelsky.quota；老预加载、测试、普通浏览器里没有 */
function bridge(): QuotaBridge | null {
  if (typeof window === 'undefined') return null
  return (window.pixelsky as unknown as { quota?: QuotaBridge } | undefined)?.quota ?? null
}

function put(provider: EngineQuotaProvider, patch: Partial<Entry>): void {
  entries = { ...entries, [provider]: { ...(entries[provider] ?? EMPTY), ...patch } }
  listeners.forEach(fn => fn())
}

/** 最近一次提示过的自动用卡时间：同一次只提示一回 */
let autoNoticed: number | null = null

/** 用一张 Codex 重置卡（docs/ui/codex-reset-card.md）；用完主进程会重读并广播 */
export async function useResetCredit(): Promise<ResetCreditOutcome> {
  const b = bridge()
  if (!b?.useResetCredit) throw new Error('引擎不可用')
  return b.useResetCredit()
}

/** 第一次有人订阅时接一次 quota:changed，收到的快照按 provider 写进去 */
function listen(): void {
  if (listening || isDemo) return
  const b = bridge()
  if (!b) return
  listening = true
  try {
    b.onChange(q => {
      const auto = q.extras.resetCredits?.lastAutoAt
      if (auto && auto !== autoNoticed) {
        // 第一次收到时只记下，不提示：打开窗口前的那次早就过去了
        if (autoNoticed !== null || Date.now() - auto < 60_000)
          // 用到时才加载：窗格 store 牵连很多模块，测试和演示里导入额度 store 不该带上它
          void import('@/features/panes/store').then(m => m.notify(tr('resetCard.autoDone')))
        autoNoticed = auto
      }
      // pending：登录 / 换账号后主进程清掉了旧记录、正在重读，显示「读取中」（docs/ui/claude-login-recovery.md §1 第 1 条）
      if (q.provider !== 'platform' && belongs(q, wanted[q.provider]))
        put(q.provider, { quota: q, loading: q.pending === true || !!pending[q.provider] })
    })
  } catch {
    listening = false
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  listen()
  return () => listeners.delete(fn)
}

/** account 不传用 wanted（上次设的）；组件传自己这次渲染的账号，换了账号的第一帧就不会闪出旧数据 */
function entry(provider: EngineQuotaProvider, account: string | null | undefined = wanted[provider]): Entry {
  const current = entries[provider]
  if (current) {
    if (current.quota && !belongs(current.quota, account)) return current.loading ? EMPTY_LOADING : EMPTY
    return current
  }
  // 演示模式：第一次读取时装进演示数据（之后保持同一个对象，useSyncExternalStore 要求快照稳定）
  if (isDemo) {
    const seeded: Entry = { quota: demo().quota[provider], loading: false, asked: true }
    entries = { ...entries, [provider]: seeded }
    return seeded
  }
  return EMPTY
}

/** 当前存的快照（非 hook；测试和一次性判断用） */
export const getQuota = (provider: EngineQuotaProvider): AccountQuota | null => entry(provider).quota
/** 是不是正在读（非 hook；测试和一次性判断用） */
export const quotaLoading = (provider: EngineQuotaProvider): boolean => entry(provider).loading

/**
 * 告诉存储这个 provider 当前通道的账号（引擎检测到的邮箱；检测不到传 null）。
 * 账号变了（含 null 和邮箱之间互换）：丢掉旧账号的数据，让下一次 peek / ensure 重新读主进程。不靠组件的 ref，按钮卸载再挂上也一样
 */
export function noteAccount(provider: EngineQuotaProvider, account: string | null | undefined): void {
  if (account === undefined) return
  const previous = wanted[provider]
  wanted[provider] = account
  const quota = entries[provider]?.quota
  const changed = previous !== undefined && !sameAccount(previous, account)
  if (quota && !belongs(quota, account)) put(provider, { quota: null, asked: false })
  else if (changed) put(provider, { asked: false })
}

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms))

/** 读取（打开弹窗 maxAgeMs 60 秒，右上角刷新 force）；返回是否成功。没有 bridge 返回 false，不会抛错 */
export async function refreshQuota(provider: EngineQuotaProvider, opts: QuotaRefreshOptions = {}): Promise<boolean> {
  if (isDemo) {
    put(provider, { loading: true })
    await sleep(DEMO_REFRESH_MS)
    const now = Date.now()
    const quota = entry(provider).quota
    put(provider, { quota: quota && { ...quota, observedAt: now, fetchedAt: now }, loading: false })
    return true
  }
  const b = bridge()
  if (!b) return false
  listen()
  pending[provider] = (pending[provider] ?? 0) + 1
  put(provider, { loading: true, asked: true })
  try {
    const quota = await b.refresh(provider, opts)
    pending[provider] = (pending[provider] ?? 1) - 1
    // 读的过程中换了账号：回来的是别的账号的数据，不收
    if (!belongs(quota, wanted[provider])) {
      put(provider, { loading: !!pending[provider] })
      return false
    }
    put(provider, { quota, loading: !!pending[provider] })
    return quota.status !== 'error'
  } catch {
    pending[provider] = (pending[provider] ?? 1) - 1
    put(provider, { loading: !!pending[provider] })
    return false
  }
}

/** 只读主进程的缓存，不发请求（模型通道菜单里的简写用） */
export async function peekQuota(provider: EngineQuotaProvider): Promise<void> {
  const b = isDemo ? null : bridge()
  if (!b || entries[provider]?.asked) return
  listen()
  put(provider, { asked: true })
  try {
    const quota = await b.get(provider)
    if (quota && belongs(quota, wanted[provider]) && !entries[provider]?.quota) put(provider, { quota })
  } catch {
    /* 没有缓存就没有简写 */
  }
}

/** 按钮挂上、或账号变了：先拿缓存，没有或超过 10 分钟没主动读过再读一次。account 是当前通道的账号（不传不比对） */
export async function ensureQuota(provider: EngineQuotaProvider, account?: string | null): Promise<void> {
  if (isDemo) return
  const b = bridge()
  if (!b) return
  noteAccount(provider, account)
  await peekQuota(provider)
  const q = entries[provider]?.quota
  if (!q || q.fetchedAt === null || Date.now() - q.fetchedAt > FIRST_SHOW_MAX_AGE_MS)
    await refreshQuota(provider, { maxAgeMs: FIRST_SHOW_MAX_AGE_MS })
}

/** 模型通道菜单里的简写：只读存储，存储空时问一次缓存（不触发读取） */
export function useQuotaSnapshot(provider: EngineQuotaProvider, account?: string | null): AccountQuota | null {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => entry(provider, account),
    () => EMPTY,
  )
  useEffect(() => {
    if (!isDemo) noteAccount(provider, account)
    void peekQuota(provider)
  }, [provider, account])
  return snapshot.quota
}

export interface QuotaSource {
  quota: AccountQuota | null
  /** 正在读取（可能同时有旧数据） */
  loading: boolean
  /** 平台：套餐的每天 / 每周 / 每月额度 */
  planLimits: PlanLimit[]
  /** 读取；返回是否成功。平台只在 force 时去拉账号 */
  refresh(opts?: QuotaRefreshOptions): Promise<boolean>
}

/** 三种账号的额度来源：Claude / ChatGPT 走 bridge，平台走账号模块；accountKey 变了（换了账号）重新读 */
/** provider 为 null（这个通道没有额度）：quota 是 null，什么也不读 */
export function useQuotaSource(provider: QuotaProvider | null, accountKey: string | null): QuotaSource {
  const engine = provider === 'platform' ? null : provider
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (engine ? entry(engine, accountKey) : EMPTY),
    () => EMPTY,
  )
  const account = useAccount()
  const onPlatform = provider === 'platform'
  const platform = useMemo(() => (onPlatform ? platformQuota(account.account) : null), [onPlatform, account.account])
  const planLimits = useMemo(
    () => (onPlatform ? platformPlanLimits(account.account) : []),
    [onPlatform, account.account],
  )
  useEffect(() => {
    if (engine) void ensureQuota(engine, accountKey)
  }, [engine, accountKey])
  const accountRefresh = account.refresh
  const refresh = useCallback(
    async (opts: QuotaRefreshOptions = {}): Promise<boolean> => {
      if (engine) return refreshQuota(engine, opts)
      if (!opts.force) return true
      const result = await accountRefresh()
      return !result.error
    },
    [engine, accountRefresh],
  )
  return {
    quota: engine ? snapshot.quota : platform,
    loading: engine ? snapshot.loading : account.status === 'loading' || account.refreshing,
    planLimits,
    refresh,
  }
}

/** 每分钟更新一次的「现在」：恢复时间到了要把数字改回 0%，「N 分后恢复」要跟着走 */
export function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}
