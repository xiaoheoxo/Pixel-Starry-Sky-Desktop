// 设置云同步的调度（docs/ui/settings-sync.md §4）：登录后 / 启动后 / 窗口重新获得焦点（距上次超过 1 分钟）/
// 每 10 分钟拉取一次；本机改了设置 2 秒后同步一次。多个窗口时只由抢到锁的那一个同步（Web Locks）。
// 同步状态按账号存在 localStorage；演示模式不同步。
import { useSyncExternalStore } from 'react'
import type { AccountState } from '../../../../../shared/types/account'
import { merge, nextState, parseSyncState, type SyncState } from './merge'
import { SYNC_CATEGORIES, SYNC_ENTRIES, STORAGE_KEYS, resetEngineRead, type SyncCategory } from './registry'

export interface SyncPrefs {
  enabled: boolean
  /** 关掉的分类：既不上传也不接收 */
  off: SyncCategory[]
}
export interface SyncStatus {
  account: string | null
  syncing: boolean
  lastSyncAt: number | null
  error: string | null
  /** 第一次同步用云端的覆盖了本机：本机原来的值，用来撤销 */
  restored: Record<string, unknown> | null
}

const PREFS_KEY = 'pixelsky.settings-sync'
const STATE_KEY = 'pixelsky.settings-sync.state.'
const PULL_EVERY = 10 * 60_000
const FOCUS_AFTER = 60_000
const PUSH_DELAY = 2_000

export function parseSyncPrefs(raw: unknown): SyncPrefs {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<SyncPrefs>
  return {
    enabled: v.enabled !== false,
    off: Array.isArray(v.off) ? SYNC_CATEGORIES.filter(c => (v.off as unknown[]).includes(c)) : [],
  }
}

function loadJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

let prefs = parseSyncPrefs(loadJson(PREFS_KEY))
let status: SyncStatus = { account: null, syncing: false, lastSyncAt: null, error: null, restored: null }
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(l => l())
function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch }
  emit()
}

/** 正在把云端的值写回本机：这期间的写入不算本机改动（避免回声） */
let applying = false
let running: Promise<void> | null = null
let again = false
let timer: ReturnType<typeof setTimeout> | null = null
let leader = false

const stateKey = (account: string): string => STATE_KEY + account.toLowerCase()

export async function syncNow(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await syncOnce()
    } while (again)
  })().finally(() => {
    running = null
  })
  return running
}

async function syncOnce(): Promise<void> {
  const bridge = window.pixelsky?.settingsSync
  const account = status.account
  if (!bridge || window.pixelsky?.demo || !prefs.enabled || !account || !leader) return
  setStatus({ syncing: true })
  try {
    resetEngineRead()
    const entries = SYNC_ENTRIES.filter(e => !prefs.off.includes(e.category))
    const keys = entries.map(e => e.key)
    const local: Record<string, unknown> = {}
    for (const e of entries) local[e.key] = await e.read()
    const pulled = await bridge.pull()
    if (pulled.account !== account) return
    const state = parseSyncState(loadJson(stateKey(account)))
    const result = merge({ state, keys, local, cloud: pulled.settings })
    const before: Record<string, unknown> = {}
    applying = true
    try {
      for (const [key, value] of Object.entries(result.apply)) {
        before[key] = local[key] ?? null
        await entries.find(e => e.key === key)!.write(value)
      }
    } finally {
      applying = false
    }
    let cloud = pulled.settings
    if (Object.keys(result.push).length) {
      const pushed = await bridge.push(result.push)
      if (pushed.account !== account) return
      cloud = pushed.settings
    }
    resetEngineRead()
    const after: Record<string, unknown> = {}
    for (const key of Object.keys(result.apply)) after[key] = await entries.find(e => e.key === key)!.read()
    const next: SyncState = nextState(state, keys, local, after, result, cloud)
    localStorage.setItem(stateKey(account), JSON.stringify(next))
    setStatus({ lastSyncAt: Date.now(), error: null, ...(result.restored && { restored: before }) })
  } catch (error) {
    // 断网、服务出错：保留「待上传」（状态没存，下次还会发现本机的改动），不打扰用户
    setStatus({ error: (error as Error).message })
  } finally {
    setStatus({ syncing: false })
  }
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void syncNow()
  }, delay)
}

