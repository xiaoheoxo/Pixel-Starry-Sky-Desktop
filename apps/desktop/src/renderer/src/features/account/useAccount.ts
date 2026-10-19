import { tr } from '../../i18n/core'
// 账号状态：模块级 store，所有调用方共享同一份（一次 getState + 一个 onChange 订阅）
// 规格见 docs/ui/account.md §4.3
import { useMemo, useSyncExternalStore } from 'react'
import type { AccountInfo, AccountRefreshResult, AccountState, LoginFailure } from '../../../../shared/types/account'
import type { AccountBridge } from '../../../../preload/account'
import { formatBalance } from './format'
import { demo } from '@/data/demo'

export type AccountStatus = 'loading' | 'signed-out' | 'signing-in' | 'signed-in'

export interface AccountUser {
  name: string
  email: string
}

export interface UseAccountResult {
  status: AccountStatus
  account: AccountInfo | null
  user: AccountUser | null
  /** 格式化好的余额（如 "$12.34"）；未登录时为 null */
  balanceText: string | null
  error: string | null
  refreshing: boolean
  /** 登录中：两边核对的授权码（如 2AE5B0-156C42）和授权页地址（回调服务起来后才有） */
  authCode: string | null
  loginUrl: string | null
  /** 上一次登录没成功的原因（未登录时才有；主动取消、从没登录过为 null） */
  failure: LoginFailure | null
  login: () => Promise<void>
  cancelLogin: () => Promise<void>
  logout: () => Promise<void>
  /** 重新拉取账号数据；返回刷新后的账号和失败原因（概览页另外通过 error 显示） */
  refresh: () => Promise<AccountRefreshResult>
}

interface Snapshot {
  status: AccountStatus
  account: AccountInfo | null
  refreshing: boolean
  error: string | null
  authCode?: string
  loginUrl?: string
  failure?: LoginFailure
}

const LOADING: Snapshot = { status: 'loading', account: null, refreshing: false, error: null }
const SIGNED_OUT: Snapshot = { status: 'signed-out', account: null, refreshing: false, error: null }
/** 演示模式的快照：第一次读取时创建，之后保持同一个对象（useSyncExternalStore 要求快照稳定） */
let DEMO: Snapshot | null = null // 账号对象变了才重建

function getBridge(): AccountBridge | null {
  return window.pixelsky?.account ?? null
}

function isDemoMode(): boolean {
  return window.pixelsky?.demo === true
}

function toSnapshot(s: AccountState): Snapshot {
  switch (s.status) {
    case 'signed-out':
      return { status: 'signed-out', account: null, refreshing: false, error: s.error ?? null, failure: s.reason }
    case 'signing-in':
      return {
        status: 'signing-in',
        account: null,
        refreshing: false,
        error: null,
        authCode: s.authCode,
        loginUrl: s.url,
      }
    case 'signed-in':
      return { status: 'signed-in', account: s.account, refreshing: s.refreshing, error: s.error ?? null }
  }
}

// ---- store ----
let snapshot: Snapshot = LOADING
let started = false
let gotPush = false // onChange 已经推送过：此时 getState 的旧结果要丢弃
const listeners = new Set<() => void>()

function setSnapshot(next: Snapshot) {
  snapshot = next
  listeners.forEach(l => l())
}

function errorText(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return msg || fallback
}

function start() {
  if (started) return
  started = true
  const bridge = getBridge()
  if (!bridge) return
  try {
    bridge.onChange(s => {
      gotPush = true
      setSnapshot(toSnapshot(s))
    })
  } catch {
    // 订阅失败时仍然尝试读一次状态
  }
  bridge
    .getState()
    .then(s => {
      if (!gotPush) setSnapshot(toSnapshot(s))
    })
    .catch(e => {
      if (!gotPush) setSnapshot({ ...SIGNED_OUT, error: errorText(e, tr('account.useAccount.couldNotLoadAccount')) })
    })
}

function subscribe(listener: () => void): () => void {
  // 演示模式：软件内付款到账后演示账号会变（mock/checkout.ts）
  if (isDemoMode()) return demo().checkout.subscribe(listener)
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Snapshot {
  if (isDemoMode()) {
    const account = demo().checkout.account()
    if (DEMO?.account !== account) DEMO = { status: 'signed-in', account, refreshing: false, error: null }
    return DEMO as Snapshot
  }
  // 没有桥接（普通浏览器）：直接是未登录，不必等待
  if (!getBridge()) return SIGNED_OUT
  return snapshot
}

/** 把动作里抛出的错误写进状态（已登录时保留账号信息，只挂上错误提示） */
function routeError(e: unknown, fallback: string) {
  const error = errorText(e, fallback)
  if (snapshot.status === 'signed-in') setSnapshot({ ...snapshot, refreshing: false, error })
  else setSnapshot({ ...SIGNED_OUT, error })
}

function makeAction(name: 'login' | 'cancelLogin' | 'logout' | 'refresh', fallback: () => string) {
  return async (): Promise<void> => {
    if (isDemoMode()) return
    const bridge = getBridge()
    if (!bridge) return
    try {
      await bridge[name]()
    } catch (e) {
      routeError(e, fallback())
    }
  }
}

const login = makeAction('login', () => tr('account.useAccount.signInFailedPlease'))
const cancelLogin = makeAction('cancelLogin', () => tr('account.useAccount.couldNotCancelSign'))
const logout = makeAction('logout', () => tr('account.useAccount.couldNotSignOut'))
/** 刷新账号：主进程一定发新请求，返回刷新后的账号数据和失败原因 */
const refresh = async (): Promise<AccountRefreshResult> => {
  if (isDemoMode()) return { error: null, account: getSnapshot().account }
  const bridge = getBridge()
  if (!bridge) return { error: null, account: null }
  try {
    const res = await bridge.refresh()
    // 被拒绝的来源（非应用页面）拿到 undefined：不能当成「刷新成功、没变化」
    if (!res) return { error: tr('account.useAccount.refreshFailedTryAgain'), account: null }
    return { error: res?.error ?? null, account: res?.account ?? null }
  } catch (e) {
    const fallback = tr('account.useAccount.refreshFailedTryAgain')
    routeError(e, fallback)
    return { error: errorText(e, fallback), account: null }
  }
}

/** 账号状态钩子。所有调用方共享同一个 store；操作函数引用稳定、不会抛出 */
export function useAccount(): UseAccountResult {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return useMemo<UseAccountResult>(() => {
    const account = snap.account
    return {
      status: snap.status,
      account,
      user: account ? { name: account.name || account.email.split('@')[0], email: account.email } : null,
      balanceText: account ? formatBalance(account.balance, account.currency) : null,
      error: snap.error,
      refreshing: snap.refreshing,
      authCode: snap.authCode ?? null,
      loginUrl: snap.loginUrl ?? null,
      failure: snap.failure ?? (snap.status === 'signed-out' && snap.error ? 'failed' : null),
      login,
      cancelLogin,
      logout,
      refresh,
    }
  }, [snap])
}
