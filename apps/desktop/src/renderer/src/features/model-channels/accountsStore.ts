// 订阅账号多开（docs/ui/engine-accounts.md、engine-accounts-claude.md）：账号列表、各账号额度、子页面开在哪条通道。
// 真实模式经 bridge 取、听 engine_accounts 推送；演示模式用 demo().accounts，改动只在内存里
import { useEffect, useSyncExternalStore } from 'react'
import {
  DEFAULT_ACCOUNT,
  type AccountAutoSwitch,
  type AccountEngine,
  type AccountPatch,
  type EngineAccount,
  type EngineAccountQuota,
  type EngineAccounts,
  type QuotaWindow,
} from '@pixelsky/protocol'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { bridge } from '@/features/engine/store'
import { useMachines } from '@/features/machines/store'
import type { AuthChannel } from './channelModel'

/** 多账号支持的通道 → 引擎 */
export const ACCOUNT_ENGINE: Partial<Record<AuthChannel, AccountEngine>> = { chatgpt: 'codex', claude: 'claude' }

interface State {
  accounts: Partial<Record<AccountEngine, EngineAccounts>>
  quota: Partial<Record<AccountEngine, EngineAccountQuota[]>>
  /** 子页面「模型通道 › ChatGPT 账号」开着时是哪条通道 */
  page: AuthChannel | null
}

let state: State = { accounts: {}, quota: {}, page: null }
const listeners = new Set<() => void>()
const set = (patch: Partial<State>): void => {
  state = { ...state, ...patch }
  listeners.forEach(fn => fn())
}
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function putAccounts(list: EngineAccounts): void {
  set({ accounts: { ...state.accounts, [list.engine]: list } })
}

let listening = false
function listen(): void {
  if (listening || !bridge) return
  listening = true
  bridge.onEvent(e => {
    if (e.kind === 'engine_accounts') putAccounts(e.accounts)
    // 换了机器、重新检测后邮箱可能变了：取过的列表重新取
    if (e.kind === 'engines')
      for (const engine of Object.keys(state.accounts) as AccountEngine[]) void loadAccounts(engine)
  })
}

export async function loadAccounts(engine: AccountEngine): Promise<void> {
  if (isDemo) {
    if (!state.accounts[engine]) putAccounts(structuredClone(demo().accounts[engine].list))
    return
  }
  if (!bridge) return
  listen()
  try {
    putAccounts(await bridge.accounts(engine))
  } catch {
    // 远程机器上的旧版辅助进程没有这个接口：当作只有一个账号
  }
}

/** 各账号额度：打开账号下拉 / 子菜单 / 子页面时取（主进程缓存 60 秒） */
export async function loadAccountsQuota(engine: AccountEngine, force = false): Promise<void> {
  if (isDemo) {
    set({ quota: { ...state.quota, [engine]: demo().accounts[engine].quota } })
    return
  }
  if (!bridge) return
  try {
    const rows = await bridge.accountsQuota(engine, force)
    set({ quota: { ...state.quota, [engine]: rows } })
  } catch {
    // 读不到额度不影响切换
  }
}

/** 列表（机器切换到远程时为 null：账号只在本机管理） */
export function useAccounts(engine: AccountEngine | undefined): EngineAccounts | null {
  const machine = useMachines().currentId
  const list = useSyncExternalStore(subscribe, () => (engine ? (state.accounts[engine] ?? null) : null))
  useEffect(() => {
    if (engine && machine === 'local') void loadAccounts(engine)
  }, [engine, machine])
  return machine === 'local' ? list : null
}

export function useAccountsQuota(engine: AccountEngine | undefined): EngineAccountQuota[] {
  return useSyncExternalStore(subscribe, () => (engine ? (state.quota[engine] ?? EMPTY) : EMPTY))
}
const EMPTY: EngineAccountQuota[] = []

// ---------- 子页面 ----------

export function openAccountsPage(channel: AuthChannel | null): void {
  set({ page: channel })
}

export function useAccountsPage(): AuthChannel | null {
  return useSyncExternalStore(subscribe, () => state.page)
}

// ---------- 操作：真实模式返回新列表，演示模式改内存 ----------

function demoChange(engine: AccountEngine, fn: (list: EngineAccounts) => void): void {
  const list = structuredClone(state.accounts[engine] ?? demo().accounts[engine].list)
  fn(list)
  putAccounts(list)
}

export async function switchAccount(engine: AccountEngine, id: string): Promise<void> {
  if (isDemo) return demoChange(engine, l => void (l.current = id))
  if (bridge) putAccounts(await bridge.switchAccount(engine, id))
}

export async function removeAccount(engine: AccountEngine, id: string): Promise<void> {
  if (isDemo) return demoChange(engine, l => void (l.accounts = l.accounts.filter(a => a.id !== id)))
  if (bridge) putAccounts(await bridge.removeAccount(engine, id))
}

export async function updateAccount(engine: AccountEngine, id: string, patch: AccountPatch): Promise<void> {
  if (isDemo)
    return demoChange(engine, l => {
      const i = l.accounts.findIndex(a => a.id === id)
      if (i < 0) return
      if (patch.label !== undefined) l.accounts[i].label = patch.label?.trim() || null
      if (patch.move === 'up' && i > 0) l.accounts.splice(i - 1, 2, l.accounts[i], l.accounts[i - 1])
    })
  if (bridge) putAccounts(await bridge.updateAccount(engine, id, patch))
}

export async function setAccountAuto(engine: AccountEngine, patch: Partial<AccountAutoSwitch>): Promise<void> {
  if (isDemo) return demoChange(engine, l => void (l.auto = { ...l.auto, ...patch }))
  if (bridge) putAccounts(await bridge.setAccountAuto(engine, patch))
}

/** 演示模式「添加账号」登录完成：加一个假账号 */
export function demoAddAccount(engine: AccountEngine): void {
  demoChange(engine, l => {
    const n = l.accounts.length + 1
    l.accounts.push({
      id: `a_demo0000000${n}`.slice(0, 14),
      email: `account${n}@example.com`,
      plan: 'plus',
      label: null,
      addedAt: Date.now(),
      status: 'ok',
    })
  })
}

// ---------- 显示 ----------

/** 账号显示名：备注优先，其次邮箱 */
export const accountName = (a: Pick<EngineAccount, 'label' | 'email' | 'id'>): string =>
  a.label || a.email || (a.id === DEFAULT_ACCOUNT ? '—' : a.id)

/** 5 小时 / 本周窗口（按时长挑，没有就按顺序） */
export function quotaWindows(q: EngineAccountQuota | undefined): {
  short: QuotaWindow | null
  week: QuotaWindow | null
} {
  const windows = q?.windows ?? []
  const short = windows.find(w => w.id === 'five_hour') ?? windows.find(w => (w.durationMins ?? 0) <= 24 * 60) ?? null
  const week = windows.find(w => w.id === 'seven_day') ?? windows.find(w => w !== short) ?? null
  return { short, week }
}
