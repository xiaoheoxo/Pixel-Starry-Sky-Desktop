import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FrameType,
  Initiator,
  LINK_VERSION,
  PROLOGUE,
  RpcCore,
  SecureChannel,
  decodeFrame,
  decodeJson,
  decodeOffer,
  encodeFrame,
  encodeJson,
  fromBase64Url,
  generateKeypair,
  pairRequest,
  type Codec,
  type Keypair,
} from '@pixelsky/link'
import { ENGINES, type ImageAttachment, type SearchResult, type SessionSummary } from '@pixelsky/protocol'
import {
  DELTA_BATCH,
  checkSettings,
  IMAGE_INLINE,
  MobileGateway,
  PAIRING_TTL,
  PHONE_TEXT_LIMIT,
  phoneSessions,
  phoneSettings,
  sanitize,
  type GatewayDeps,
  type PhoneSearch,
} from './gateway'
import type { StoredDevice } from './store'

const codec: Codec = {
  deflate: b => new Uint8Array(deflateRawSync(b)),
  inflate: (b, max) => new Uint8Array(inflateRawSync(b, { maxOutputLength: max })),
}
const wait = (ms = 0) => new Promise(r => setTimeout(r, ms))

const summary = (id: string, updatedAt: number, archivedAt: number | null = null): SessionSummary =>
  ({ record: { id, title: id, updatedAt, archivedAt }, state: 'idle' }) as unknown as SessionSummary

class Phone {
  readonly key: Keypair = generateKeypair()
  readonly results: unknown[] = []
  readonly events: unknown[] = []
  rpc: RpcCore | null = null
  private channel: SecureChannel | null = null
  private handshake: ((body: Uint8Array) => void) | null = null
  constructor(
    readonly id: string,
    private readonly gateway: () => MobileGateway,
  ) {}
  deliver(frame: Uint8Array): void {
    const { type, body } = decodeFrame(frame)
    if (type === FrameType.PairResult) this.results.push(decodeJson(body))
    else if (type === FrameType.Handshake2) this.handshake?.(body)
    else if (type === FrameType.Data) this.channel?.receive(body)
  }
  pair(offerText: string, name = '测试手机'): void {
    const offer = decodeOffer(offerText)
    this.gateway().receive(
      this.id,
      encodeFrame(FrameType.Pair, encodeJson(pairRequest(offer, this.key.publicKey, name))),
    )
  }
  async connect(desktop: Uint8Array): Promise<boolean> {
    const initiator = new Initiator({ local: this.key, remote: desktop, prologue: PROLOGUE })
    const done = new Promise<boolean>(resolve => {
      this.handshake = body => {
        const { result } = initiator.readMessage2(body)
        let rpc: RpcCore | null = null
        const channel = new SecureChannel(
          result,
          f => this.gateway().receive(this.id, f),
          v => rpc?.receive(v),
          () => rpc?.close(),
          codec,
        )
        rpc = new RpcCore(m => void channel.send(m))
        rpc.onEvent = (_c, data) => this.events.push(data)
        this.channel = channel
        this.rpc = rpc
        resolve(true)
      }
      setTimeout(() => resolve(false), 50)
    })
    this.gateway().receive(this.id, encodeFrame(FrameType.Handshake1, initiator.writeMessage1()))
    return done
  }
  call(method: string, ...args: unknown[]): Promise<unknown> {
    return this.rpc!.call(method, args, 2000)
  }
}

const picture = (dataBase64: string): ImageAttachment => ({
  id: 'img',
  name: 'a.png',
  mediaType: 'image/png',
  bytes: 3,
  width: 4000,
  height: 3000,
  dataBase64,
})
/** 会话里一条带两张图的用户消息（一小一大）和一条带图的工具结果 */
const withImages = {
  snapshot: {
    items: [
      { kind: 'user', id: 'u1', text: '', attachments: [picture('QUJD'), picture('A'.repeat(IMAGE_INLINE + 4))] },
      { kind: 'tool', id: 't1', images: [picture('REVG')] },
    ],
  },
  seq: 3,
}

function setup(extra: Partial<GatewayDeps> = {}) {
  const desktop = generateKeypair()
  const devices: StoredDevice[] = []
  const calls: [string, unknown[], string][] = []
  const phones = new Map<string, Phone>()
  const cloudCalls: string[] = []
  let now = 1_000_000
  const deps: GatewayDeps = {
    store: {
      desktopId: 'desk-1',
      keypair: () => desktop,
      device: id => devices.find(d => d.id === id),
      devices,
      addDevice: d => {
        const stored = { ...d, lastSeenAt: null }
        devices.push(stored)
        return stored
      },
      touch: () => {},
    },
    desktopName: () => '测试电脑',
    relay: () => 'ws://127.0.0.1:1',
    call: async (channel, args, owner) => {
      calls.push([channel, args, owner])
      if (channel === 'engine:sessions') return [summary('old', 1), summary('archived', 9, 5), summary('new', 3)]
      if (channel === 'engine:openSessionTail') return { snapshot: { items: [] }, seq: 1 }
      if (channel === 'engine:openSession') return withImages
      return { ok: channel }
    },
    send: (phone, frame) => phones.get(phone)?.deliver(frame),
    codec,
    cloud: {
      pairing: async () => (cloudCalls.push('pairing'), { code: 'cloud-code', expiresAt: now + 60_000 }),
      confirm: async phone => void cloudCalls.push('confirm ' + phone),
      remove: async phone => void cloudCalls.push('remove ' + phone),
      push: async (phone, payload) =>
        void cloudCalls.push(
          `push ${phone} ${payload.kind} ${payload.count} ${payload.session ?? '-'} ${payload.badge}`,
        ),
    },
    changed: () => {},
    now: () => now,
    pushTiming: { delay: 10, gap: 0 },
    ...extra,
  }
  const gateway = new MobileGateway(deps)
  const phone = (id: string) => {
    const p = new Phone(id, () => gateway)
    phones.set(id, p)
    return p
  }
  return { gateway, desktop, devices, calls, cloudCalls, phone, tick: (ms: number) => (now += ms) }
}

