// 本机模拟的云端中转（照 services/cloud/internal/api/bridgeapi/bridgeapi.go 和 internal/bridge/bridge.go）：
// - POST /v1/bridge/pair {code, name} → {deviceId, token, desktopId}（配对码由电脑经 cloud.pairing() 申请）；
// - GET /v1/bridge/ws?role=desktop&id=… / ?role=phone：子协议 ["pixelsky.v1", "bearer.<令牌>"]，服务端选中 pixelsky.v1；
//   先接受再核对令牌，认不出用 4001 关；有 Origin 且不同源时拒绝（同 coder/websocket 的默认规则）；
// - 只转发二进制帧：手机 → 电脑前面加「1 字节长度 + 手机 ID」，电脑 → 手机按帧头拆出手机 ID；上下线、心跳用文本帧；
// - 待确认的手机只能发配对请求（第 1 字节 4），电脑确认（cloud.confirm）后放行；单帧 1 MB，每秒 500 帧 / 8 MB。
// 多出来的只有 tamper：把某个方向的第 n 个数据帧改一个字节（反例用）。
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { need } from './deps.mjs'

const { WebSocketServer } = need('ws')

const SUBPROTOCOL = 'pixelsky.v1'
const BEARER = 'bearer.'
const MAX_FRAME = 1 << 20
const CLOSE_REPLACED = 4000
const CLOSE_UNAUTHORIZED = 4001
const CLOSE_RATE_LIMITED = 4008
const FRAME_PAIR = 4
const FRAME_DATA = 3
const FRAME_NAMES = ['?', 'Handshake1', 'Handshake2', 'Data', 'Pair', 'PairResult']
/** 电脑连中转用的访问令牌（真实的是平台账号的 OAuth 令牌） */
export const DESKTOP_TOKEN = 'desktop-access-token'

const notice = fields => JSON.stringify(fields)
const id = prefix => prefix + randomBytes(6).toString('hex')

