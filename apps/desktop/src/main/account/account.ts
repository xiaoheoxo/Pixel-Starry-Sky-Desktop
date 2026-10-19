// 账号登录与额度（主进程）。规格见 docs/ui/account.md §1、§4.1、§4.2
//
// 浏览器授权 + PKCE：主进程在 127.0.0.1 起一次性回调服务，用系统浏览器打开授权页，
// 拿到 code 后换令牌；令牌只留在主进程（落盘时用 safeStorage 加密），渲染进程只能通过 IPC 看到 AccountState。
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, release } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, net, safeStorage, shell } from 'electron'
import { codedError } from '@pixelsky/protocol'
import { nativeText, windowLocale } from '../app/ui-language'
import { isPayWindow } from '../app/payWindowRegistry'
import { sendTo } from '../app/rendererHealth'
import * as ipc from '../ipc/guard'
import type {
  AccountInfo,
  AccountPlan,
  AccountRefreshResult,
  AccountState,
  LoginFailure,
  Quota,
} from '../../shared/types/account'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// 正式站（2026-10-17 起，docs/cloud-prod-migration.md）；测试站 https://auth.pixelstarrysky.xyz 用 PIXELSKY_AUTH_URL 指过去
const DEFAULT_AUTH_URL = 'https://pixelstarrysky.xyz'
const CLIENT_ID = 'pixelsky-desktop'
const FETCH_TIMEOUT_MS = 20_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
/** 访问令牌距过期不足这么久就先刷新 */
const REFRESH_SKEW_MS = 60_000
/** 窗口获得焦点时，距上次拉取不足这么久就不再拉 */
const FOCUS_MIN_INTERVAL_MS = 60_000
const POLL_INTERVAL_MS = 5 * 60_000
const STORE_VERSION = 1

// ---------------------------------------------------------------------------
// 内部类型与错误
// ---------------------------------------------------------------------------

interface Tokens {
  accessToken: string
  refreshToken: string
  /** 访问令牌过期时间（毫秒时间戳） */
  accessExpiresAt: number
}

/** 刷新令牌被服务端拒绝（或访问令牌换新后仍 401）：只能重新登录 */
class AuthExpiredError extends Error {}
/** 登录过期和被管理员吊销在客户端看来一样：刷新令牌被拒 */
const SIGNED_OUT_MESSAGE = '登录已失效（已过期或被吊销），请重新登录'
/** 网络错误、超时、5xx 等暂时性故障：保持登录，只提示 */
class TransientError extends Error {}

interface HttpResult {
  status: number
  body: unknown
}

// 大写无歧义字母 + 数字（去掉 I、O、L、1 防止看错），分成 6-6 两段，好读好输
const AUTH_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function readableAuthCode(): string {
  const bytes = randomBytes(12)
  const pick = (n: number): string => AUTH_CODE_ALPHABET[bytes[n] % AUTH_CODE_ALPHABET.length]
  return `${[...Array(6)].map((_, i) => pick(i)).join('')}-${[...Array(6)].map((_, i) => pick(6 + i)).join('')}`
}