/** 配对并连上的手机 */
async function paired(t: ReturnType<typeof setup>, id = 'p1') {
  const p = t.phone(id)
  p.pair((await t.gateway.startPairing()).offer)
  await t.gateway.decide(true)
  expect(await p.connect(t.desktop.publicKey)).toBe(true)
  return p
}

const gateways: MobileGateway[] = []
afterEach(() => gateways.splice(0).forEach(g => g.close()))

describe('MobileGateway pairing', () => {
  it('pairs a phone that scanned the QR code after the user confirms', async () => {
    const t = setup()
    const p = t.phone('p1')
    const offer = await t.gateway.startPairing()
    expect(decodeOffer(offer.offer)).toMatchObject({ desktop: 'desk-1', name: '测试电脑', relay: 'ws://127.0.0.1:1' })
    expect(fromBase64Url(decodeOffer(offer.offer).key)).toEqual(t.desktop.publicKey)
    p.pair(offer.offer, 'Pixel 9')
    expect(t.gateway.pairingState()).toMatchObject({ status: 'confirm', request: { name: 'Pixel 9' } })
    expect(p.results).toEqual([{ status: 'pending' }])
    // 等确认时第二部手机扫同一个码：不理
    const other = t.phone('p2')
    other.pair(offer.offer)
    expect(other.results).toEqual([])
    await t.gateway.decide(true)
    expect(p.results).toEqual([{ status: 'pending' }, { status: 'accepted' }])
    expect(t.devices).toMatchObject([{ id: 'p1', name: 'Pixel 9', access: 'act' }])
    // 二维码里带云端配对码；确认先经过云端
    expect(decodeOffer(offer.offer).code).toBe('cloud-code')
    expect(t.cloudCalls).toEqual(['pairing', 'confirm p1'])
  })

  it('ignores forged, expired and rejected requests', async () => {
    const t = setup()
    const p = t.phone('p1')
    const offer = (await t.gateway.startPairing()).offer
    const forged = decodeOffer(offer)
    forged.secret = 'AAAAAAAAAAAAAAAAAAAAAA'
    t.gateway.receive('p1', encodeFrame(FrameType.Pair, encodeJson(pairRequest(forged, p.key.publicKey, 'x'))))
    expect(t.gateway.pairingState()?.status).toBe('waiting')
    t.tick(PAIRING_TTL + 1)
    expect(t.gateway.pairingState()?.status).toBe('expired')
    p.pair(offer)
    expect(p.results).toEqual([])
    await t.gateway.startPairing()
    p.pair(t.gateway.pairingState()!.offer)
    await t.gateway.decide(false)
    expect(p.results).toEqual([{ status: 'pending' }, { status: 'rejected' }])
    expect(t.devices).toEqual([])
    expect(t.cloudCalls.at(-1)).toBe('remove p1')
  })

  it('tells an unknown phone it is not paired here (a hint, not a removal) instead of shaking hands', async () => {
    const t = setup()
    const p = t.phone('stranger')
    expect(await p.connect(t.desktop.publicKey)).toBe(false)
    expect(p.results).toEqual([{ status: 'unknown' }])
    expect(t.gateway.online('stranger')).toBe(false)
  })

  it('answers a handshake it cannot read with handshake_failed and its link version', async () => {
    const t = setup()
    const p = await paired(t)
    t.gateway.receive(p.id, encodeFrame(FrameType.Handshake1, new Uint8Array(10)))
    expect(p.results.at(-1)).toEqual({ status: 'handshake_failed', v: LINK_VERSION })
  })
})

