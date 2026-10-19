// 订阅套餐与充值（主进程）：读云端 GET /v1/platform/store，并在系统浏览器里打开 Sub2api 面板的购买页 / 兑换页。
// 规格见 docs/cloud-service.md §4.16、docs/ui/settings.md §9.4–9.6。付款一律在浏览器里完成，桌面端不碰支付。
import { app, shell } from 'electron'
import { baseUrl, platformFetch, signedInEmail } from './account'
import type {
  StoreBonusTier,
  StoreCatalog,
  StoreCheckout,
  StoreLinkKind,
  StoreLinkParams,
  StorePlan,
  StoreQuotas,
  StoreRecharge,
} from '../../shared/types/account'

const STORE_PATH = '/v1/platform/store'
const FETCH_TIMEOUT_MS = 20_000

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
/** 有限数字，否则 null（只收 JSON 数字，不把字符串当数字） */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
/** 正的安全整数，否则 null */
function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null
}
function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseQuotas(v: unknown): StoreQuotas {
  const q = isObject(v) ? v : {}
  return { fiveHour: num(q.five_hour), daily: num(q.daily), weekly: num(q.weekly), monthly: num(q.monthly) }
}

/** 一个套餐；缺 id / 名称 / 价格的条目返回 null（丢弃，不让整页失败） */
function parsePlan(v: unknown): StorePlan | null {
  if (!isObject(v)) return null
  const id = num(v.id)
  const price = num(v.price)
  const name = text(v.name).trim()
  if (id === null || price === null || price < 0 || !name) return null
  return {
    id,
    name,
    description: text(v.description),
    price,
    originalPrice: num(v.original_price),
    currency: text(v.currency) || 'CNY',
    validityDays: Math.max(0, Math.floor(num(v.validity_days) ?? 0)),
    features: Array.isArray(v.features) ? v.features.filter((f): f is string => typeof f === 'string' && !!f) : [],
    groupName: text(v.group_name),
    groupId: positiveInt(v.group_id),
    quotas: parseQuotas(v.quotas),
    sort: num(v.sort) ?? 0,
  }
}

function parseRecharge(v: unknown): StoreRecharge {
  const r = isObject(v) ? v : {}
  const tiers: StoreBonusTier[] = []
  if (Array.isArray(r.bonus_tiers)) {
    for (const t of r.bonus_tiers) {
      if (!isObject(t)) continue
      const minAmount = num(t.min_amount)
      const bonusPercent = num(t.bonus_percent)
      if (minAmount !== null && bonusPercent !== null && minAmount >= 0 && bonusPercent > 0) {
        tiers.push({ minAmount, bonusPercent })
      }
    }
  }
  tiers.sort((a, b) => a.minAmount - b.minAmount)
  const multiplier = num(r.multiplier)
  return {
    enabled: r.enabled === true,
    min: Math.max(0, num(r.min) ?? 0),
    max: Math.max(0, num(r.max) ?? 0),
    multiplier: multiplier !== null && multiplier > 0 ? multiplier : 1,
    feeRate: Math.max(0, num(r.fee_rate) ?? 0),
    bonusMode: r.bonus_mode === 'discount' ? 'discount' : 'bonus',
    bonusTiers: tiers,
    usdToCnyRate: Math.max(0, num(r.usd_to_cny_rate) ?? 0),
  }
}

/** 软件内付款的能力标记；没给或不是对象（旧版云端）就是不开，返回 undefined */
function parseCheckout(v: unknown): StoreCheckout | undefined {
  if (!isObject(v)) return undefined
  const methods = Array.isArray(v.methods) ? v.methods.filter((m): m is string => typeof m === 'string' && !!m) : []
  const timeout = num(v.order_timeout_minutes)
  return {
    // 没有可用的支付方式时等于没开
    enabled: v.enabled === true && methods.length > 0,
    methods,
    orderTimeoutMinutes: timeout !== null && timeout > 0 ? timeout : 30,
  }
}