interface LoginFlow {
  server: Server
  timer: NodeJS.Timeout
  /** 已经收到过回调（只处理一次） */
  done: boolean
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let tokens: Tokens | null = null
let account: AccountInfo | null = null
let state: AccountState = { status: 'signed-out' }
/** 每次清空/重置会话就加一，让还在途中的请求结果作废 */
let epoch = 0
let lastFetchAt = 0
let flow: LoginFlow | null = null
let refreshPromise: Promise<void> | null = null
let fetchPromise: Promise<void> | null = null
/** 手动刷新排在当前请求之后的那一次（等待期间的多次手动刷新共用它） */
let followUpPromise: Promise<void> | null = null
let initialized = false
/** 令牌已换到、正在拉取账号数据（此时 flow 已为 null，但状态仍是 signing-in） */
let finishing = false

/** 主进程里跟着登录状态变的模块（手机中转，main/mobile/） */
const stateListeners = new Set<(state: AccountState) => void>()
export function onAccountChange(listener: (state: AccountState) => void): () => void {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

function setState(next: AccountState): void {
  state = next
  for (const listener of stateListeners) listener(next)
  for (const win of BrowserWindow.getAllWindows()) {
    // 付款窗口里是第三方收银台网页，不给它软件的账号状态
    if (!win.isDestroyed() && !isPayWindow(win)) sendTo(win.webContents, 'account:changed', state)
  }
}

/** 覆盖地址只在开发环境（未打包）或 https / 本机回环地址时生效，避免令牌被环境变量带到明文的陌生主机 */
function overrideAllowed(raw: string): boolean {
  if (!app.isPackaged) return true
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:') return true
    return (
      u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
    )
  } catch {
    return false
  }
}

/** 授权时报给云端的设备名（管理页的登录会话、托管 Key 的名字里显示），如「DESKTOP-01 · Windows 11」 */
export function deviceName(): string {
  const build = Number(release().split('.')[2])
  const os =
    process.platform === 'win32'
      ? build >= 22000
        ? 'Windows 11'
        : 'Windows 10'
      : process.platform === 'darwin'
        ? 'macOS'
        : process.platform === 'linux'
          ? 'Linux'
          : process.platform
  const host = hostname().trim()
  return host ? `${host} · ${os}` : os
}

/** 认证服务地址（「关于」页也显示它） */
export function baseUrl(): string {
  const raw = (process.env.PIXELSKY_AUTH_URL ?? '').trim().replace(/\/+$/, '')
  return raw && overrideAllowed(raw) ? raw : DEFAULT_AUTH_URL
}

/** 能否安全加密落盘：Linux 上没有密钥环时 Electron 会退回固定密钥的 basic_text，等同明文 */
function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
    const backend = safeStorage.getSelectedStorageBackend()
    if (backend === 'basic_text' || backend === 'unknown') return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 令牌持久化：userData/account.json，safeStorage 加密；不能加密时只留内存
// ---------------------------------------------------------------------------

function storeFile(): string {
  return join(app.getPath('userData'), 'account.json')
}

function persist(): void {
  if (!tokens) return
  if (!canEncrypt()) return // 绝不写明文
  try {
    const payload = JSON.stringify({ tokens, account })
    const data = safeStorage.encryptString(payload).toString('base64')
    const file = storeFile()
    mkdirSync(join(file, '..'), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, data }), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // 落盘失败不影响本次运行，下次启动需要重新登录
  }
}

function removeStoreFile(): void {
  try {
    rmSync(storeFile(), { force: true })
  } catch {
    /* 忽略 */
  }
}

function loadPersisted(): void {
  const file = storeFile()
  if (!existsSync(file) || !canEncrypt()) return
  try {
    const wrapper = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; data?: string }
    if (wrapper.version !== STORE_VERSION || typeof wrapper.data !== 'string') throw new Error('版本不符')
    const payload = JSON.parse(safeStorage.decryptString(Buffer.from(wrapper.data, 'base64'))) as {
      tokens?: Partial<Tokens>
      account?: AccountInfo | null
    }
    const t = payload.tokens
    if (!t || typeof t.accessToken !== 'string' || typeof t.refreshToken !== 'string' || !t.refreshToken) {
      throw new Error('令牌缺失')
    }
    tokens = {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      accessExpiresAt: typeof t.accessExpiresAt === 'number' ? t.accessExpiresAt : 0,
    }
    const a = payload.account
    account = a && typeof a.email === 'string' ? a : null
  } catch {
    // 文件损坏、换了系统用户导致解密失败等：当作没登录，并清掉坏文件
    tokens = null
    account = null
    removeStoreFile()
  }
}

/** 清空会话（令牌、账号数据、本地文件），状态变成未登录 */
function resetInFlight(): void {
  epoch++
  refreshPromise = null
  fetchPromise = null
  followUpPromise = null
}

function clearSession(error?: string): void {
  resetInFlight()
  tokens = null
  account = null
  removeStoreFile()
  setState(error ? { status: 'signed-out', error } : { status: 'signed-out' })
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function describeError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return '请求超时'
    const code = (e.cause as { code?: unknown } | undefined)?.code
    if (typeof code === 'string' && code) return code
    return e.message
  }
  return '未知错误'
}