describe('MobileGateway calls', () => {
  it('serves allowed calls over the encrypted channel', async () => {
    const t = setup()
    gateways.push(t.gateway)
    const p = await paired(t)
    expect(t.gateway.online('p1')).toBe(true)
    expect(await p.call('hello')).toEqual({
      version: 1,
      name: '测试电脑',
      access: 'act',
      tools: true,
      queueMoveBefore: true,
    })
    const sessions = (await p.call('engine:sessions')) as SessionSummary[]
    expect(sessions.map(s => s.record.id)).toEqual(['new', 'old'])
    await p.call('engine:createSession', { projectId: 'proj', engine: 'codex', platform: {}, provider: {}, fast: true })
    await p.call('engine:send', 's1', { text: 'hi', clientMessageId: 'c1', settings: { model: 'x' } })
    expect(t.calls.slice(-2)).toEqual([
      ['engine:createSession', [{ projectId: 'proj', engine: 'codex' }], 'mobile:p1'],
      ['engine:send', ['s1', { text: 'hi', clientMessageId: 'c1' }], 'mobile:p1'],
    ])
    await expect(p.call('engine:deleteSession', 's1')).rejects.toThrow('MOBILE_UNSUPPORTED')
    await expect(p.call('engine:updateSession', 's1', { permissionMode: 'full' })).rejects.toThrow(
      'MOBILE_BAD_ARGUMENT',
    )
    await expect(p.call('projectTools:gitDiscard', { projectId: 'proj' }, 'all')).rejects.toThrow('MOBILE_UNSUPPORTED')
  })

  it('serves the tools with rebuilt arguments and phone-sized results', async () => {
    const calls: [string, unknown[], string][] = []
    const long = Array.from({ length: 40_000 }, (_, i) => `${i} ${'x'.repeat(20)}`).join('\n')
    const t = setup({
      call: async (channel, args, owner) => {
        calls.push([channel, args, owner])
        if (channel === 'projectTools:gitDiff')
          return { path: 'a.ts', original: 'a\nb\nc\n', modified: 'a\nB\nc\n', binary: false, tooLarge: false }
        if (channel === 'files:read')
          return args[1] === 'big.txt'
            ? {
                kind: 'text',
                path: 'big.txt',
                content: long,
                version: 'v',
                bytes: long.length,
                bom: false,
                newline: 'lf',
              }
            : {
                kind: 'image',
                path: 'p.png',
                dataUrl: 'data:image/png;base64,' + 'A'.repeat(IMAGE_INLINE + 10),
                bytes: 1,
              }
        if (channel === 'engine:artifacts')
          return { requestId: 1, turns: Array.from({ length: 120 }, () => ({})), delivered: [], truncated: false }
        return { ok: channel }
      },
      shrinkImage: image => ({ ...image, mediaType: 'image/jpeg', dataBase64: 'SMALL' }),
    })
    gateways.push(t.gateway)
    const p = await paired(t)
    const ref = { projectId: 'proj', extra: 'x' }
    expect(await p.call('projectTools:gitDiff', ref, { path: 'a.ts', area: 'unstaged', to: 'HEAD' })).toEqual({
      path: 'a.ts',
      binary: false,
      tooLarge: false,
      diff: '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c',
      added: 1,
      removed: 1,
      cut: false,
    })
    const big = (await p.call('files:read', ref, 'big.txt')) as { content: string; cut?: boolean; readonly?: boolean }
    expect(big).toMatchObject({ cut: true, readonly: true })
    expect(big.content.length).toBeLessThanOrEqual(PHONE_TEXT_LIMIT)
    expect(big.content.endsWith('\n')).toBe(true)
    expect(await p.call('files:read', { sessionId: 's1' }, 'p.png')).toMatchObject({
      kind: 'image',
      dataUrl: 'data:image/jpeg;base64,SMALL',
    })
    const artifacts = (await p.call('engine:artifacts', { projectId: 'proj', days: 99, workspace: 'C:/' })) as {
      turns: unknown[]
      truncated: boolean
    }
    expect(artifacts.turns).toHaveLength(100)
    expect(artifacts.truncated).toBe(true)
    await p.call('projectTools:gitCommit', ref, { message: '修复', all: true, push: true, amend: true })
    await p.call('projectTools:gitPush', ref, { publish: true, force: true })
    await p.call('projectTools:gitStage', ref, ['a.ts'])
    await p.call('projectTools:createTask', 'proj', { title: '写测试', status: 'pending', order: 5, projectId: 'x' })
    await p.call('projectTools:updateTask', 't1', { status: 'completed', pinnedAt: 1 })
    expect(calls.map(c => [c[0], c[1]])).toEqual([
      ['projectTools:gitDiff', [{ projectId: 'proj' }, { path: 'a.ts', area: 'unstaged' }]],
      ['files:read', [{ projectId: 'proj' }, 'big.txt']],
      ['files:read', [{ sessionId: 's1' }, 'p.png']],
      ['engine:artifacts', [{ projectId: 'proj', days: 30, requestId: 1 }]],
      ['projectTools:gitCommit', [{ projectId: 'proj' }, { message: '修复', all: true, push: true }]],
      ['projectTools:gitPush', [{ projectId: 'proj' }, { publish: true }]],
      ['projectTools:gitStage', [{ projectId: 'proj' }, ['a.ts']]],
      ['projectTools:createTask', ['proj', { title: '写测试', status: 'pending' }]],
      ['projectTools:updateTask', ['t1', { status: 'completed' }]],
    ])
    expect(calls.every(c => c[2] === 'mobile:p1')).toBe(true)
    // 只能看的手机：能看，不能写
    t.devices[0].access = 'view'
    expect(await p.call('projectTools:gitStatus', ref)).toEqual({ ok: 'projectTools:gitStatus' })
    await expect(p.call('projectTools:gitCommit', ref, { message: 'x' })).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('projectTools:createTask', 'proj', { title: 'x' })).rejects.toThrow('MOBILE_FORBIDDEN')
    // 参数不对的不发给电脑
    await expect(p.call('projectTools:gitDiff', ref, { path: 'a', area: 'commit' })).rejects.toThrow(
      'MOBILE_BAD_ARGUMENT',
    )
    await expect(p.call('files:list', {}, '')).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    expect(calls).toHaveLength(10)
  })

  it('lists folders and adds projects on this computer for phones that can act', async () => {
    const listed: (string | null)[] = []
    const t = setup({
      local: {
        defaultEngine: () => 'claude',
        search: async () => ({ requestId: 1, results: [], truncated: false, partial: false, sessionCount: 0 }),
        directories: async path => (
          listed.push(path),
          { path: path ?? 'C:/Users/me', parent: null, directories: ['code'] }
        ),
        addProject: path => ({ id: 'proj-2', name: 'code', path, addedAt: 1 }),
      },
    })
    gateways.push(t.gateway)
    const p = await paired(t)
    expect(await p.call('directories')).toMatchObject({ path: 'C:/Users/me', directories: ['code'] })
    expect(await p.call('directories', 'C:/Users/me/code')).toMatchObject({ path: 'C:/Users/me/code' })
    expect(listed).toEqual([null, 'C:/Users/me/code'])
    expect(await p.call('addProject', 'C:/Users/me/code')).toMatchObject({ id: 'proj-2' })
    t.devices[0].access = 'view'
    await expect(p.call('directories')).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('addProject', 'C:/x')).rejects.toThrow('MOBILE_FORBIDDEN')
  })

  it('answers its own calls: default engine, content search (newest cancels the last), images', async () => {
    const searched: [string, string | null][] = []
    const signals: AbortSignal[] = []
    const t = setup({
      local: {
        defaultEngine: () => 'codex',
        search: async (text, projectId, signal) => {
          searched.push([text, projectId])
          signals.push(signal)
          if (text === '慢') await wait(30)
          const results = Array.from({ length: 40 }, (_, i) => ({ id: 'r' + i }) as SearchResult)
          return { requestId: 1, results, truncated: false, partial: false, sessionCount: 3 }
        },
      },
      // 1600 以下才缩到放得下一帧
      shrinkImage: (image, edge) => ({
        ...image,
        mediaType: 'image/jpeg',
        dataBase64: edge <= 1600 ? 'R0hJ' : image.dataBase64,
      }),
    })
    gateways.push(t.gateway)
    const p = await paired(t)
    t.devices[0].access = 'view'
    expect(await p.call('defaults')).toEqual({ engine: 'codex' })
    const slow = p.call('search', '慢')
    const found = (await p.call('search', '  登录页  ', 'proj-1')) as PhoneSearch
    await slow
    expect(searched).toEqual([
      ['慢', null],
      ['登录页', 'proj-1'],
    ])
    expect(signals[0].aborted).toBe(true)
    expect(found.results).toHaveLength(30)
    expect(found.truncated).toBe(true)
    expect(await p.call('search', '   ')).toEqual({ results: [], truncated: false })
    expect(await p.call('image', 's1', 'u1', 0)).toMatchObject({ mediaType: 'image/png', dataBase64: 'QUJD' })
    expect(await p.call('image', 's1', 'u1', 1)).toMatchObject({ mediaType: 'image/jpeg', dataBase64: 'R0hJ' })
    expect(await p.call('image', 's1', 't1', 0)).toMatchObject({ dataBase64: 'REVG' })
    expect(t.calls.at(-1)).toEqual(['engine:openSession', ['s1'], 'mobile:p1'])
    await expect(p.call('image', 's1', 'u1', 2)).rejects.toThrow('MOBILE_NOT_FOUND')
    await expect(p.call('image', 's1', 'u1', -1)).rejects.toThrow('MOBILE_BAD_ARGUMENT')
  })

  it('without local queries or a shrinker: no default engine, no content search, big images refused', async () => {
    const t = setup()
    gateways.push(t.gateway)
    const p = await paired(t)
    expect(await p.call('defaults')).toEqual({ engine: null })
    await expect(p.call('search', '登录页')).rejects.toThrow('MOBILE_UNSUPPORTED')
    await expect(p.call('image', 's1', 'u1', 1)).rejects.toThrow('MOBILE_TOO_LARGE')
  })

  it('lets a view-only phone read but not act, and cuts off a revoked phone', async () => {
    const t = setup()
    gateways.push(t.gateway)
    const p = await paired(t)
    t.devices[0].access = 'view'
    await expect(p.call('engine:send', 's1', 'hi')).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('engine:answer', 's1', 'r1', { kind: 'allow' })).rejects.toThrow('MOBILE_FORBIDDEN')
    expect(await p.call('engine:openSessionTail', 's1')).toEqual({ snapshot: { items: [] }, seq: 1 })
    t.devices.splice(0)
    await expect(p.call('engine:sessions')).rejects.toThrow('MOBILE_REVOKED')
    await wait()
    expect(t.gateway.online('p1')).toBe(false)
  })

  it('pushes events only for watched sessions, throttles the session list and passes on tool changes', async () => {
    const t = setup()
    gateways.push(t.gateway)
    const p = await paired(t)
    await p.call('engine:openSessionTail', 's1')
    const event = (sessionId: string, text: string) => ({
      kind: 'session',
      sessionId,
      seq: 2,
      event: { kind: 'item_delta', itemId: 'a', delta: text },
    })
    t.gateway.hostEvent('engine:event', [event('s1', 'x'.repeat(10_000))])
    t.gateway.hostEvent('engine:event', [event('s2', 'not watched')])
    t.gateway.hostEvent('machines:changed', [{}])
    for (let i = 0; i < 5; i++)
      t.gateway.hostEvent('engine:event', [{ kind: 'sessions', sessions: [summary('a', i), summary('b', 9, 1)] }])
    await wait(20)
    expect(p.events).toHaveLength(1)
    expect(JSON.stringify(p.events[0]).length).toBeLessThan(5000)
    await wait(550)
    expect(p.events).toHaveLength(2)
    expect(p.events[1]).toMatchObject({ kind: 'sessions', sessions: [{ record: { id: 'a', updatedAt: 4 } }] })
    await p.call('unwatch', 's1')
    t.gateway.hostEvent('engine:event', [event('s1', 'y')])
    await wait(20)
    expect(p.events).toHaveLength(2)
    // 任务、Git 变了：只说一声，手机上开着的工具页重新取
    t.gateway.hostEvent('projectTools:changed', [])
    await wait(20)
    expect(p.events).toHaveLength(3)
    expect(p.events[2]).toEqual({ kind: 'tools' })
  })

  it('packs streaming deltas into one frame for phones that can unpack them, keeping order', async () => {
    const t = setup()
    gateways.push(t.gateway)
    const p = await paired(t)
    await p.call('hello', { batch: true })
    await p.call('engine:openSessionTail', 's1')
    let seq = 1
    const session = (event: unknown) => ({ kind: 'session', sessionId: 's1', seq: ++seq, event })
    const delta = (text: string) => session({ type: 'item_delta', itemId: 'a', field: 'text', delta: text })
    for (let i = 0; i < 30; i++) t.gateway.hostEvent('engine:event', [delta('x')])
    await wait(20)
    expect(p.events).toHaveLength(0)
    await wait(DELTA_BATCH + 20)
    expect(p.events).toHaveLength(1)
    expect(p.events[0]).toMatchObject({ kind: 'batch' })
    const first = (p.events[0] as { events: { seq: number }[] }).events
    expect(first.map(e => e.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 2))
    // 审批到了：先发攒着的增量（只有一条时照旧一条一帧），再单独发它
    t.gateway.hostEvent('engine:event', [delta('y')])
    t.gateway.hostEvent('engine:event', [session({ type: 'approval_resolved', requestId: 'r1' })])
    await wait(0)
    expect(p.events.slice(1)).toMatchObject([
      { kind: 'session', seq: 32 },
      { kind: 'session', seq: 33 },
    ])
  })

  it('pushes reminders to phones that are offline or in the background, not to one looking at the page', async () => {
    const t = setup()
    gateways.push(t.gateway)
    const p = await paired(t)
    const sessions = (state: string, lastOutcome: string | null = null) =>
      t.gateway.hostEvent('engine:event', [
        {
          kind: 'sessions',
          sessions: [{ record: { id: 's1', title: 's1', updatedAt: 1, archivedAt: null, lastOutcome }, state }],
        },
      ])
    const pushes = () => t.cloudCalls.filter(c => c.startsWith('push'))
    sessions('running')
    sessions('waiting')
    await wait(30)
    expect(pushes()).toEqual([])
    // 页面切到后台：照样推
    await p.call('away', true)
    sessions('running')
    sessions('idle', 'completed')
    await wait(30)
    expect(pushes()).toEqual(['push p1 completed 1 s1 0'])
    // 回到前台：攒着的不推
    sessions('running')
    sessions('idle', 'failed')
    await p.call('away', false)
    await wait(30)
    expect(pushes()).toEqual(['push p1 completed 1 s1 0'])
    // 断开了：推，几种同时有时取最要紧的
    t.gateway.phoneLeft('p1')
    sessions('running')
    sessions('idle', 'completed')
    sessions('waiting')
    await wait(30)
    expect(pushes()).toEqual(['push p1 completed 1 s1 0', 'push p1 waiting 1 s1 1'])
  })

  it('names the session in a push that concerns only one, and carries the number of sessions waiting on this computer as the badge', async () => {
    const t = setup()
    gateways.push(t.gateway)
    await paired(t)
    const row = (id: string, state: string, lastOutcome: string | null = null, archivedAt: number | null = null) => ({
      record: { id, title: id, updatedAt: 1, archivedAt, lastOutcome },
      state,
    })
    const list = (...rows: ReturnType<typeof row>[]) =>
      t.gateway.hostEvent('engine:event', [{ kind: 'sessions', sessions: rows }])
    const pushes = () => t.cloudCalls.filter(c => c.startsWith('push'))
    // 别的会话本来就在等（含一个归档的）：不算新提醒，但算角标
    list(row('a', 'running'), row('b', 'waiting'), row('c', 'running'), row('z', 'waiting', null, 5))
    t.tick(46_000)
    list(
      row('a', 'idle', 'completed'),
      row('b', 'waiting'),
      row('c', 'idle', 'completed'),
      row('z', 'waiting', null, 5),
    )
    await wait(30)
    // 两个完成：不带会话；角标是 b 一个
    expect(pushes()).toEqual(['push p1 completed 2 - 1'])
    list(row('a', 'running'), row('b', 'waiting'), row('c', 'idle'), row('z', 'waiting', null, 5))
    list(row('a', 'waiting'), row('b', 'waiting'), row('c', 'idle'), row('z', 'waiting', null, 5))
    await wait(30)
    expect(pushes().at(-1)).toBe('push p1 waiting 1 a 2')
  })

  it('treats a phone it has not heard from for a while as not looking, and drops queued pushes when it reconnects', async () => {
    const t = setup()
    gateways.push(t.gateway)
    const p = await paired(t)
    const sessions = (state: string) =>
      t.gateway.hostEvent('engine:event', [
        { kind: 'sessions', sessions: [{ record: { id: 's1', title: 's1', updatedAt: 1, archivedAt: null }, state }] },
      ])
    const pushes = () => t.cloudCalls.filter(c => c.startsWith('push'))
    sessions('running')
    t.tick(46_000)
    sessions('waiting')
    await wait(30)
    expect(pushes()).toEqual(['push p1 waiting 1 s1 1'])
    // 断开时排上的，还没到点手机就从前台连回来了：不推
    t.gateway.phoneLeft('p1')
    sessions('running')
    sessions('waiting')
    expect(await p.connect(t.desktop.publicKey)).toBe(true)
    await p.call('hello', { batch: true })
    await wait(30)
    expect(pushes()).toEqual(['push p1 waiting 1 s1 1'])
  })

  it('tells a removed phone before disconnecting it', async () => {
    const t = setup()
    gateways.push(t.gateway)
    const p = await paired(t)
    t.devices.splice(0)
    t.gateway.revoke('p1')
    expect(p.results.at(-1)).toEqual({ status: 'rejected' })
    expect(t.gateway.online('p1')).toBe(false)
  })

  it('drops the phone when a frame does not decrypt', async () => {
    const t = setup()
    gateways.push(t.gateway)
    await paired(t)
    t.gateway.receive('p1', encodeFrame(FrameType.Data, new Uint8Array(64)))
    await wait()
    expect(t.gateway.online('p1')).toBe(false)
  })
})