/** 解析 /v1/platform/store 的响应：蛇形 → 驼峰；字段类型不对就报错，多出来的字段忽略 */
export function parseStore(body: unknown): StoreCatalog {
  if (!isObject(body) || typeof body.enabled !== 'boolean' || !Array.isArray(body.plans)) {
    throw new Error('服务返回的套餐数据异常')
  }
  const plans = body.plans.flatMap(p => parsePlan(p) ?? []).sort((a, b) => a.sort - b.sort || a.id - b.id)
  const methods = Array.isArray(body.methods)
    ? body.methods.flatMap(m =>
        isObject(m) && text(m.type) ? [{ type: text(m.type), label: text(m.label) || text(m.type) }] : [],
      )
    : []
  const checkout = parseCheckout(body.checkout)
  return {
    enabled: body.enabled,
    currency: text(body.currency) || 'CNY',
    // 云端没给币种时上面的 CNY 只是猜的：界面据此不显示应付金额
    currencyKnown: !!text(body.currency),
    plans,
    recharge: parseRecharge(body.recharge),
    methods,
    helpText: text(body.help_text),
    purchaseUrl: text(body.purchase_url),
    redeemUrl: text(body.redeem_url),
    ...(checkout && { checkout }),
  }
}

/** 最近一次拿到的商品数据：打开浏览器的地址只认它（渲染层传不了任意地址） */
let last: { email: string | null; catalog: StoreCatalog } | null = null

/** 最近一次商品数据及其所属账号：软件内付款的参数校验（金额范围、套餐、支付方式）只认它 */
export function lastStore(): { email: string | null; catalog: StoreCatalog } | null {
  return last
}

export async function fetchStore(): Promise<StoreCatalog> {
  const res = await platformFetch(STORE_PATH, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* 响应体不是 JSON 就当没有 */
  }
  if (!res.ok) {
    const reason = isObject(body) ? text(body.error) : ''
    throw new Error(reason || `暂时读不到订阅套餐和充值信息（HTTP ${res.status}）`)
  }
  const catalog = parseStore(body)
  last = { email: signedInEmail(), catalog }
  return catalog
}

/** 随版本内置的可信面板域名（含子域）：正式站（pixelstarrysky.xyz）、测试站（auth.）都在它下面 */
const TRUSTED_PANEL_DOMAINS = ['pixelstarrysky.xyz']

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '')
}
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/**
 * 面板主机是否可信：就是云端地址的主机，或在内置可信域名（含子域）之下。
 * 不按云端地址的注册域放宽：云端地址若在 github.io、vercel.app 这类托管平台上，同注册域会放进别人的站点
 */
export function isTrustedPanelHost(panelHost: string, cloudHost: string): boolean {
  const host = normalizeHost(panelHost)
  const cloud = normalizeHost(cloudHost)
  if (cloud && host === cloud) return true
  return TRUSTED_PANEL_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))
}

/**
 * 面板页地址：必须是 https 绝对地址（回环地址和未打包的开发环境可以用 http）；不能带用户名密码；
 * 主机必须可信（与云端地址完全相同，或在内置域名列表里）；只带白名单里的查询参数
 */
export function storeLink(kind: StoreLinkKind, catalog: StoreCatalog, params?: StoreLinkParams): string {
  const raw = kind === 'purchase' ? catalog.purchaseUrl : kind === 'redeem' ? catalog.redeemUrl : ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('没有可用的面板地址')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('没有可用的面板地址')
  if (url.username || url.password) throw new Error('面板地址带有用户名或密码，已拒绝打开')
  const host = normalizeHost(url.hostname)
  if (url.protocol === 'http:' && app.isPackaged && !isLoopbackHost(host)) {
    throw new Error('面板地址不是 https，已拒绝打开')
  }
  let cloudHost = ''
  try {
    cloudHost = new URL(baseUrl()).hostname
  } catch {
    /* 云端地址解析不了就只认内置列表 */
  }
  if (!isTrustedPanelHost(host, cloudHost)) throw new Error('面板地址不在可信域名内，已拒绝打开')
  // Sub2api 的 /purchase 只认 ?tab=subscription 和 &group=<分组 id>（预选套餐）；金额不认，所以不带
  if (kind === 'purchase' && params?.tab === 'subscription') {
    url.searchParams.set('tab', 'subscription')
    if (params.group && Number.isSafeInteger(params.group) && params.group > 0)
      url.searchParams.set('group', String(params.group))
  }
  return url.toString()
}

export async function openStore(kind: unknown, params?: unknown): Promise<void> {
  if (kind !== 'purchase' && kind !== 'redeem') throw new Error('无效的面板页')
  if (!last || last.email !== signedInEmail()) throw new Error('请先刷新套餐信息')
  const tab = isObject(params) && params.tab === 'subscription' ? ('subscription' as const) : undefined
  const group = tab && isObject(params) ? positiveInt(params.group) : null
  await shell.openExternal(storeLink(kind, last.catalog, tab ? { tab, ...(group ? { group } : {}) } : undefined))
}
