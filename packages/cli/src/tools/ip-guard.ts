// web_fetch 的重定向目标检查：判断一个地址 / 主机名是不是「公网」。
// 纯函数 + 可注入的 DNS 解析，不依赖任何第三方库；只用可擦除的 TS 语法。
import dns from 'node:dns'
import { isIPv4, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'

/** dns.lookup(host, { all: true, verbatim: true }) 的形状，测试里可以注入假的 */
export type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<{ address: string; family: number }[]>

export const defaultLookup: LookupFn = (hostname, options) => dns.promises.lookup(hostname, options)

/** 把 IPv4 点分十进制拆成 4 个字节；格式不对返回 null */
function parseIPv4(ip: string): number[] | null {
  if (!isIPv4(ip)) return null
  return ip.split('.').map(Number)
}

/** 把 IPv6 展开成 8 个 16 位组（支持 :: 压缩、末尾点分 IPv4、%zone 后缀）；格式不对返回 null */
function parseIPv6(raw: string): number[] | null {
  const ip = raw.split('%')[0]
  if (!isIPv6(ip)) return null
  let text = ip
  // 末尾的点分 IPv4（如 ::ffff:127.0.0.1）换成两个十六进制组
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail)
    if (!v4) return null
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  if (groups.length !== 8) return null
  const out = groups.map(g => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return out.some(Number.isNaN) ? null : out
}

/**
 * IPv4 是否公网。不公网：0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.0.0/24、192.168/16、224/4、240/4。
 * 198.18.0.0/15（基准测试网段）故意算公网：Clash 等 fake-ip 代理会让本地 DNS 给每个域名都返回 198.18.x.x，
 * 算私有的话这类用户的所有重定向都会被拦；真正的内网服务不在这个网段，放行的风险很小。
 */
function isPublicIPv4(b: number[]): boolean {
  const [a, c, d] = b
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && c >= 64 && c <= 127) return false
  if (a === 169 && c === 254) return false
  if (a === 172 && c >= 16 && c <= 31) return false
  if (a === 192 && c === 0 && d === 0) return false
  if (a === 192 && c === 168) return false
  if (a >= 224) return false // 224/4 组播 + 240/4 保留（含 255.255.255.255）
  return true
}

function isPublicIPv6(g: number[]): boolean {
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]
  const firstFiveZero = g.slice(0, 5).every(x => x === 0)
  // 内嵌 IPv4 的写法，按内嵌的 IPv4 判断（否则 ::ffff:127.0.0.1 之类能绕过）
  if (firstFiveZero && g[5] === 0xffff) return isPublicIPv4(v4(g[6], g[7])) // IPv4 映射 ::ffff:0:0/96
  if (firstFiveZero && g[5] === 0) return isPublicIPv4(v4(g[6], g[7])) // IPv4 兼容 ::/96（含 :: 和 ::1）
  // IPv4-translated ::ffff:0:0:0/96
  if (g.slice(0, 4).every(x => x === 0) && g[4] === 0xffff && g[5] === 0) return isPublicIPv4(v4(g[6], g[7]))
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isPublicIPv4(v4(g[6], g[7])) // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false // 64:ff9b:1::/48 本地用途的 NAT64，可能映射到内网
  if (g[0] === 0x2002) return isPublicIPv4(v4(g[1], g[2])) // 6to4：第 16~48 位是 IPv4
  if (g[0] === 0x2001 && g[1] === 0) return false // Teredo 2001::/32：里面嵌着别的 IPv4，整段不放行
  if (g[0] === 0x100 && g.slice(1, 4).every(x => x === 0)) return false // 100::/64 丢弃前缀
  if ((g[0] & 0xfe00) === 0xfc00) return false // fc00::/7 唯一本地
  if ((g[0] & 0xffc0) === 0xfe80) return false // fe80::/10 链路本地
  if ((g[0] & 0xffc0) === 0xfec0) return false // fec0::/10 已废弃的 site-local，仍可能在内网里用
  if ((g[0] & 0xff00) === 0xff00) return false // ff00::/8 组播
  return true
}

/** 地址（IPv4 / IPv6 字面量，不带方括号）是不是公网。格式不对一律按非公网。 */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip)
  if (v4) return isPublicIPv4(v4)
  const v6 = parseIPv6(ip)
  if (v6) return isPublicIPv6(v6)
  return false
}

/** 统一写法，好比较：IPv4 点分十进制；IPv6 展开成 8 组小写十六进制，IPv4 映射地址换成 IPv4；格式不对返回 null */
function canonical(ip: string): string | null {
  const v4 = parseIPv4(ip)
  if (v4) return v4.join('.')
  const g = parseIPv6(ip)
  if (!g) return null
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff)
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.')
  return g.map(x => x.toString(16)).join(':')
}

/** 本机各网卡上的地址（统一写法）。有全局 IPv6 或直连公网 IPv4 时，这些「公网」地址连的其实是本机自己 */
export function localAddresses(): Set<string> {
  const out = new Set<string>()
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) {
      const c = canonical(a.address)
      if (c) out.add(c)
    }
  return out
}

export type PublicHostCheck =
  | { ok: true }
  /** address：第一个非公网地址（localhost 没有解析，address 就是主机名）；error：解析失败时的错误码 / 信息 */
  | { ok: false; address?: string; error?: string }

/**
 * 检查主机名（URL.hostname，IPv6 带方括号也行）是否只指向公网地址。
 * - IP 字面量直接判断；localhost / *.localhost 不解析直接算非公网；
 * - 其余用 lookup 解析，要求返回的每一个地址都是公网；
 * - 解析失败或没有任何结果：按「拦截」处理。这一跳本来就是没经用户确认的，验证不了就不放行，
 *   比让 fetch 自己去连、可能连到解析不出来的内网名字更稳；代价只是少数 DNS 抖动时多一次报错，模型可以重试。
 * - 本机网卡上的地址（全局 IPv6、直连公网的 IPv4）也算非公网：网站能看到客户端的源地址，302 回来就连到本机服务。
 * 残余限制：这里的解析和实际连接之间有 DNS 重绑定的窗口；走 HTTP 代理时真正解析域名的是代理而不是我们
 * （本地解析的结果只作参考）；经路由器 NAT 回流到本机的公网 IPv4 挡不住。第一跳靠用户的审批兜底，不在这里检查。
 */
export async function assertPublicHost(
  hostname: string,
  lookup: LookupFn = defaultLookup,
  local: () => Set<string> = localAddresses,
): Promise<PublicHostCheck> {
  let host = hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const own = local()
  const isPublic = (ip: string) => isPublicAddress(ip) && !own.has(canonical(ip.split('%')[0]) ?? '')
  if (isIPv4(host) || isIPv6(host.split('%')[0])) return isPublic(host) ? { ok: true } : { ok: false, address: host }
  // 判断 localhost 时去掉全部末尾点；解析仍用原来的名字（带点的是绝对名，不套 search 域，和实际连接一致）
  const name = host.replace(/\.+$/, '')
  if (name === 'localhost' || name.endsWith('.localhost')) return { ok: false, address: host }
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true, verbatim: true })
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return { ok: false, error: e?.code ?? e?.message ?? String(err) }
  }
  if (!Array.isArray(addrs) || addrs.length === 0) return { ok: false, error: 'no addresses' }
  for (const a of addrs) {
    if (!isPublic(a.address)) return { ok: false, address: a.address }
  }
  return { ok: true }
}