async function http(
  method: 'GET' | 'POST',
  path: string,
  opts: { token?: string; body?: Record<string, unknown> } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.body) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(baseUrl() + path, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (e) {
    throw new TransientError(`网络错误：${describeError(e)}`)
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* 响应体不是 JSON 就当没有 */
  }
  return { status: res.status, body }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function errorText(body: unknown): string {
  if (!isObject(body)) return ''
  const d = body.error_description
  if (typeof d === 'string' && d) return d
  const e = body.error
  return typeof e === 'string' ? e : ''
}

/** 非成功状态码 → 暂时性错误的提示文字 */
function statusMessage(res: HttpResult): string {
  if (res.status >= 500) return '服务暂时不可用'
  const text = errorText(res.body)
  return `请求失败（HTTP ${res.status}${text ? `：${text}` : ''}）`
}

/** 解析令牌接口的成功响应；字段不对就当服务异常 */
function parseTokenResponse(body: unknown, previousRefresh?: string): Tokens {
  if (!isObject(body) || typeof body.access_token !== 'string' || !body.access_token) {
    throw new TransientError('服务返回的令牌数据异常')
  }
  const refreshToken =
    typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : previousRefresh
  if (!refreshToken) throw new TransientError('服务返回的令牌数据异常')
  const ttl = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
  return { accessToken: body.access_token, refreshToken, accessExpiresAt: Date.now() + ttl * 1000 }
}

// ---------------------------------------------------------------------------
// 令牌刷新（单飞：刷新令牌会轮换，并发调用必须共用同一次请求）
// ---------------------------------------------------------------------------

function refreshTokens(): Promise<void> {
  if (refreshPromise) return refreshPromise
  const p = doRefresh().finally(() => {
    if (refreshPromise === p) refreshPromise = null
  })
  refreshPromise = p
  return p
}

async function doRefresh(): Promise<void> {
  const current = tokens
  if (!current) throw new AuthExpiredError()
  const myEpoch = epoch
  const res = await http('POST', '/v1/oauth/token', {
    body: {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: current.refreshToken,
      client_version: app.getVersion(),
    },
  })
  if (myEpoch !== epoch) {
    // 期间已退出或重新登录，丢弃结果；服务端已轮换出新令牌，没人持有它，要撤销掉
    if (res.status === 200) {
      try {
        void revokeBestEffort(parseTokenResponse(res.body, current.refreshToken).refreshToken)
      } catch {
        /* 响应异常就算了 */
      }
    }
    return
  }
  if (res.status === 200) {
    tokens = parseTokenResponse(res.body, current.refreshToken)
    persist()
    return
  }
  // 400/401/403：刷新令牌无效或已被轮换，只能重新登录；其余（5xx、429 等）当暂时故障
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new AuthExpiredError()
  throw new TransientError(statusMessage(res))
}

/** 带访问令牌的 GET：临期先刷新，遇 401 刷新后重试一次 */
async function authedGet(path: string): Promise<HttpResult> {
  if (!tokens) throw new AuthExpiredError()
  if (tokens.accessExpiresAt - Date.now() < REFRESH_SKEW_MS) await refreshTokens()
  let used = tokens
  if (!used) throw new AuthExpiredError()
  let res = await http('GET', path, { token: used.accessToken })
  if (res.status === 401) {
    // 如果别的请求已经换过令牌，直接用新的重试，不再重复刷新
    if (tokens && tokens.accessToken === used.accessToken) await refreshTokens()
    used = tokens
    if (!used) throw new AuthExpiredError()
    res = await http('GET', path, { token: used.accessToken })
    if (res.status === 401) throw new AuthExpiredError()
  }
  return res
}

/** 平台网络请求只在主进程内使用令牌，不把凭据发给渲染层或引擎。 */
export async function platformFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (
    !path.startsWith('/v1/platform/') &&
    !path.startsWith('/v1/oauth/usage/calls?') &&
    !path.startsWith('/v1/oauth/usage/summary?')
  )
    throw new Error('无效的平台接口')
  return authedFetch(path, init)
}

