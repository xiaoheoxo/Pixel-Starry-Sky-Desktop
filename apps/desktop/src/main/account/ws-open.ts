// 按候选线路建 WebSocket（docs/network-direct.md §10）：ip 那一档用 ws 包，DNS 解析固定成那个 IP，
// TLS 的 SNI、Host 和证书校验仍按地址里的域名；别的用自带的 WebSocket。两者都不走系统代理
import NodeWebSocket from 'ws'
import { pinnedLookup, type WsTarget } from '../core/ws-tiers'

export function openWs(target: WsTarget, protocols: string[]): WebSocket {
  if (!target.ip) return new WebSocket(target.url, protocols)
  const ws = new NodeWebSocket(target.url, protocols, {
    lookup: pinnedLookup(target.ip) as never,
    handshakeTimeout: 10_000,
  })
  // ws 是 EventEmitter：还没连上就 close()（停止、握手超时）会发 error，调用方那时已经把 onerror 清掉了，
  // 没有监听的 error 会变成主进程未捕获的异常。挂一个一直在的空监听（onerror 的设置不会动它）
  ws.on('error', () => {})
  return ws as unknown as WebSocket
}