/** 撤销第一次同步：写回同步前本机的值，再上传（它们比云端的新） */
export async function undoRestore(): Promise<void> {
  const undo = status.restored
  if (!undo) return
  setStatus({ restored: null })
  for (const [key, value] of Object.entries(undo)) await SYNC_ENTRIES.find(e => e.key === key)?.write(value)
  await syncNow()
}

export function dismissRestore(): void {
  setStatus({ restored: null })
}

export function setSyncPrefs(patch: Partial<SyncPrefs>): void {
  prefs = parseSyncPrefs({ ...prefs, ...patch })
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* 本次仍然生效 */
  }
  emit()
  if (prefs.enabled) schedule(0)
}

function watchLocalChanges(): void {
  // 本窗口里的写入：包一层 localStorage 的 setItem / removeItem，只看白名单里的键
  const proto = Storage.prototype
  const set = proto.setItem,
    remove = proto.removeItem
  proto.setItem = function (key: string, value: string) {
    set.call(this, key, value)
    if (this === localStorage && STORAGE_KEYS.has(key) && !applying) schedule(PUSH_DELAY)
  }
  proto.removeItem = function (key: string) {
    remove.call(this, key)
    if (this === localStorage && STORAGE_KEYS.has(key) && !applying) schedule(PUSH_DELAY)
  }
  // 其他窗口里的写入
  window.addEventListener('storage', e => {
    if (e.storageArea === localStorage && e.key && STORAGE_KEYS.has(e.key) && !applying && e.isTrusted)
      schedule(PUSH_DELAY)
    if (e.key === PREFS_KEY) {
      const was = prefs.enabled
      prefs = parseSyncPrefs(loadJson(PREFS_KEY))
      emit()
      // 在别的窗口里开启同步（那边不是负责同步的窗口，schedule 不做事）：由这里马上同步一次
      if (!was && prefs.enabled) schedule(0)
    }
  })
  // 引擎设置在主进程改：收到配置变化就同步
  window.pixelsky?.engine.onEvent(e => {
    if (e.kind === 'engine_config' || e.kind === 'retry_settings') schedule(PUSH_DELAY)
  })
  window.addEventListener('focus', () => {
    if (!status.lastSyncAt || Date.now() - status.lastSyncAt > FOCUS_AFTER) schedule(0)
  })
  setInterval(() => schedule(0), PULL_EVERY)
}

let started = false
/** 每个窗口启动时调用一次；抢到锁的窗口负责同步（设置页的同步状态只在这个窗口里有） */
export function startSettingsSync(): void {
  const bridge = window.pixelsky
  if (started || !bridge || bridge.demo || !bridge.settingsSync) return
  started = true
  const onAccount = (s: AccountState): void => {
    const account = s.status === 'signed-in' ? s.account.email : null
    if (account === status.account) return
    setStatus({ account, error: null, restored: null, lastSyncAt: null })
    if (account) schedule(0)
  }
  void bridge.account.getState().then(onAccount)
  bridge.account.onChange(onAccount)
  const lead = (): void => {
    leader = true
    watchLocalChanges()
    schedule(0)
  }
  if (navigator.locks)
    void navigator.locks.request('pixelsky.settings-sync', () => {
      lead()
      // 一直拿着锁，窗口关掉时浏览器自动释放，下一个窗口接手
      return new Promise<void>(() => {})
    })
  else lead()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, () => status)
}
export function useSyncPrefs(): SyncPrefs {
  return useSyncExternalStore(subscribe, () => prefs)
}