// 手机改模式 / 模型 / 强度、重命名、置顶、归档（docs/mobile-remote.md §21.5、§21.7）
describe('MobileGateway session settings', () => {
  const record = (id: string, engine: string, permissionMode = 'ask', nextEngine: string | null = null) => ({
    record: { id, title: id, updatedAt: 1, archivedAt: null, engine, permissionMode, nextEngine },
    state: 'idle',
  })
  function settingsSetup() {
    const calls: [string, unknown[]][] = []
    const t = setup({
      call: async (channel, args) => {
        calls.push([channel, args])
        if (channel === 'engine:sessions')
          return [
            record('cc', 'claude'),
            record('cx', 'codex'),
            record('open', 'claude', 'full'),
            // 运行中选了像素星空、还没生效
            record('next', 'claude', 'ask', 'pixel'),
            // 用自定义接口
            { ...record('api', 'claude'), record: { ...record('api', 'claude').record, provider: { id: 'p1' } } },
          ]
        if (channel === 'engine:catalog')
          return { models: [{ id: 'opus' }, { id: 'sonnet' }], outputStyles: [], currentOutputStyle: null }
        return { ok: channel }
      },
      local: { defaultEngine: () => 'codex', search: async () => ({}) as never },
    })
    gateways.push(t.gateway)
    return { t, calls, mutations: () => calls.filter(c => !['engine:sessions', 'engine:catalog'].includes(c[0])) }
  }

  it('passes only the permission mode, model, effort and thinking summaries of an update, and marks it as from the phone', async () => {
    const { t, calls, mutations } = settingsSetup()
    const p = await paired(t)
    await p.call('engine:updateSession', 'cc', {
      permissionMode: 'edits',
      model: 'opus',
      effort: 'high',
      thinkingSummaries: true,
      engine: 'codex',
      platform: { groupId: 'g', account: 'a' },
      provider: { id: 'x' },
      fast: true,
      ultracode: true,
      title: '改名',
    })
    expect(mutations()).toEqual([
      [
        'engine:updateSession',
        ['cc', { permissionMode: 'edits', model: 'opus', effort: 'high', thinkingSummaries: true }, 'mobile'],
      ],
    ])
    // 模型对着这个会话的引擎查目录
    expect(calls.filter(c => c[0] === 'engine:catalog')).toEqual([['engine:catalog', ['claude']]])
    // null 是「用引擎默认的」，不用查目录
    await p.call('engine:updateSession', 'cc', { model: null, effort: null })
    expect(mutations().at(-1)).toEqual(['engine:updateSession', ['cc', { model: null, effort: null }, 'mobile']])
  })

  it('rejects full, unknown modes, bad values, unsupported options, models outside the catalog and empty updates', async () => {
    const { t, mutations } = settingsSetup()
    const p = await paired(t)
    const bad = (id: string, patch: unknown) =>
      expect(p.call('engine:updateSession', id, patch)).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    await bad('cc', { permissionMode: 'full' })
    await bad('cc', { permissionMode: 'full', model: 'opus' })
    await bad('cc', { permissionMode: 'bypass' })
    await bad('cc', { permissionMode: null })
    await bad('cc', { effort: 'ultra' }) // Claude 没有 ultra
    await bad('cc', { effort: 'turbo' })
    await bad('cc', { thinkingSummaries: 'yes' })
    await bad('cc', { model: 'gpt-x' })
    await bad('cc', { model: '' })
    await bad('cc', { model: 5 })
    await bad('cc', { engine: 'codex', platform: null, fast: true })
    await bad('cc', undefined)
    await bad('', { model: 'opus' })
    await expect(p.call('engine:updateSession', 'nope', { model: 'opus' })).rejects.toThrow('MOBILE_NOT_FOUND')
    expect(mutations()).toEqual([])
    // Codex 能选 ultra
    await p.call('engine:updateSession', 'cx', { effort: 'ultra', permissionMode: 'plan' })
    expect(mutations()).toHaveLength(1)
    // 选了下一个引擎还没生效：按下一个引擎的能力核对（像素星空没有思考摘要）
    await bad('next', { thinkingSummaries: true })
    // 自定义接口的会话：模型不能从手机改（目录对不上），别的照常
    await bad('api', { model: 'opus' })
    await bad('api', { model: null })
    expect(mutations()).toHaveLength(1)
    await p.call('engine:updateSession', 'api', { permissionMode: 'plan' })
    expect(mutations()).toHaveLength(2)
  })

  it('lets a session that is full on the desktop only come down, never go back up', async () => {
    const { t, mutations } = settingsSetup()
    const p = await paired(t)
    await expect(p.call('engine:updateSession', 'open', { permissionMode: 'full' })).rejects.toThrow(
      'MOBILE_BAD_ARGUMENT',
    )
    await p.call('engine:updateSession', 'open', { permissionMode: 'edits' })
    // 只改模型不动权限：照常
    await p.call('engine:updateSession', 'open', { model: 'sonnet' })
    expect(mutations().map(c => (c[1][1] as { permissionMode?: string }).permissionMode)).toEqual(['edits', undefined])
  })

  it('refuses setting changes from a view-only phone', async () => {
    const { t, mutations } = settingsSetup()
    const p = await paired(t)
    t.devices[0].access = 'view'
    await expect(p.call('engine:updateSession', 'cc', { permissionMode: 'edits' })).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('engine:renameSession', 'cc', 'x')).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('engine:setSessionPinned', 'cc', true)).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('engine:archiveSession', 'cc', true)).rejects.toThrow('MOBILE_FORBIDDEN')
    expect(mutations()).toEqual([])
    // 看得到模型目录
    expect(await p.call('engine:catalog', 'claude')).toMatchObject({ models: [{ id: 'opus' }, { id: 'sonnet' }] })
  })

  it('builds a new session from the same whitelist, pinning the engine it checked against', async () => {
    const { t, mutations } = settingsSetup()
    const p = await paired(t)
    await p.call('engine:createSession', {
      projectId: 'proj',
      engine: 'claude',
      permissionMode: 'plan',
      model: 'opus',
      effort: 'low',
      thinkingSummaries: false,
      platform: {},
      fast: true,
    })
    // 没指定引擎：用电脑上的默认引擎（这里是 codex），写进参数里
    await p.call('engine:createSession', { projectId: 'proj', permissionMode: 'edits', effort: 'ultra' })
    expect(mutations()).toEqual([
      [
        'engine:createSession',
        [
          {
            projectId: 'proj',
            engine: 'claude',
            permissionMode: 'plan',
            model: 'opus',
            effort: 'low',
            thinkingSummaries: false,
          },
        ],
      ],
      ['engine:createSession', [{ projectId: 'proj', permissionMode: 'edits', effort: 'ultra', engine: 'codex' }]],
    ])
    await expect(p.call('engine:createSession', { projectId: 'proj', permissionMode: 'full' })).rejects.toThrow(
      'MOBILE_BAD_ARGUMENT',
    )
    await expect(p.call('engine:createSession', { projectId: 'proj', engine: 'claude', model: 'x' })).rejects.toThrow(
      'MOBILE_BAD_ARGUMENT',
    )
    await expect(
      p.call('engine:createSession', { projectId: 'proj', engine: 'claude', effort: 'ultra' }),
    ).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    expect(mutations()).toHaveLength(2)
  })

  it('checks rename, pin and archive arguments', async () => {
    const { t, mutations } = settingsSetup()
    const p = await paired(t)
    await p.call('engine:renameSession', 'cc', '  新名字  ')
    await p.call('engine:setSessionPinned', 'cc', true)
    await p.call('engine:archiveSession', 'cc', true)
    await p.call('engine:archiveSession', 'cc', true, true)
    expect(mutations()).toEqual([
      ['engine:renameSession', ['cc', '新名字']],
      ['engine:setSessionPinned', ['cc', true]],
      ['engine:archiveSession', ['cc', true, false]],
      ['engine:archiveSession', ['cc', true, true]],
    ])
    const bad = (method: string, ...args: unknown[]) =>
      expect(p.call(method, ...args)).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    await bad('engine:renameSession', 'cc', '   ')
    await bad('engine:renameSession', 'cc', 'a\nb')
    await bad('engine:renameSession', 'cc', 'x'.repeat(201))
    await bad('engine:renameSession', 'cc', 5)
    await bad('engine:renameSession', '', 'x')
    await bad('engine:setSessionPinned', 'cc', 'true')
    await bad('engine:setSessionPinned', 'cc')
    await bad('engine:archiveSession', 'cc', 1)
    await bad('engine:archiveSession', 'cc', true, 'yes')
    await bad('engine:archiveSession', 'cc', true, null)
    await p.call('engine:renameSession', 'cc', 'x'.repeat(200))
    expect(mutations()).toHaveLength(5)
  })

  it('only serves the model catalog of a real engine, without a refresh flag', async () => {
    const { t, calls } = settingsSetup()
    const p = await paired(t)
    await p.call('engine:catalog', 'codex', true)
    await expect(p.call('engine:catalog', 'nope')).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    await expect(p.call('engine:catalog')).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    expect(calls.filter(c => c[0] === 'engine:catalog')).toEqual([['engine:catalog', ['codex']]])
  })

  it('checks the engine capability table: permission modes, efforts, thinking summaries', () => {
    const codex = ENGINES.codex.caps
    expect(() => checkSettings(codex, { permissionMode: 'plan', effort: 'ultra' })).not.toThrow()
    // 引擎没有计划模式（旧版 Codex 的情形）：不让选
    const noPlan = { ...codex, permissionModes: codex.permissionModes.filter(m => m !== 'plan') }
    expect(() => checkSettings(noPlan, { permissionMode: 'plan' })).toThrow('MOBILE_BAD_ARGUMENT')
    expect(() => checkSettings(noPlan, { permissionMode: 'edits' })).not.toThrow()
    expect(() => checkSettings(ENGINES.pixel.caps, { thinkingSummaries: true })).toThrow('MOBILE_BAD_ARGUMENT')
    expect(() => checkSettings(ENGINES.claude.caps, { effort: 'ultra' })).toThrow('MOBILE_BAD_ARGUMENT')
    expect(phoneSettings({ permissionMode: 'ask', fast: true, engine: 'codex' })).toEqual({ permissionMode: 'ask' })
  })
})

