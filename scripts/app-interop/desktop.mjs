// 扮演电脑：用桌面端真实的 RelayLink（main/mobile/relay.ts）和 MobileGateway（main/mobile/gateway.ts），
// 里面就是 packages/link 的 Responder、SecureChannel、RpcCore；压缩照 main/mobile/ipc.ts 的 zlibCodec。
// 假的只有：存储（内存）、云端设备管理（直接调模拟中转）、引擎（engine:sessions 等返回假数据）、用户点「允许」（自动）。
// run.mjs 用 esbuild 打包这个文件（它要导入 TS 源码），所以这里可以直接写 TS 文件的路径。
import { createHash } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { fingerprint, generateKeypair } from '../../packages/link/src/index.ts'
import { MobileGateway } from '../../apps/desktop/src/main/mobile/gateway.ts'
import { RelayLink } from '../../apps/desktop/src/main/mobile/relay.ts'

export const DESKTOP_ID = 'desktop-interop-a0'
const SESSION = 'sess-a0-1'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** 照 ipc.ts 的 zlibCodec，另外记下每次压缩 / 解压的大小（证明大帧真的走了压缩） */
function codec(log) {
  return {
    deflate: bytes => {
      const out = new Uint8Array(deflateRawSync(bytes))
      log(`压缩发出 ${bytes.length} → ${out.length} B`)
      return out
    },
    inflate: (bytes, maxBytes) => {
      const out = new Uint8Array(inflateRawSync(bytes, { maxOutputLength: maxBytes }))
      log(`解压收到 ${bytes.length} → ${out.length} B，sha256 ${sha256(out).slice(0, 16)}`)
      return out
    },
  }
}

const record = (id, title, updatedAt, extra = {}) => ({
  id,
  projectId: 'proj-a0',
  cwd: 'D:\\work\\a0',
  engine: 'claude',
  engineSessionId: null,
  title,
  createdAt: updatedAt - 3_600_000,
  updatedAt,
  lastOutcome: 'completed',
  lastReply: '好的，已经改完了。',
  archivedAt: null,
  pinnedAt: null,
  permissionMode: 'ask',
  model: null,
  effort: null,
  ...extra,
})

/** 三条会话：一条归档的（网关不发给手机）、一条带审批内容的（网关去掉 pending） */
function sessions(now) {
  return [
    { record: record(SESSION, 'A0 互通验证', now - 1000), state: 'idle' },
    {
      record: record('sess-a0-2', '修复中文路径', now - 60_000),
      state: 'waiting',
      pending: { id: 'appr-1', kind: 'command', command: 'pnpm test', detail: 'x'.repeat(500) },
      pendingIds: ['appr-1'],
    },
    { record: record('sess-a0-3', '已归档的会话', now - 5000, { archivedAt: now - 4000 }), state: 'idle' },
  ]
}

/** openSessionTail 的回复：40 条，明文大约 30 KB，必然超过 1 KB 走压缩 */
function tail(now) {
  const items = []
  for (let i = 1; i <= 40; i++) {
    items.push(
      i % 2
        ? {
            kind: 'user',
            id: `it-${i}`,
            text: `第 ${i} 个问题：把 apps/app 的连接层接上（${'测试'.repeat(20)}）`,
            createdAt: now,
          }
        : {
            kind: 'assistant',
            id: `it-${i}`,
            text: `第 ${i} 条回复。\n\n\`\`\`dart\nfinal ok = true; // ${'注释'.repeat(40)}\n\`\`\`\n🙂 emoji 和 "转义" \\ 字符`,
            status: 'completed',
          },
    )
  }
  return {
    snapshot: { record: record(SESSION, 'A0 互通验证', now), state: 'idle', items, pending: [], queue: [] },
    seq: 40,
    total: 40,
    before: null,
    truncated: [],
  }
}