/** 设置云同步（docs/ui/settings-sync.md §5.1）：只能读写 /v1/oauth/settings，不放宽 platformFetch 的白名单 */
export async function settingsFetch(method: 'GET' | 'PUT', body?: unknown): Promise<Response> {
  return authedFetch('/v1/oauth/settings', {
    method,
    ...(method === 'PUT' && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    signal: AbortSignal.timeout(20_000),
  })
}

/** 带登录令牌的请求：快过期先刷新，401 刷新后重试一次，刷新被拒就退出登录 */
async function authedFetch(path: string, init: RequestInit): Promise<Response> {
  if (!tokens) throw new Error('请先登录像素星空账号')
  const requestEpoch = epoch
  // 请求途中账号退出或切换：和登录过期同一个 code，调用方按「需要重新登录」处理
  const loggedOut = (): Error => Object.assign(new Error('账号已退出，请重新登录'), { code: 'AUTH_EXPIRED' })
  // 刷新令牌被拒（登录过期，或在云端管理页被吊销）：马上退出登录，不等下一次拉取账号数据
  const signedOut = (): Error => {
    if (epoch === requestEpoch) clearSession(SIGNED_OUT_MESSAGE)
    return Object.assign(new Error(SIGNED_OUT_MESSAGE), { code: 'AUTH_EXPIRED' })
  }
  const refresh = async (): Promise<void> => {
    try {
      await refreshTokens()
    } catch (e) {
      throw e instanceof AuthExpiredError ? signedOut() : e
    }
  }
  if (tokens.accessExpiresAt - Date.now() < REFRESH_SKEW_MS) await refresh()
  const send = async (): Promise<Response> => {
    if (!tokens || epoch !== requestEpoch) throw loggedOut()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${tokens.accessToken}`)
    return fetch(`${baseUrl()}${path}`, { ...init, headers, redirect: 'error' })
  }
  const used = tokens?.accessToken
  let res = await send()
  if (res.status === 401) {
    await res.body?.cancel()
    if (tokens?.accessToken === used) await refresh()
    res = await send()
    if (res.status === 401) {
      await res.body?.cancel()
      throw signedOut()
    }
  }
  if (epoch !== requestEpoch) {
    await res.body?.cancel()
    throw loggedOut()
  }
  return res
}

/** 手机中转（docs/mobile-remote.md §6）：只能调 /v1/bridge/ 下的接口，不放宽 platformFetch 的白名单 */
export async function bridgeFetch(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
  if (!path.startsWith('/v1/bridge/')) throw new Error('无效的中转接口')
  return authedFetch(path, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    signal: AbortSignal.timeout(20_000),
  })
}

/** 设置 › 反馈（docs/ui/feedback.md §5）：只能调 /v1/feedback 下的接口，不放宽其他白名单 */
export async function feedbackFetch(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 20_000,
): Promise<Response> {
  if (!/^\/v1\/feedback(\/|\?|$)/.test(path)) throw new Error('无效的反馈接口')
  return authedFetch(path, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/** 协作频道 Phase C（docs/ui/channels-phase-c.md §8.1）：只能调 /v1/teams、/v1/invites 下的接口 */
export async function teamsFetch(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 20_000,
): Promise<Response> {
  if (!/^\/v1\/(teams|invites)(\/|\?|$)/.test(path) || /\.\.|%2e/i.test(path)) throw new Error('无效的团队接口')
  return authedFetch(path, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/**
 * 扩展商店的作者接口（docs/ui/extension-store-client.md §7）：只能调 /v1/extensions 下的接口，不放宽其他白名单。
 * body 发 JSON；raw 发原始字节（上传 zip），contentType 写在请求头里。
 */
export async function extensionsFetch(
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; raw?: Uint8Array; contentType?: string; timeoutMs?: number } = {},
): Promise<Response> {
  if (!/^\/v1\/extensions(\/|\?|$)/.test(path) || /\.\.|%2e/i.test(path)) throw new Error('无效的扩展接口')
  const headers: Record<string, string> = {}
  let body: RequestInit['body']
  if (opts.raw !== undefined) {
    body = opts.raw as RequestInit['body']
    headers['Content-Type'] = opts.contentType ?? 'application/octet-stream'
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers['Content-Type'] = 'application/json'
  }
  try {
    return await authedFetch(path, {
      method,
      ...(body !== undefined && { body, headers }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    })
  } catch (e) {
    // 只有「连不上」（fetch 抛 TypeError）才判断是不是代理造成的；超时、登录过期、取消原样抛
    if (e instanceof TypeError && (await publicReachable())) throw codedError('extstore.proxyHint')
    throw e
  }
}

/**
 * 带登录的请求用全局 fetch（不走系统代理），公开请求用 net.fetch（走系统代理）。
 * 前者连不上时试一次公开接口：能通就说明是代理环境造成的（docs/ui/extension-store-client.md §3.2）。
 */
async function publicReachable(): Promise<boolean> {
  try {
    const res = await net.fetch(`${baseUrl()}/cloud/api/extensions?limit=1`, {
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    })
    await res.body?.cancel().catch(() => undefined)
    return res.ok
  } catch {
    return false
  }
}

/**
 * 连中转用的访问令牌（WebSocket 不能走 authedFetch）：快过期或中转说令牌失效（force）时先刷新。
 * 没登录、刷新被拒（同时退出登录）时返回 null。
 */
export async function bridgeToken(force = false): Promise<string | null> {
  const used = tokens?.accessToken
  if (!tokens || !used) return null
  if (force || tokens.accessExpiresAt - Date.now() < REFRESH_SKEW_MS) {
    try {
      if (tokens?.accessToken === used) await refreshTokens()
    } catch (e) {
      if (e instanceof AuthExpiredError) clearSession(SIGNED_OUT_MESSAGE)
      return null
    }
  }
  return tokens?.accessToken ?? null
}

export function signedInEmail(): string | null {
  return state.status === 'signed-in' ? state.account.email : null
}

/** 登录会话代数：每次退出 / 重新登录都会变；软件内付款据此丢掉上一次登录里记下的订单 */
export function accountEpoch(): number {
  return epoch
}

// ---------------------------------------------------------------------------
// 账号数据映射（蛇形 → AccountInfo，逐字段防御）
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function quota(v: unknown): Quota | null {
  if (!isObject(v)) return null
  const used = num(v.used)
  const limit = num(v.limit) // 缺省或 null 表示不限，即 0
  if (used === null && limit === null) return null
  return { used: used ?? 0, limit: limit ?? 0 }
}

function nameFromEmail(email: string): string {
  const i = email.indexOf('@')
  return i > 0 ? email.slice(0, i) : email
}

function mapAccount(body: unknown): AccountInfo {
  if (!isObject(body) || typeof body.email !== 'string' || !body.email) {
    throw new TransientError('服务返回的账号数据异常')
  }
  const email = body.email
  let group: AccountInfo['group'] = null
  if (isObject(body.group) && typeof body.group.name === 'string' && body.group.name) {
    group = { name: body.group.name, billingSource: str(body.group.billing_source) }
  }
  let plan: AccountPlan | null = null
  if (isObject(body.plan) && typeof body.plan.name === 'string' && body.plan.name) {
    const p = body.plan
    plan = {
      name: p.name as string,
      expiresAt: typeof p.expires_at === 'string' && p.expires_at ? p.expires_at : null,
      daily: quota(p.daily),
      weekly: quota(p.weekly),
      monthly: quota(p.monthly),
    }
  }
  const rateLimits: AccountInfo['rateLimits'] = []
  if (Array.isArray(body.rate_limits)) {
    for (const r of body.rate_limits) {
      if (!isObject(r) || typeof r.window !== 'string') continue
      const used = num(r.used)
      const limit = num(r.limit)
      if (used === null || limit === null) continue
      rateLimits.push({ window: r.window, used, limit })
    }
  }
  const name = str(body.name).trim() || str(body.username).trim() || nameFromEmail(email)
  return {
    email,
    name,
    balance: num(body.balance),
    currency: str(body.currency) || 'USD',
    group,
    plan,
    rateLimits,
    updatedAt: Date.now(),
  }
}

/** 旧版适配层没有 /v1/oauth/account：用 userinfo（balance 是字符串）凑出基础信息 */
function mapUserInfo(body: unknown): AccountInfo {
  if (!isObject(body) || typeof body.email !== 'string' || !body.email) {
    throw new TransientError('服务返回的账号数据异常')
  }
  return {
    email: body.email,
    name: nameFromEmail(body.email),
    balance: num(body.balance),
    currency: str(body.currency) || 'USD',
    group: null,
    plan: null,
    rateLimits: [],
    updatedAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// 拉取账号与额度（单飞）
// ---------------------------------------------------------------------------

function fetchAccount(): Promise<void> {
  if (fetchPromise) return fetchPromise
  const p = doFetchAccount().finally(() => {
    if (fetchPromise === p) fetchPromise = null
  })
  fetchPromise = p
  return p
}

/**
 * 手动刷新：一定发一次点击之后才开始的新请求。
 * 已有请求在途（焦点 / 定时刷新）时，它的数据可能是点击之前读的，所以等它结束再发一次；
 * 等待期间的多次手动刷新共用这一次后续请求。
 */
function fetchAccountFresh(): Promise<void> {
  if (!fetchPromise) return fetchAccount()
  if (followUpPromise) return followUpPromise
  const p: Promise<void> = fetchPromise
    .catch(() => undefined)
    .then(() => {
      // 后续请求开始发的这一刻起，新的手动刷新要排到再下一次
      if (followUpPromise === p) followUpPromise = null
      return fetchAccount()
    })
  followUpPromise = p
  return p
}

/** 刷新结束后的结果：失败原因取自账号状态（暂时性故障保留旧数据并挂 error，登录失效则变成未登录） */
function refreshResult(): AccountRefreshResult {
  if (state.status === 'signed-in') return { error: state.error ?? null, account: state.account }
  if (state.status === 'signed-out') return { error: state.error ?? '请先登录像素星空账号', account: null }
  return { error: null, account: null }
}

async function doFetchAccount(): Promise<void> {
  if (!tokens) return
  const myEpoch = epoch
  lastFetchAt = Date.now()
  if (state.status === 'signed-in') setState({ ...state, refreshing: true })
  try {
    let res = await authedGet('/v1/oauth/account')
    let legacy = false
    if (res.status === 404) {
      res = await authedGet('/v1/oauth/userinfo')
      legacy = true
    }
    if (res.status !== 200) throw new TransientError(statusMessage(res))
    const info = legacy ? mapUserInfo(res.body) : mapAccount(res.body)
    if (myEpoch !== epoch) return
    account = info
    persist()
    // 登录流程中途（signing-in）不抢状态，由 login 收尾；其余情况直接变成已登录
    if (state.status !== 'signing-in') setState({ status: 'signed-in', account: info, refreshing: false })
  } catch (e) {
    if (myEpoch !== epoch) return
    if (e instanceof AuthExpiredError) {
      if (flow) {
        // 用户正在开始新的登录：只丢掉旧令牌，不动界面状态，也不打断登录流程
        tokens = null
        account = null
        removeStoreFile()
        return
      }
      clearSession(SIGNED_OUT_MESSAGE)
      return
    }
    const message = e instanceof TransientError ? e.message : `网络错误：${describeError(e)}`
    // 暂时性故障：不退出登录；有旧数据就继续显示并带上提示
    if (account && state.status !== 'signing-in') {
      setState({ status: 'signed-in', account, refreshing: false, error: message })
    } else if (state.status === 'signed-out') {
      // 启动时有令牌但没有缓存的账号数据：保留令牌，等下次重试
      setState({ status: 'signed-out', error: message })
    }
    if (state.status === 'signing-in') throw e
  }
}

// ---------------------------------------------------------------------------
// 登录流程
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

type ResultKind = 'ok' | 'cancelled' | 'failed'

// 回调结果页的样式与授权页（适配层 page.go 的 pageCSS）保持一致：暖灰 + 墨绿，跟随系统深浅色
const RESULT_CSS =
  ':root{color-scheme:light dark;--bg:#f8f8f6;--fg:#20211f;--muted:#777872;--accent:#2d6151;--accent-soft:#e1eae5;--danger:#b8463f;--danger-soft:#f7e4e2;--soft:rgba(32,33,31,.05)}' +
  '@media(prefers-color-scheme:dark){:root{--bg:#1f1f1e;--fg:#ecebe7;--muted:#9c9a92;--accent:#7fc4a8;--accent-soft:#1e3a30;--danger:#f0857d;--danger-soft:#3a2220;--soft:rgba(250,249,245,.06)}}' +
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);' +
  'font:14px/1.6 "Inter","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}' +
  'main{max-width:380px;padding:32px 24px;text-align:center}' +
  '.icon{width:56px;height:56px;border-radius:9999px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px}' +
  '.ok{background:var(--accent-soft);color:var(--accent)}.failed{background:var(--danger-soft);color:var(--danger)}.cancelled{background:var(--soft);color:var(--muted)}' +
  'h1{font-size:20px;font-weight:600;margin:0 0 8px}p{margin:0;color:var(--muted)}'

const RESULT_ICON: Record<ResultKind, string> = {
  ok: '<path d="M20 6 9 17l-5-5"/>',
  cancelled: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  failed: '<path d="M12 8v5"/><path d="M12 16.5h.01"/>',
}

function resultPage(kind: ResultKind, reason?: string): string {
  const title = nativeText(null, { ok: '登录成功', cancelled: '已取消授权', failed: '登录失败' }[kind])
  const text = nativeText(
    null,
    {
      ok: '已回到 Pixel Starry Sky，可以关闭此页面。',
      cancelled: '没有登录任何账号。需要时可以回到 Pixel Starry Sky 重新登录。',
      failed: `${reason ?? '未知原因'}。请回到 Pixel Starry Sky 重试。`,
    }[kind],
  )
  return (
    `<!doctype html><html lang="${windowLocale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title} · Pixel Starry Sky</title><style>${RESULT_CSS}</style></head><body><main>` +
    `<span class="icon ${kind}"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${RESULT_ICON[kind]}</svg></span>` +
    `<h1>${title}</h1><p>${escapeHtml(text)}</p></main></body></html>`
  )
}

function closeFlow(f: LoginFlow): void {
  clearTimeout(f.timer)
  f.server.close()
  // 浏览器的 keep-alive 连接会让 close 迟迟不完成，延后强制断开，给响应留出发送时间
  const t = setTimeout(() => f.server.closeAllConnections(), 1000)
  t.unref()
  f.server.closeIdleConnections()
}

/** 登录失败收尾：只有当前流程仍是它自己时才改状态 */
function failLogin(f: LoginFlow, reason?: string, kind: LoginFailure = 'failed'): void {
  if (flow !== f) return
  flow = null
  closeFlow(f)
  // 没有原因 = 用户自己在授权页点了「取消」，回到未登录即可，不算出错（欢迎页按 denied 提示一句）
  setState(reason ? { status: 'signed-out', error: reason, reason: kind } : { status: 'signed-out', reason: 'denied' })
}

async function completeLogin(f: LoginFlow, code: string, verifier: string, redirectUri: string): Promise<void> {
  try {
    const res = await http('POST', '/v1/oauth/token', {
      body: {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_version: app.getVersion(),
      },
    })
    if (flow !== f) {
      // 换令牌期间被取消或重启：服务端已签发的令牌没人持有，撤销掉
      if (res.status === 200) {
        try {
          void revokeBestEffort(parseTokenResponse(res.body).refreshToken)
        } catch {
          /* 响应异常就算了 */
        }
      }
      return
    }
    if (res.status !== 200) {
      failLogin(
        f,
        res.status >= 500 ? '登录失败：服务暂时不可用' : `登录失败：${errorText(res.body) || `HTTP ${res.status}`}`,
      )
      return
    }
    resetInFlight() // 作废启动时可能还在途中的旧拉取，下面一定要发起新的
    tokens = parseTokenResponse(res.body)
    account = null
    flow = null // 之后的拉取失败走 fetchAccount 自己的收尾
    finishing = true
    const myEpoch = epoch // 期间被取消 / 退出 / 重新登录会让 epoch 变化
    persist()
    // 先拉一次账号数据：拿到才算登录成功，否则撤销刚签发的令牌并报失败
    try {
      await fetchAccount()
    } catch (e) {
      if (myEpoch !== epoch) return
      const message = e instanceof TransientError ? e.message : `网络错误：${describeError(e)}`
      void revokeBestEffort(tokens?.refreshToken)
      finishing = false
      clearSession(`登录失败：${message}`)
      return
    }
    if (myEpoch !== epoch) return
    finishing = false
    if (!tokens) return // 拉取过程中令牌被判定过期，clearSession 已设好状态
    if (account) setState({ status: 'signed-in', account, refreshing: false })
  } catch (e) {
    const message = e instanceof TransientError ? e.message : `网络错误：${describeError(e)}`
    failLogin(f, `登录失败：${message}`, 'network')
  }
}

/**
 * 开始登录。同一时间只有一个流程：状态已是 signing-in 时再次调用会静默关掉旧的回调服务并重新开始
 * （用户关掉了浏览器标签想重来）；已登录时不做任何事（要换号先退出登录）。
 * 返回时浏览器已打开（状态 signing-in），后续的回调、换令牌在后台继续。
 */
async function login(): Promise<void> {
  if (state.status === 'signed-in') return
  if (finishing) cancelLogin() // 上一次登录正在收尾：先取消干净再重来
  if (flow) {
    const old = flow
    flow = null
    closeFlow(old)
  }

  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const expectedState = base64url(randomBytes(16))
  // 易读授权码（如 2AE5B0-156C42）：授权页也会显示，用户两边比对一致才授权，防止被冒充。
  // 只用于对照展示，不是安全凭据（安全凭据是 PKCE 的 code_verifier）。
  const authCode = readableAuthCode()

  const server = createServer()
  const f: LoginFlow = {
    server,
    done: false,
    timer: setTimeout(() => failLogin(f, '登录超时，请重试', 'timeout'), LOGIN_TIMEOUT_MS),
  }
  flow = f
  setState({ status: 'signing-in', authCode })

  let redirectUri = ''
  const handleCallback = (method: string | undefined, target: string | undefined, res: ServerResponse): void => {
    const url = new URL(target ?? '/', 'http://127.0.0.1')
    if (method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found')
      return
    }
    if (f.done || flow !== f) {
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Gone')
      return
    }
    const respond = (kind: ResultKind, reason?: string): void => {
      res
        .writeHead(kind === 'failed' ? 400 : 200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'close',
        })
        .end(resultPage(kind, reason))
    }
    // state 不对的请求不是我们发出的授权的回调（别的页面或进程乱撞）：回 400，但不能因此中断真正的登录
    if (url.searchParams.get('state') !== expectedState) {
      respond('failed', '状态校验不通过')
      return
    }
    f.done = true
    const err = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (err === 'access_denied') {
      // 授权页上点了「取消」
      respond('cancelled')
      failLogin(f)
    } else if (err) {
      const desc = url.searchParams.get('error_description') || err
      respond('failed', desc)
      failLogin(f, `登录失败：${desc}`)
    } else if (!code) {
      respond('failed', '回调缺少授权码')
      failLogin(f, '登录失败：回调缺少授权码')
    } else {
      respond('ok')
      clearTimeout(f.timer)
      closeFlow(f)
      void completeLogin(f, code, verifier, redirectUri)
    }
  }

  server.on('request', (req, res) => {
    // 请求目标可能是畸形的（如 "//"），URL 解析会抛错；任何异常都只回 400，不能冒泡到主进程
    try {
      handleCallback(req.method, req.url, res)
    } catch {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Bad Request')
    }
  })
  server.on('clientError', (_err, socket) => {
    socket.destroy()
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
  } catch (e) {
    failLogin(f, `登录失败：无法启动本地回调服务（${describeError(e)}）`)
    return
  }
  if (flow !== f) return // 等待期间被取消或重启
  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    failLogin(f, '登录失败：无法启动本地回调服务')
    return
  }
  redirectUri = `http://127.0.0.1:${addr.port}/callback`

  const authorize = new URL(baseUrl() + '/cli/oauth')
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: expectedState,
    auth_code: authCode,
    device_name: deviceName(),
  }).toString()
  // 授权页地址给界面（浏览器没自动打开时「复制登录链接」）；只发给本机窗口，不写日志
  setState({ status: 'signing-in', authCode, url: authorize.toString() })

  if (process.env.PIXELSKY_AUTH_NO_BROWSER === '1') {
    // 自动化测试用：不开浏览器，把授权地址打印出来由测试脚本去访问。
    // 直接写 stdout，不经过 console：console 会同时写进日志文件，授权地址带 PKCE 参数
    process.stdout.write(`[account] authorize URL: ${authorize.toString()}\n`)
  } else {
    try {
      await shell.openExternal(authorize.toString())
    } catch (e) {
      failLogin(f, `登录失败：无法打开浏览器（${describeError(e)}）`)
    }
  }
}

