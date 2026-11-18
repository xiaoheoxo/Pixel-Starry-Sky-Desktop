// 远程席位和中转节点（docs/cloud-admin-seats-plan.md §3–5）：云端 GET /v1/bridge/devices、GET /v1/bridge/relay 的
// 返回逐字段校验，不信任的字段丢掉或换成 null；整体不对就当作没有（界面按旧版本处理）。不依赖 electron，方便测试。
import type { MobileCloudDevice, MobileSeats } from '../../shared/types/mobile'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 非负整数（席位数）；不对返回 null */
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : null
}

/** 短文本：去掉控制字符、截断；不是字符串返回 '' */
function text(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max)
}

/** 时间：毫秒 / 秒时间戳或 RFC 3339 字符串；不对、零值（Go 的 0001-01-01）返回 null */
export function timeOf(v: unknown): number | null {
  let ms: number
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) ms = v < 1e12 ? v * 1000 : v
  else if (typeof v === 'string' && v) ms = Date.parse(v)
  else return null
  // 2000 年以前的都当没有（包括 Go 的零时间）
  return Number.isFinite(ms) && ms > 946_684_800_000 ? ms : null
}

/** 分组 id 列表：只留正整数，去重，最多 50 个 */
function groups(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const g of v) {
    const n = typeof g === 'string' && /^\d+$/.test(g) ? Number(g) : g
    if (typeof n === 'number' && Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
    if (out.length >= 50) break
  }
  return out
}

/** IP 地址：只认 IPv4 / IPv6 的字符 */
function ip(v: unknown): string | null {
  return typeof v === 'string' && /^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : null
}

function device(v: unknown, localDesktop: string): MobileCloudDevice | null {
  if (!isObj(v)) return null
  const id = text(v.id, 64),
    desktopId = text(v.desktop_id, 64)
  if (!id || id !== v.id) return null
  return {
    id,
    name: text(v.name, 64),
    desktopId,
    local: !!desktopId && desktopId === localDesktop,
    pending: v.status === 'pending',
    online: v.online === true,
    lastIp: ip(v.last_ip),
    lastSeenAt: timeOf(v.last_seen_at),
    createdAt: timeOf(v.created_at),
  }
}

/** GET /v1/bridge/devices 的返回 → MobileSeats；席位字段不对就返回 null（当作接口不可用） */
export function parseSeats(raw: unknown, localDesktop: string): MobileSeats | null {
  if (!isObj(raw) || !isObj(raw.seats)) return null
  const used = count(raw.seats.used),
    limit = count(raw.seats.limit)
  if (used === null || limit === null) return null
  const devices: MobileCloudDevice[] = []
  if (Array.isArray(raw.devices)) {
    for (const d of raw.devices.slice(0, 500)) {
      const parsed = device(d, localDesktop)
      if (parsed && !devices.some(x => x.id === parsed.id)) devices.push(parsed)
    }
  }
  // 本机的在前，再按在线、最近在线排
  devices.sort(
    (a, b) =>
      Number(b.local) - Number(a.local) ||
      Number(b.online) - Number(a.online) ||
      (b.lastSeenAt ?? b.createdAt ?? 0) - (a.lastSeenAt ?? a.createdAt ?? 0),
  )
  return {
    available: true,
    used,
    limit,
    premium: raw.premium === true,
    seatGroups: groups(raw.seat_groups),
    premiumGroups: groups(raw.premium_groups),
    devices,
  }
}

/** 中转地址的格式：ws:// 或 wss://，不含空白和用户名密码，长度有限 */
export function validRelay(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 512 || !/^wss?:\/\/[^\s]+$/.test(v)) return false
  try {
    const url = new URL(v)
    return !url.username && !url.password && !!url.hostname
  } catch {
    return false
  }
}

/**
 * GET /v1/bridge/relay 的返回 → 分配的中转地址；不对返回 null（用默认中转）。
 * 主站节点（node 为 default）也返回 null：云端给的是 CDN 域名（API_URL），WebSocket 会被 CDN 拦成 426，
 * 用本机的默认几档（CDN → 直连 → IP，docs/network-direct.md §10）
 */
export function parseRelay(raw: unknown): string | null {
  return isObj(raw) && raw.node !== 'default' && validRelay(raw.url) ? raw.url : null
}

/** 连哪个中转：设置里手填的（或 PIXELSKY_MOBILE_RELAY）优先，其次云端分配的，最后是登录站的默认中转 */
export function pickRelay(manual: string, assigned: string | null, fallback: string): string {
  return manual || assigned || fallback
}
