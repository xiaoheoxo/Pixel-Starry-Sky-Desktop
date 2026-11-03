// 中转节点（docs/cloud-admin-seats-plan.md §4）：有优质节点权益的账号，电脑连的是另一台中转，二维码里的中转地址就是它。
// 兑换配对码仍在主站（码只存在电脑申请它的主站进程里），节点只管之后的实时连接。
// 网页版只跟随主站 GET /v1/bridge/nodes 列出的节点（不然改过的二维码能把手机引到任意服务器）；
// 接口 404（云端旧版本）、出错、不在列表里都照旧用页面自己的来源。
import { bridgeApiBase } from '@pixelsky/link'

export interface RelayNode {
  name: string
  /** 中转的 WebSocket 地址（wss://…/v1/bridge/ws） */
  url: string
  premium: boolean
}

/** 中转默认的路径：节点地址只写了主机时补上 */
const WS_PATH = '/v1/bridge/ws'

/** 规范化成 WebSocket 地址；不是 ws / wss、带用户名密码、解析不了的返回 null */
export function wsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 512 || !/^wss?:\/\//i.test(raw)) return null
  try {
    const url = new URL(raw)
    if (url.username || url.password || !url.hostname) return null
    if (url.pathname === '/' || !url.pathname) url.pathname = WS_PATH
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

/** GET /v1/bridge/nodes 的返回；格式不对的项丢掉 */
export function parseNodes(raw: unknown): RelayNode[] {
  const list = (raw as { nodes?: unknown } | null)?.nodes
  if (!Array.isArray(list)) return []
  const out: RelayNode[] = []
  for (const n of list.slice(0, 100)) {
    if (!n || typeof n !== 'object') continue
    const { name, url, premium } = n as Record<string, unknown>
    const ws = wsUrl(url)
    if (ws) out.push({ name: typeof name === 'string' ? name.slice(0, 64) : '', url: ws, premium: premium === true })
  }
  return out
}

/** 二维码里的中转地址在节点列表里（按协议 + 主机 + 端口比）就返回列表里的地址，否则 null */
export function matchNode(relay: string | undefined, nodes: RelayNode[]): string | null {
  const ws = wsUrl(relay)
  if (!ws) return null
  const origin = new URL(ws).origin
  return nodes.find(n => new URL(n.url).origin === origin)?.url ?? null
}

/**
 * 网页版配对时用哪个中转节点：二维码里的地址和页面同源、或者不在主站的节点列表里，返回 null（用页面的来源）。
 * 接口 404、连不上、返回不对也是 null。
 */
export async function pickNode(
  relay: string | undefined,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!relay) return null
  try {
    if (bridgeApiBase(relay) === origin) return null
  } catch {
    return null
  }
  try {
    const res = await fetchImpl(origin + '/v1/bridge/nodes', { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return matchNode(relay, parseNodes(await res.json()))
  } catch {
    return null
  }
}