describe('helpers', () => {
  it('keeps only recent, unarchived sessions for the phone', () => {
    const list = Array.from({ length: 250 }, (_, i) => summary(String(i), i, i % 2 ? 1 : null))
    const out = phoneSessions(list)
    expect(out).toHaveLength(125)
    expect(out[0].record.id).toBe('248')
  })
  it('rejects bad arguments before they reach the engine', () => {
    expect(() => sanitize('engine:createSession', [{}])).toThrow('MOBILE_BAD_ARGUMENT')
    expect(() => sanitize('engine:send', ['s', { text: 'x' }])).toThrow('MOBILE_BAD_ARGUMENT')
    expect(sanitize('engine:interrupt', ['s'])).toEqual(['s'])
    // 调序：新形态 { before } 和旧手机的数字下标都原样放行（校验在电脑上的 engine:moveQueued）
    expect(sanitize('engine:moveQueued', ['s', 'q1', { before: 'q2' }])).toEqual(['s', 'q1', { before: 'q2' }])
    expect(sanitize('engine:moveQueued', ['s', 'q1', { before: null }])).toEqual(['s', 'q1', { before: null }])
    expect(sanitize('engine:moveQueued', ['s', 'q1', 2])).toEqual(['s', 'q1', 2])
    // 审批：手机不能借「允许并完全放行」把会话切成 full，别的答复原样放行
    expect(() => sanitize('engine:answer', ['s', 'r1', { type: 'allow_all' }])).toThrow('MOBILE_FORBIDDEN')
    expect(sanitize('engine:answer', ['s', 'r1', { type: 'allow' }])).toEqual(['s', 'r1', { type: 'allow' }])
  })
})