function cancelLogin(): void {
  const f = flow
  if (!f) {
    // 令牌已换到、正在拉取账号数据：取消就是撤销刚签发的令牌并清空会话
    if (finishing) {
      finishing = false
      void revokeBestEffort(tokens?.refreshToken)
      clearSession()
    }
    return
  }
  flow = null
  closeFlow(f)
  if (state.status === 'signing-in') setState({ status: 'signed-out' })
}

// ---------------------------------------------------------------------------
// 退出登录
// ---------------------------------------------------------------------------

async function revokeBestEffort(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return
  try {
    await http('POST', '/v1/oauth/revoke', { body: { refresh_token: refreshToken } })
  } catch {
    /* 撤销失败也继续退出 */
  }
}

async function logout(): Promise<void> {
  cancelLogin()
  const rt = tokens?.refreshToken
  // 先清本地（界面立刻变成未登录），再尽力通知服务端撤销
  clearSession()
  await revokeBestEffort(rt)
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

/** 在 app ready 之后调用一次：注册 IPC、读取已保存的令牌、启动定时与焦点刷新 */
export function initAccount(): void {
  if (initialized) return
  initialized = true

  // 只响应应用自己的页面；其他来源一律当作未登录 / 忽略
  const ignore = { onUntrusted: () => undefined }
  ipc.handle('account:get', (): AccountState => state, { onUntrusted: (): AccountState => ({ status: 'signed-out' }) })
  ipc.handle(
    'account:login',
    async () => {
      try {
        await login()
      } catch (e) {
        // 不把异常抛给渲染进程，统一变成状态里的错误
        if (flow) {
          closeFlow(flow)
          flow = null
        }
        setState({ status: 'signed-out', error: `登录失败：${describeError(e)}` })
      }
    },
    ignore,
  )
  ipc.handle(
    'account:cancel',
    () => {
      cancelLogin()
    },
    ignore,
  )
  ipc.handle(
    'account:logout',
    async () => {
      await logout()
    },
    ignore,
  )
  ipc.handle(
    'account:refresh',
    async (): Promise<AccountRefreshResult> => {
      if (!tokens) return { error: '请先登录像素星空账号', account: null }
      await fetchAccountFresh().catch(() => undefined)
      return refreshResult()
    },
    ignore,
  )

  loadPersisted()
  if (tokens && account) setState({ status: 'signed-in', account, refreshing: false })
  if (tokens) void fetchAccount().catch(() => undefined)

  setInterval(() => {
    if (tokens && !flow) void fetchAccount().catch(() => undefined)
  }, POLL_INTERVAL_MS)

  app.on('browser-window-focus', () => {
    if (tokens && !flow && Date.now() - lastFetchAt >= FOCUS_MIN_INTERVAL_MS) {
      void fetchAccount().catch(() => undefined)
    }
  })
}