function tokenOf(req) {
  for (const proto of (req.headers['sec-websocket-protocol'] ?? '').split(',')) {
    const p = proto.trim()
    if (p.startsWith(BEARER)) return p.slice(BEARER.length)
  }
  const auth = req.headers.authorization ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

export function startRelay({ log, ping = 2000 }) {
  /** 配对码 → {desktopId, expiresAt} */
  const codes = new Map()
  /** 手机设备：deviceId → {id, token, desktopId, name, status} */
  const devices = new Map()
  const desktops = new Map()
  const phones = new Map()
  const state = { tamper: null, forwarded: { toDesktop: 0, toPhone: 0 } }

  const send = (peer, text, data) => {
    if (peer?.ws.readyState === 1) peer.ws.send(data, { binary: !text })
  }
  const phonesOf = desktop => [...phones.values()].filter(p => p.desktop === desktop)

  /** 反例：这个方向的第 n 个数据帧改掉中间一个字节 */
  const maybeTamper = (to, frame) => {
    const t = state.tamper
    if (!t || t.to !== to || frame[0] !== FRAME_DATA) return frame
    if (--t.data > 0) return frame
    state.tamper = null
    const out = Buffer.from(frame)
    const at = 1 + Math.floor((out.length - 1) / 2)
    out[at] ^= 0x01
    log(`改掉发往${to === 'phone' ? '手机' : '电脑'}的这个数据帧的第 ${at} 字节（${out.length} B）`)
    return out
  }

  const allow = (peer, n) => {
    const now = Date.now()
    if (now - peer.window >= 1000) Object.assign(peer, { window: now, frames: 0, bytes: 0 })
    peer.frames++
    peer.bytes += n
    return peer.frames <= 500 && peer.bytes <= 8 << 20
  }

  function fromPhone(peer, frame) {
    if (!peer) return
    if (!allow(peer, frame.length)) return peer.ws.close(CLOSE_RATE_LIMITED, 'rate limited')
    const type = FRAME_NAMES[frame[0]] ?? frame[0]
    if (!frame.length || (peer.pending && frame[0] !== FRAME_PAIR)) {
      log(`丢掉待确认手机 ${peer.id} 的 ${type} 帧（只放行配对请求）`)
      return
    }
    const d = desktops.get(peer.desktop)
    if (!d) return send(peer, true, notice({ type: 'desktop_offline' }))
    const out = maybeTamper('desktop', frame)
    const head = Buffer.from(peer.id, 'utf8')
    state.forwarded.toDesktop++
    log(`手机 → 电脑  ${type} ${frame.length} B`)
    send(d, false, Buffer.concat([Buffer.of(head.length), head, out]))
  }

  function fromDesktop(desktopId, data) {
    const d = desktops.get(desktopId)
    if (!d) return
    if (!allow(d, data.length)) return d.ws.close(CLOSE_RATE_LIMITED, 'rate limited')
    if (data.length < 2 || data[0] + 1 >= data.length) return
    const to = data.subarray(1, 1 + data[0]).toString('utf8')
    const p = phones.get(to)
    if (!p || p.desktop !== desktopId) return
    const frame = data.subarray(1 + data[0])
    state.forwarded.toPhone++
    log(`电脑 → 手机  ${FRAME_NAMES[frame[0]] ?? frame[0]} ${frame.length} B`)
    send(p, false, maybeTamper('phone', frame))
  }

  function registerDesktop(desktopId, ws) {
    const peer = { ws, id: desktopId, window: 0, frames: 0, bytes: 0 }
    const old = desktops.get(desktopId)
    desktops.set(desktopId, peer)
    old?.ws.close(CLOSE_REPLACED, 'replaced')
    for (const ph of phonesOf(desktopId)) {
      send(ph, true, notice({ type: 'desktop_online' }))
      send(peer, true, notice({ type: 'phone_joined', phone: ph.id }))
    }
    return () => {
      if (desktops.get(desktopId) !== peer) return
      desktops.delete(desktopId)
      for (const ph of phonesOf(desktopId)) send(ph, true, notice({ type: 'desktop_offline' }))
    }
  }

  function registerPhone(device, ws) {
    const peer = {
      ws,
      id: device.id,
      desktop: device.desktopId,
      pending: device.status !== 'active',
      window: 0,
      frames: 0,
      bytes: 0,
    }
    const old = phones.get(device.id)
    phones.set(device.id, peer)
    old?.ws.close(CLOSE_REPLACED, 'replaced')
    const d = desktops.get(device.desktopId)
    if (!d) send(peer, true, notice({ type: 'desktop_offline' }))
    else {
      send(peer, true, notice({ type: 'desktop_online' }))
      send(d, true, notice({ type: 'phone_joined', phone: device.id }))
    }
    return () => {
      if (phones.get(device.id) !== peer) return
      phones.delete(device.id)
      send(desktops.get(device.desktopId), true, notice({ type: 'phone_left', phone: device.id }))
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'POST' && url.pathname === '/v1/bridge/pair') {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {}
        const reply = (status, json) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(json))
        }
        const code = parsed?.code
        const entry = typeof code === 'string' ? codes.get(code) : undefined
        if (!entry || entry.expiresAt < Date.now()) return reply(400, { error: 'invalid_code' })
        codes.delete(code)
        const device = {
          id: id('ph_'),
          token: randomBytes(24).toString('base64url'),
          desktopId: entry.desktopId,
          name: String(parsed.name ?? ''),
          status: 'pending',
        }
        devices.set(device.id, device)
        log(`兑换配对码：手机「${device.name}」→ 设备 ${device.id}（待电脑确认）`)
        reply(200, { deviceId: device.id, token: device.token, desktopId: device.desktopId })
      })
      return
    }
    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME,
    handleProtocols: protocols => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname !== '/v1/bridge/ws') return socket.destroy()
    const origin = req.headers.origin
    if (origin) {
      let host = ''
      try {
        host = new URL(origin).host
      } catch {}
      if (host !== req.headers.host) {
        log(`拒绝跨域 WebSocket（Origin ${origin}）`)
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const role = url.searchParams.get('role')
      const token = tokenOf(req)
      let leave = () => {}
      let forward = () => {}
      if (role === 'desktop') {
        const desktopId = url.searchParams.get('id')
        if (token !== DESKTOP_TOKEN || !desktopId) return ws.close(CLOSE_UNAUTHORIZED, 'invalid token')
        leave = registerDesktop(desktopId, ws)
        forward = data => fromDesktop(desktopId, data)
        log(`电脑 ${desktopId} 连上（子协议 ${ws.protocol || '无'}）`)
      } else if (role === 'phone') {
        const device = [...devices.values()].find(d => d.token === token)
        if (!device) {
          log('手机令牌不对，4001 关闭')
          return ws.close(CLOSE_UNAUTHORIZED, 'invalid token')
        }
        log(
          `手机 ${device.id} 连上（子协议 ${ws.protocol || '无'}，Origin ${origin ?? '无'}，${device.status === 'active' ? '已确认' : '待确认'}）`,
        )
        leave = registerPhone(device, ws)
        forward = data => fromPhone(phones.get(device.id), data)
      } else return ws.close(1008, 'bad role')
      // 同 keepalive：定时 ping，再发一条文本心跳（客户端代码收不到 ping）
      const timer = setInterval(() => {
        if (ws.readyState !== 1) return
        ws.ping()
        ws.send('{"type":"tick"}')
      }, ping)
      ws.on('message', (data, binary) => {
        if (binary) forward(Buffer.isBuffer(data) ? data : Buffer.concat(data))
      })
      ws.on('close', code => {
        clearInterval(timer)
        leave()
        log(`${role === 'desktop' ? '电脑' : '手机'}断开（关闭码 ${code}）`)
      })
    })
  })

  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        url: `ws://127.0.0.1:${port}/v1/bridge/ws`,
        state,
        /** 电脑申请配对码（POST /v1/bridge/pairings） */
        issueCode(desktopId) {
          const code = randomBytes(9).toString('base64url')
          const expiresAt = Date.now() + 10 * 60_000
          codes.set(code, { desktopId, expiresAt })
          return { code, expiresAt }
        },
        /** 电脑确认（POST /v1/bridge/devices/{id}/confirm → hub.Activate） */
        confirm(deviceId) {
          const d = devices.get(deviceId)
          if (!d) throw new Error('not_found')
          d.status = 'active'
          const p = phones.get(deviceId)
          if (p) p.pending = false
          log(`电脑确认了设备 ${deviceId}，之后它的帧全部放行`)
        },
        /** 电脑移除（DELETE /v1/bridge/devices/{id} → hub.Kick） */
        remove(deviceId) {
          devices.delete(deviceId)
          phones.get(deviceId)?.ws.close(CLOSE_UNAUTHORIZED, 'device removed')
        },
        device: deviceId => devices.get(deviceId),
        close: () =>
          new Promise(done => {
            for (const c of wss.clients) c.terminate()
            server.close(() => done())
          }),
      })
    }),
  )
}