// 「允许」结果帧只发一次，手机当时不在线就收不到（审查报告 2026-10-14）：手机重连后会重发配对请求，
// 已经记下这部手机（公钥一致）时直接回「已允许」
describe('MobileGateway pairing result after reconnect', () => {
  it('re-sent pair request from an accepted phone gets accepted again, even after the pairing is gone', async () => {
    const t = setup()
    const p = t.phone('p1')
    const offer = (await t.gateway.startPairing()).offer
    p.pair(offer)
    await t.gateway.decide(true)
    p.results.length = 0
    // 手机没收到 accepted，重连后重发
    p.pair(offer)
    expect(p.results).toEqual([{ status: 'accepted' }])
    // 电脑重启 / 配对面板关了（没有进行中的配对）也一样
    t.gateway.cancelPairing()
    p.pair(offer)
    expect(p.results).toEqual([{ status: 'accepted' }, { status: 'accepted' }])
  })
  it('a different key under the same phone id is not told anything', async () => {
    const t = setup()
    const p = t.phone('p1')
    const offer = (await t.gateway.startPairing()).offer
    p.pair(offer)
    await t.gateway.decide(true)
    t.gateway.cancelPairing()
    const impostor = t.phone('p1')
    impostor.pair(offer)
    expect(impostor.results).toEqual([])
  })
})