export async function startDesktop({ relayUrl, relay, log }) {
  const key = generateKeypair()
  const devices = []
  const store = {
    desktopId: DESKTOP_ID,
    device: id => devices.find(d => d.id === id),
    get devices() {
      return devices
    },
    addDevice: d => {
      const stored = { ...d, lastSeenAt: null }
      devices.push(stored)
      return stored
    },
    touch: (id, at) => {
      const d = devices.find(x => x.id === id)
      if (d) d.lastSeenAt = at
    },
    keypair: () => key,
  }
  /** 收到手机的 engine:send：记下来给 run.mjs 核对 */
  const received = []
  let gateway
  let deciding = false
  const online = new Set()
  /** 网关里有加密会话、但手机没走（中转没说 phone_left）就没了的：通道作废 */
  const dropped = []
  const left = new Set()
  /** 正在处理一条 Handshake1：网关先丢掉旧会话再建新的，这时的「没了」不算作废 */
  let rehandshake = false

  const changed = () => {
    const p = gateway.pairingState()
    if (p?.status === 'confirm' && p.request && !deciding) {
      deciding = true
      log(`设置 › 手机：「${p.request.name}」请求配对，指纹 ${p.request.fingerprint}，模拟用户点「允许」`)
      setTimeout(() => {
        gateway.decide(true).then(
          () => log('已允许，记下这部手机的公钥'),
          e => log('允许失败：' + e.message),
        )
      }, 200)
    }
    for (const d of devices) {
      const now = gateway.online(d.id)
      if (now && !online.has(d.id)) {
        online.add(d.id)
        log(`手机 ${d.id} 的加密会话建立（握手成功）`)
      } else if (!now && online.has(d.id)) {
        online.delete(d.id)
        if (left.has(d.id)) log(`手机 ${d.id} 离开，加密会话结束`)
        else if (rehandshake) log(`手机 ${d.id} 重新握手，旧的加密会话换掉`)
        else {
          dropped.push(d.id)
          log(`手机 ${d.id} 的加密会话作废（帧解不开 / 通道出错），手机得重新握手`)
        }
      }
    }
  }

  const call = async (channel, args) => {
    const now = Date.now()
    log(`引擎调用 ${channel}`)
    if (channel === 'engine:sessions') return sessions(now)
    if (channel === 'engine:openSessionTail') {
      const result = tail(now)
      // 回完快照之后推事件：5 个流式增量（网关 100 ms 内打包成一帧 batch）、1 个条目完成、会话列表、工具页刷新
      setTimeout(() => {
        let seq = result.seq
        for (let i = 0; i < 5; i++)
          gateway.hostEvent('engine:event', [
            {
              kind: 'session',
              sessionId: args[0],
              seq: ++seq,
              event: { type: 'item_delta', itemId: 'it-41', field: 'text', delta: `增量${i}` },
            },
          ])
        setTimeout(() => {
          gateway.hostEvent('engine:event', [
            {
              kind: 'session',
              sessionId: args[0],
              seq: ++seq,
              event: {
                type: 'item_completed',
                item: { kind: 'assistant', id: 'it-41', text: '增量0增量1增量2增量3增量4', status: 'completed' },
              },
            },
          ])
          gateway.hostEvent('engine:event', [{ kind: 'sessions', sessions: sessions(Date.now()) }])
          gateway.hostEvent('projectTools:changed', [{ kind: 'git', projectId: 'proj-a0' }])
        }, 150)
      }, 50)
      return result
    }
    if (channel === 'engine:send') {
      const text = typeof args[1] === 'string' ? args[1] : args[1].text
      const entry = { sessionId: args[0], chars: text.length, sha256: sha256(Buffer.from(text, 'utf8')) }
      received.push(entry)
      log(`收到手机发来的消息：${entry.chars} 个字符，sha256 ${entry.sha256.slice(0, 16)}`)
      return { accepted: true, chars: entry.chars, sha256: entry.sha256 }
    }
    throw new Error('MOBILE_UNSUPPORTED')
  }

  gateway = new MobileGateway({
    store,
    desktopName: () => 'A0 模拟电脑',
    relay: () => relayUrl,
    // 真实电脑的二维码是网页版链接（main/mobile/ipc.ts 的 webUrl）：App 也要认这种
    web: () => relayUrl.replace(/^ws/, 'http').replace(/\/v1\/bridge\/ws$/, '/m/'),
    call,
    send: (phone, frame) => link.send(phone, frame),
    codec: codec(log),
    cloud: {
      pairing: async () => relay.issueCode(DESKTOP_ID),
      confirm: async phone => relay.confirm(phone),
      remove: async phone => relay.remove(phone),
    },
    changed: () => changed(),
  })

  let resolveOnline
  const ready = new Promise(r => (resolveOnline = r))
  const link = new RelayLink({
    url: relayUrl,
    desktopId: DESKTOP_ID,
    token: async () => 'desktop-access-token',
    onFrame: (phone, frame) => {
      rehandshake = frame[0] === 1
      try {
        gateway.receive(phone, frame)
      } finally {
        rehandshake = false
      }
    },
    onNotice: notice => {
      if (notice.type === 'phone_joined') left.delete(notice.phone)
      if (notice.type === 'phone_left') {
        left.add(notice.phone)
        gateway.phoneLeft(notice.phone)
      }
    },
    onStatus: (status, error) => {
      log(`到中转：${status}${error ? '（' + error + '）' : ''}`)
      if (status !== 'online') gateway.dropAll()
      else resolveOnline()
      changed()
    },
  })
  link.start()
  await ready

  return {
    key,
    fingerprint: fingerprint(key.publicKey),
    gateway,
    received,
    dropped,
    devices,
    async newOffer() {
      deciding = false
      gateway.cancelPairing()
      const p = await gateway.startPairing()
      return p.offer
    },
    stop() {
      gateway.close()
      link.stop()
    },
  }
}
