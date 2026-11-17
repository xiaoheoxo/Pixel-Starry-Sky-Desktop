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
import {
  codedError,
  ENGINES,
  type ImageAttachment,
  type Item,
  type SearchResult,
  type SessionSummary,
} from '@pixelsky/protocol'
import { imageOf } from '../core/engine/desktop-images'
import {
  DELTA_BATCH,
  checkSettings,
  IMAGE_INLINE,
  MobileGateway,
  PAIRING_TTL,
  CHANNEL_TEXT_LIMIT,
  PHONE_TEXT_LIMIT,
  phoneAccount,
  phoneRewind,
  phoneSessions,
  phoneSettings,
  PR_REFRESH_GAP,
  sanitize,
  type DesktopSources,
  type GatewayDeps,
  type PhoneSearch,
} from './gateway'
import type { StoredDevice } from './store'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviewFixRequest } from '../../shared/types/ai'
import { ReviewStore } from '../reviews/store'
import { prConflictRequest, type SessionPr, type SessionStatusState } from '../../shared/types/session-status'

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
const withImages = [
  { kind: 'user', id: 'u1', text: '', attachments: [picture('QUJD'), picture('A'.repeat(IMAGE_INLINE + 4))] },
  { kind: 'tool', id: 't1', images: [picture('REVG')] },
] as Item[]

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
      if (channel === 'engine:image') return imageOf(withImages.find(i => i.id === args[1]) ?? null, args[2] as number)
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
      ['engine:createSession', [{ projectId: 'proj', engine: 'codex', fast: true }], 'mobile:p1'],
      ['engine:send', ['s1', { text: 'hi', clientMessageId: 'c1' }], 'mobile:p1'],
    ])
    await expect(p.call('engine:deleteSession', 's1')).rejects.toThrow('MOBILE_UNSUPPORTED')
    await expect(p.call('engine:updateSession', 's1', { permissionMode: 'full' })).rejects.toThrow(
      'MOBILE_BAD_ARGUMENT',
    )
    await expect(p.call('projectTools:gitDiscard', { projectId: 'proj' }, 'all')).rejects.toThrow('MOBILE_UNSUPPORTED')
  })

  it('git image diffs: both sides shrunk to half a frame each; unavailable sides pass through (§15.17)', async () => {
    const big = 'data:image/png;base64,' + 'B'.repeat(IMAGE_INLINE)
    const t = setup({
      call: async channel =>
        channel === 'projectTools:gitDiff'
          ? {
              path: 'logo.png',
              original: null,
              modified: null,
              binary: true,
              tooLarge: false,
              images: {
                original: { dataUrl: 'data:image/png;base64,AAAA', bytes: 3 },
                modified: { dataUrl: big, bytes: 9 },
              },
            }
          : null,
      shrinkImage: image => ({ ...image, mediaType: 'image/jpeg', dataBase64: 'SMALL' }),
    })
    gateways.push(t.gateway)
    const p = await paired(t)
    expect(
      await p.call('projectTools:gitDiff', { projectId: 'proj' }, { path: 'logo.png', area: 'unstaged' }),
    ).toMatchObject({
      binary: true,
      images: {
        original: { dataUrl: 'data:image/png;base64,AAAA', bytes: 3 },
        modified: { dataUrl: 'data:image/jpeg;base64,SMALL', bytes: 9 },
      },
    })
  })

  it('fileImage: markdown image paths inside the session workspace only, shrunk to a frame (§15.17)', async () => {
    const calls: [string, unknown[]][] = []
    const t = setup({
      call: async (channel, args) => {
        calls.push([channel, args])
        if (channel === 'files:target') return { ref: args[0], name: 'app', path: '/home/me/app' }
        if (channel === 'files:read')
          return args[1] === 'out/shot.png'
            ? { kind: 'image', path: 'out/shot.png', dataUrl: 'data:image/png;base64,QUJD', bytes: 3 }
            : { kind: 'text', path: String(args[1]), content: 'x', version: 'v', bytes: 1, bom: false, newline: 'lf' }
        return null
      },
    })
    gateways.push(t.gateway)
    const p = await paired(t)
    expect(await p.call('fileImage', 's1', './out/shot.png')).toMatchObject({
      name: 'shot.png',
      mediaType: 'image/png',
      dataBase64: 'QUJD',
    })
    expect(await p.call('fileImage', 's1', '/home/me/app/out/shot.png')).toMatchObject({ dataBase64: 'QUJD' })
    // 项目外、::0、不是图片：不读或报不在
    await expect(p.call('fileImage', 's1', '/etc/passwd')).rejects.toThrow('MOBILE_NOT_FOUND')
    await expect(p.call('fileImage', 's1', '::0/etc/passwd')).rejects.toThrow('MOBILE_NOT_FOUND')
    await expect(p.call('fileImage', 's1', 'README.md')).rejects.toThrow('MOBILE_NOT_FOUND')
    expect(calls.filter(c => c[0] === 'files:read').map(c => c[1])).toEqual([
      [{ sessionId: 's1' }, 'out/shot.png'],
      [{ sessionId: 's1' }, 'out/shot.png'],
      [{ sessionId: 's1' }, 'README.md'],
    ])
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
    // 项目外的完整路径（::0/）：不能读、不能列
    await expect(p.call('files:read', ref, '::0/C:/Users/me/.ssh/id_rsa')).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    await expect(p.call('files:list', ref, '::0\\C:\\')).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    await expect(p.call('files:list', ref, '::0')).rejects.toThrow('MOBILE_BAD_ARGUMENT')
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
    // 只取那一张，不再整份 openSession
    expect(t.calls.at(-1)).toEqual(['engine:image', ['s1', 't1', 0], 'mobile:p1'])
    expect(t.calls.some(([channel]) => channel === 'engine:openSession')).toBe(false)
    await expect(p.call('image', 's1', 'u1', 2)).rejects.toThrow('MOBILE_NOT_FOUND')
    await expect(p.call('image', 's1', 'u1', -1)).rejects.toThrow('MOBILE_BAD_ARGUMENT')
  })

  const acct = { name: 'Ann', balance: 3.5, currency: 'USD', plan: null, updatedAt: 7 }
  it('account: slim object, unsupported without local.account, allowed for a view-only phone', async () => {
    const t = setup({ local: { defaultEngine: () => 'codex', search: async () => ({}) as never, account: () => acct } })
    gateways.push(t.gateway)
    const p = await paired(t)
    t.devices[0].access = 'view'
    expect(await p.call('account')).toEqual(acct)
    const none = setup({ local: { defaultEngine: () => 'codex', search: async () => ({}) as never } })
    gateways.push(none.gateway)
    await expect((await paired(none)).call('account')).rejects.toThrow('MOBILE_UNSUPPORTED')
    const out = setup({
      local: { defaultEngine: () => 'codex', search: async () => ({}) as never, account: async () => null },
    })
    gateways.push(out.gateway)
    expect(await (await paired(out)).call('account')).toBeNull()
  })

  // 反馈（docs/mobile-app.md §8.5）：看要「只看」，提交 / 补充 / 关闭要「可操作」；长日志截短、大图缩小；未读变化只说数
  it('feedback: view-only phones read, only act phones write; big logs cut, big images shrunk', async () => {
    const calls: unknown[][] = []
    const detail = { thread: { id: 't1' }, messages: [] } as never
    const feedback = {
      state: () =>
        ({
          status: 'ready',
          signedIn: true,
          unreadCount: 1,
          threads: [],
          nextBefore: null,
          error: null,
          checkedAt: 1,
        }) as never,
      list: async (before: unknown) => (calls.push(['list', before]), { threads: [], nextBefore: null }) as never,
      get: async (id: unknown) => (calls.push(['get', id]), detail),
      attachment: async (_t: unknown, id: unknown) =>
        (id === 1
          ? { kind: 'log', text: 'x'.repeat(PHONE_TEXT_LIMIT + 10) }
          : { kind: 'image', mediaType: 'image/png', data: 'y'.repeat(IMAGE_INLINE + 1) }) as never,
      preview: async (w: unknown) => (calls.push(['preview', w]), { diagnosticsText: 'd', logs: null }),
      create: async (input: unknown) => (calls.push(['create', input]), detail),
      reply: async (id: unknown, input: unknown) => (calls.push(['reply', id, input]), detail),
      close: async (id: unknown) => (calls.push(['close', id]), detail),
      markAllRead: async () => void calls.push(['markAllRead']),
    }
    const t = setup({
      local: { defaultEngine: () => 'codex', search: async () => ({}) as never, feedback: () => feedback },
      shrinkImage: image => ({ ...image, dataBase64: 'small' }),
    })
    gateways.push(t.gateway)
    const p = await paired(t)
    t.devices[0].access = 'view'
    expect(await p.call('feedback:state')).toMatchObject({ signedIn: true, unreadCount: 1 })
    expect(JSON.stringify(await p.call('feedback:state'))).not.toContain('@')
    await p.call('feedback:list', null)
    await p.call('feedback:get', 't1')
    await p.call('feedback:markAllRead')
    await p.call('feedback:preview', { since: 1 })
    await expect(p.call('feedback:create', { type: 'bug' })).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('feedback:reply', 't1', { body: 'x' })).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('feedback:close', 't1')).rejects.toThrow('MOBILE_FORBIDDEN')
    const log = (await p.call('feedback:attachment', 't1', 1)) as { text: string; cut?: boolean }
    expect(log.text.length).toBe(PHONE_TEXT_LIMIT)
    expect(log.cut).toBe(true)
    expect(await p.call('feedback:attachment', 't1', 2)).toEqual({
      kind: 'image',
      mediaType: 'image/png',
      data: 'small',
    })
    t.devices[0].access = 'act'
    await p.call('feedback:create', { type: 'bug' })
    await p.call('feedback:reply', 't1', { body: 'x' })
    await p.call('feedback:close', 't1')
    expect(calls.map(c => c[0])).toEqual(['list', 'get', 'markAllRead', 'preview', 'create', 'reply', 'close'])
    expect(calls[4]).toEqual(['create', { type: 'bug' }])
    // 未读变化：只发未读数，不带反馈内容和邮箱
    t.gateway.hostEvent('feedback:changed', [
      { state: { email: 'a@b.c', unreadCount: 2, threads: [{ title: 'secret' }] } },
    ])
    await wait(20)
    expect(p.events.at(-1)).toEqual({ kind: 'feedback', unread: 2 })
    // 电脑上反馈模块还没起来：说不支持
    const none = setup({
      local: { defaultEngine: () => 'codex', search: async () => ({}) as never, feedback: () => null },
    })
    gateways.push(none.gateway)
    await expect((await paired(none)).call('feedback:state')).rejects.toThrow('MOBILE_UNSUPPORTED')
  })

  it('checkout: view phones see the store and orders; only act phones order / cancel; coded errors become phone codes', async () => {
    const order = {
      orderId: 9,
      kind: 'balance',
      status: 'pending',
      method: 'alipay',
      methodLabel: '支付宝',
      payAmount: 72,
      payCurrency: 'CNY',
      feeRate: 0,
      credited: 10,
      bonus: 0,
      plan: null,
      qrContent: 'https://pay.example.com/cashier?o=1',
      qrSource: 'provider',
      payUrl: null,
      createdAt: 'x',
      expiresAt: 'y',
      paidAt: null,
      completedAt: null,
      serverTime: 'z',
      reused: false,
    } as const
    const log: unknown[] = []
    const checkout = {
      store: async () =>
        ({
          enabled: true,
          currency: 'CNY',
          plans: [],
          recharge: {},
          methods: [],
          helpText: '',
          purchaseUrl: '/buy',
          redeemUrl: '/r',
        }) as never,
      create: async (input: unknown) => {
        log.push(input)
        if ((input as { amount?: number }).amount === 1)
          throw codedError('checkout.AMOUNT_OUT_OF_RANGE', { min: 5, max: 500 })
        if ((input as { amount?: number }).amount === 2) throw codedError('checkout.PANEL_REAUTH_REQUIRED')
        return order as never
      },
      get: async () => order as never,
      verify: async () => order as never,
      cancel: async () => ({ ...order, status: 'cancelled', qrContent: null }) as never,
      pending: async () => [order] as never,
      panelVerify: async () => void log.push('verify'),
    }
    const t = setup({ local: { defaultEngine: () => 'codex', search: async () => ({}) as never, checkout } })
    gateways.push(t.gateway)
    const p = await paired(t)
    t.devices[0].access = 'view'
    const store = (await p.call('store')) as Record<string, unknown>
    expect(store.purchaseUrl).toBeUndefined()
    expect(store.redeemUrl).toBeUndefined()
    const got = (await p.call('checkoutGet', 9)) as Record<string, unknown>
    expect(got).toMatchObject({ orderId: 9, qrContent: order.qrContent, payAmount: 72 })
    expect(got.qrSource).toBeUndefined()
    expect(((await p.call('checkoutPending')) as unknown[]).length).toBe(1)
    await expect(p.call('checkoutCreate', { amount: 10 })).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('checkoutCancel', 9)).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('panelVerify')).rejects.toThrow('MOBILE_FORBIDDEN')
    t.devices[0].access = 'act'
    expect(await p.call('checkoutCreate', { amount: 10 })).toMatchObject({ orderId: 9 })
    await expect(p.call('checkoutCreate', { amount: 1 })).rejects.toThrow('MOBILE_CHECKOUT_AMOUNT_OUT_OF_RANGE:5:500')
    await expect(p.call('checkoutCreate', { amount: 2 })).rejects.toThrow('MOBILE_CHECKOUT_PANEL_REAUTH_REQUIRED')
    expect(await p.call('checkoutCancel', 9)).toMatchObject({ status: 'cancelled' })
    await p.call('panelVerify')
    expect(log.at(-1)).toBe('verify')

    const none = setup({ local: { defaultEngine: () => 'codex', search: async () => ({}) as never } })
    gateways.push(none.gateway)
    await expect((await paired(none)).call('store')).rejects.toThrow('MOBILE_UNSUPPORTED')
  })

  it('reviews: view phones read; act phones ignore and send to fix with desktop-built text; changes pushed to watchers', async () => {
    const file = join(tmpdir(), 'gw-reviews-' + process.pid + '.json')
    const store = new ReviewStore(file)
    const item = (id: string, status = 'open') =>
      ({ id, status, severity: 'high', file: 'a.ts', line: 3, title: 'bug ' + id, detail: '' }) as never
    store.set('s1', 't1', {
      at: 1,
      model: 'm',
      files: 1,
      items: [item('a'), item('b'), item('c', 'ignored')],
      fix: null,
      rechecked: false,
    })
    const t = setup({
      local: { defaultEngine: () => 'codex', search: async () => ({}) as never, reviews: () => store },
    })
    gateways.push(t.gateway)
    const p = await paired(t)
    t.devices[0].access = 'view'
    expect(Object.keys((await p.call('reviews', 's1')) as object)).toEqual(['t1'])
    expect(await p.call('reviews', 'other')).toEqual({})
    await expect(p.call('reviewItem', 's1', 't1', 'a', 'ignored')).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('reviewFix', 's1', 't1', null)).rejects.toThrow('MOBILE_FORBIDDEN')
    t.devices[0].access = 'act'
    await p.call('reviewItem', 's1', 't1', 'a', 'ignored')
    await expect(p.call('reviewItem', 's1', 't1', 'a', 'fixed')).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    await expect(p.call('reviewItem', 's1', 't1', 'zz', 'open')).rejects.toThrow('MOBILE_NOT_FOUND')
    // 全部修复：没处理的那些（a 刚忽略、c 早忽略了，只剩 b）
    await p.call('reviewFix', 's1', 't1', null)
    const sent = t.calls.find(c => c[0] === 'engine:send')!
    expect((sent[1][1] as { text: string }).text).toBe(reviewFixRequest([item('b')]))
    const r = store.session('s1').t1
    expect(r.items.map(i => i.status)).toEqual(['ignored', 'sent', 'ignored'])
    expect(r.fix?.ids).toEqual(['b'])
    await expect(p.call('reviewFix', 's1', 't1', ['c'])).rejects.toThrow('MOBILE_NOT_FOUND')

    // 推给开着这个会话的手机
    await p.call('engine:openSessionTail', 's1')
    t.gateway.hostEvent('reviews:changed', [{ sessionId: 's1', turns: store.session('s1') }])
    t.gateway.hostEvent('reviews:changed', [{ sessionId: 's2', turns: {} }])
    await wait(20)
    expect(p.events.at(-1)).toMatchObject({ kind: 'reviews', sessionId: 's1' })
    await store.flush()
    await rm(file, { force: true })
  })

  it('channels: local only, read-only for view phones; text cut, thread / flow hidden; new messages pushed to the open channel', async () => {
    const msg = (id: string, extra: object = {}) =>
      ({ id, channelId: 'c1', at: 1, kind: 'message', authorId: 'me', text: 'hi', format: 'plain', ...extra }) as never
    const messages = [
      msg('m1', {
        text: 'x'.repeat(CHANNEL_TEXT_LIMIT + 50),
        attached: { images: [{ name: 'a' }], files: [{ name: 'f.txt' }] },
      }),
      msg('m2', { threadId: 'm1' }),
      {
        id: 't1',
        channelId: 'c1',
        at: 2,
        kind: 'task',
        authorId: 'me',
        assigneeId: 'a1',
        title: '拆分登录页',
        status: 'done',
        sessionId: 's9',
      },
    ] as never[]
    const channels = {
      state: () =>
        ({
          self: { id: 'me' },
          channels: [
            { id: 'c1', name: '前端', topic: null, scope: 'local', memberIds: ['me', 'a1'], unread: 2, createdAt: 1 },
            { id: 'team1', name: '团队', topic: null, scope: 'team', memberIds: [], unread: 0, createdAt: 1 },
          ],
          members: [
            { id: 'me', kind: 'human', name: '我', you: true },
            {
              id: 'a1',
              kind: 'agent',
              name: 'Codex',
              engine: 'codex',
              status: 'idle',
              avatar: { style: 'letter', color: '#2d6151', text: 'C' },
              config: { secret: 1 },
            },
          ],
        }) as never,
      page: (id: string) => {
        if (id !== 'c1') throw new Error('频道不存在')
        return { messages, more: false }
      },
      attachments: () => ({ images: [picture('big'.repeat(IMAGE_INLINE))], files: [] }) as never,
    }
    const t = setup({
      local: { defaultEngine: () => 'codex', search: async () => ({}) as never, channels: () => channels },
      shrinkImage: image => ({ ...image, dataBase64: 'small' }),
    })
    gateways.push(t.gateway)
    const p = await paired(t)
    t.devices[0].access = 'view'
    const list = (await p.call('channels')) as { channels: { id: string; last: unknown }[]; members: object[] }
    expect(list.channels.map(c => c.id)).toEqual(['c1'])
    expect(list.channels[0].last).toEqual({ authorId: 'me', text: '拆分登录页' })
    expect(list.members[1]).toEqual({
      id: 'a1',
      kind: 'agent',
      name: 'Codex',
      engine: 'codex',
      status: 'idle',
      color: '#2d6151',
      text: 'C',
    })
    const page = (await p.call('channelMessages', 'c1')) as { messages: Record<string, unknown>[] }
    expect(page.messages.map(m => m.id)).toEqual(['m1', 't1'])
    expect((page.messages[0].text as string).length).toBe(CHANNEL_TEXT_LIMIT + 1)
    expect(page.messages[0]).toMatchObject({ images: 1, files: ['f.txt'] })
    expect(page.messages[1]).toMatchObject({ kind: 'task', status: 'done', sessionId: 's9' })
    await expect(p.call('channelMessages', 'team1')).rejects.toThrow('MOBILE_NOT_FOUND')
    expect(await p.call('channelImage', 'c1', 'm1', 0)).toMatchObject({ dataBase64: 'small' })

    // 新消息只推给开着这个频道的手机；关了就不推
    t.gateway.hostEvent('channels:message', [{ channelId: 'c1', message: msg('m3') }])
    await wait(20)
    expect(p.events.at(-1)).toMatchObject({ kind: 'channelMessage', channelId: 'c1', message: { id: 'm3' } })
    await p.call('channelUnwatch', 'c1')
    const before = p.events.length
    t.gateway.hostEvent('channels:message', [{ channelId: 'c1', message: msg('m4') }])
    t.gateway.hostEvent('channels:changed', [{}])
    t.gateway.hostEvent('channels:changed', [{}])
    await wait(600)
    expect(p.events.slice(before)).toEqual([{ kind: 'channels' }])

    const none = setup({
      local: { defaultEngine: () => 'codex', search: async () => ({}) as never, channels: () => null },
    })
    gateways.push(none.gateway)
    await expect((await paired(none)).call('channels')).rejects.toThrow('MOBILE_UNSUPPORTED')
  })

  it('PRs: only the session own PRs; fix text built on the desktop; act needed to fix / merge; changes pushed to watchers', async () => {
    const pr = {
      repo: 'o/r',
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      title: 'Fix login',
      state: 'open',
      ci: 'fail',
      ciFailed: 1,
      conflict: true,
      additions: 3,
      deletions: 1,
      head: 'fix',
      base: 'main',
      closedAt: null,
      checks: Array.from({ length: 25 }, (_, i) => ({ name: 'c' + i, state: i ? 'pass' : 'fail', url: 'u' + i })),
    } as const
    const log: unknown[][] = []
    let state = { missingFolders: {}, prs: { s1: [pr] }, mentioned: {}, gh: 'ready' } as never as SessionStatusState
    const prs = {
      state: () => state,
      refresh: async (id: string) => void log.push(['refresh', id]),
      mergeOptions: async (url: string) =>
        (log.push(['options', url]), { methods: ['squash'], deleteBranch: true }) as never,
      merge: async (...a: unknown[]) => void log.push(['merge', ...a]),
    }
    const t = setup({ local: { defaultEngine: () => 'codex', search: async () => ({}) as never, prs: () => prs } })
    gateways.push(t.gateway)
    const p = await paired(t)
    t.devices[0].access = 'view'
    const list = (await p.call('prs', 's1')) as SessionPr[]
    expect(list[0].checks).toHaveLength(20)
    expect(await p.call('prs', 'other')).toEqual([])
    await p.call('prRefresh', 's1')
    await p.call('prRefresh', 's1')
    expect(log).toEqual([['refresh', 's1']])
    t.tick(PR_REFRESH_GAP)
    await p.call('prRefresh', 's1')
    expect(log).toHaveLength(2)
    expect(await p.call('prMergeOptions', 's1', pr.url)).toEqual({ methods: ['squash'], deleteBranch: true })
    await expect(p.call('prMergeOptions', 's1', 'https://github.com/o/r/pull/8')).rejects.toThrow('MOBILE_NOT_FOUND')
    await expect(p.call('prFix', 's1', pr.url, 'checks')).rejects.toThrow('MOBILE_FORBIDDEN')
    await expect(p.call('prMerge', 's1', pr.url, 'squash', true)).rejects.toThrow('MOBILE_FORBIDDEN')
    t.devices[0].access = 'act'
    await p.call('prFix', 's1', pr.url, 'conflict')
    const sent = t.calls.find(c => c[0] === 'engine:send')!
    expect(sent[1][0]).toBe('s1')
    expect((sent[1][1] as { text: string }).text).toBe(prConflictRequest(pr))
    expect(sent[2]).toBe('mobile:p1')
    await expect(p.call('prFix', 's1', pr.url, 'other')).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    await expect(p.call('prMerge', 's1', pr.url, 'fast', true)).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    await p.call('prMerge', 's1', pr.url, 'squash', true)
    expect(log.at(-1)).toEqual(['merge', 's1', pr.url, 'squash', true])

    // 变了的才推，只推开着的会话
    await p.call('engine:openSessionTail', 's1')
    const before = p.events.length
    t.gateway.hostEvent('sessionStatus:changed', [state])
    await wait(600)
    expect(p.events.length).toBe(before)
    state = { ...state, prs: { s1: [{ ...pr, state: 'merged' }], s2: [pr] } } as never
    t.gateway.hostEvent('sessionStatus:changed', [state])
    await wait(600)
    expect(p.events.slice(before)).toMatchObject([{ kind: 'prs', sessionId: 's1', prs: [{ state: 'merged' }] }])

    const none = setup({ local: { defaultEngine: () => 'codex', search: async () => ({}) as never, prs: () => null } })
    gateways.push(none.gateway)
    await expect((await paired(none)).call('prs', 's1')).rejects.toThrow('MOBILE_UNSUPPORTED')
  })

  it('phoneAccount keeps only name, balance, currency, plan name and updatedAt', () => {
    const info = {
      email: 'a@b.c',
      name: 'Ann',
      balance: 3.5,
      currency: 'USD',
      group: { name: 'g', billingSource: 'balance_only' },
      plan: { name: 'Pro', expiresAt: null, daily: null, weekly: null, monthly: null },
      rateLimits: [{ window: '5h', used: 1, limit: 2 }],
      updatedAt: 7,
    }
    expect(phoneAccount(info)).toEqual({ name: 'Ann', balance: 3.5, currency: 'USD', plan: 'Pro', updatedAt: 7 })
    expect(phoneAccount({ ...info, plan: null })?.plan).toBeNull()
    expect(phoneAccount(null)).toBeNull()
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
  // 电脑上配好的来源（docs/mobile-app.md §14.4）
  const desktopSources = (account: string | null = 'me@x.com'): DesktopSources => ({
    account,
    platform: [
      { id: '34', name: '便宜线路', rate: 0.6, models: ['opus', 'gpt-6'] },
      { id: '35', name: '贵线路', rate: 1.5, models: ['opus'] },
    ],
    platformError: null,
    providers: [
      { id: 'p1', name: '中转', models: ['m1', 'm2'] },
      { id: 'p2', name: '没列模型', models: [] },
    ],
  })
  function settingsSetup(sources: DesktopSources | null = desktopSources()) {
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
            // 用平台线路
            {
              ...record('plat', 'claude'),
              record: {
                ...record('plat', 'claude').record,
                platform: { groupId: '34', account: 'me@x.com' },
                model: 'gpt-6',
              },
            },
            // 平台线路上用的是 Claude 自己的型号
            {
              ...record('platc', 'claude'),
              record: {
                ...record('platc', 'claude').record,
                platform: { groupId: '34', account: 'me@x.com' },
                model: 'claude-opus-4-7',
              },
            },
          ]
        if (channel === 'engine:catalog')
          return { models: [{ id: 'opus' }, { id: 'sonnet' }], outputStyles: [], currentOutputStyle: null }
        return { ok: channel }
      },
      local: {
        defaultEngine: () => 'codex',
        search: async () => ({}) as never,
        ...(sources ? { sources: async () => sources } : {}),
      },
    })
    gateways.push(t.gateway)
    return { t, calls, mutations: () => calls.filter(c => !['engine:sessions', 'engine:catalog'].includes(c[0])) }
  }

  it('passes only the permission mode, model, effort, thinking summaries and fast mode of an update, and marks it as from the phone', async () => {
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
        [
          'cc',
          { permissionMode: 'edits', model: 'opus', effort: 'high', thinkingSummaries: true, fast: true },
          'mobile',
        ],
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
    await bad('cc', { fast: 'yes' })
    await bad('cc', { engine: 'codex', platform: null, ultracode: true })
    await bad('cc', undefined)
    await bad('', { model: 'opus' })
    await expect(p.call('engine:updateSession', 'nope', { model: 'opus' })).rejects.toThrow('MOBILE_NOT_FOUND')
    expect(mutations()).toEqual([])
    // Codex 能选 ultra
    await p.call('engine:updateSession', 'cx', { effort: 'ultra', permissionMode: 'plan' })
    expect(mutations()).toHaveLength(1)
    // 选了下一个引擎还没生效：按下一个引擎的能力核对（像素星空没有思考摘要）
    await bad('next', { thinkingSummaries: true })
    // 自定义接口的会话：模型只能换成那个接口列着的（引擎目录对不上，docs/mobile-app.md §14.4），别的照常
    await bad('api', { model: 'opus' })
    await bad('api', { model: null })
    expect(mutations()).toHaveLength(1)
    await p.call('engine:updateSession', 'api', { permissionMode: 'plan' })
    expect(mutations()).toHaveLength(2)
    // Pixel 支持速度设置，具体模型 / 通道由适配器核对。
    await p.call('engine:updateSession', 'next', { fast: true })
    expect(mutations().at(-1)).toEqual(['engine:updateSession', ['next', { fast: true }, 'mobile']])
  })

  it('给手机电脑上配好的来源，不带平台账号；旧电脑没有这个方法', async () => {
    const p = await paired(settingsSetup().t)
    const list = (await p.call('sources', 'claude')) as Record<string, unknown>
    expect(list).not.toHaveProperty('account')
    expect(list.platform).toEqual(desktopSources().platform)
    expect(list.providers).toEqual(desktopSources().providers)
    await expect(p.call('sources', 'nope')).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    const old = await paired(settingsSetup(null).t)
    await expect(old.call('sources', 'claude')).rejects.toThrow('MOBILE_UNSUPPORTED')
    await expect(old.call('engine:updateSession', 'cc', { source: { kind: 'self' } })).rejects.toThrow(
      'MOBILE_UNSUPPORTED',
    )
  })

  it('换来源：核对后换成记录里的平台 / 接口和模型，带上给电脑记录的说法', async () => {
    const { t, mutations } = settingsSetup()
    const p = await paired(t)
    // 自己的账号 → 平台：会话没有模型，用那条线路的第一个；平台账号是电脑上登录的
    await p.call('engine:updateSession', 'cc', { source: { kind: 'platform', groupId: '35' } })
    expect(mutations().at(-1)).toEqual([
      'engine:updateSession',
      [
        'cc',
        { platform: { groupId: '35', account: 'me@x.com' }, provider: null, model: 'opus' },
        'mobile',
        '平台 · 贵线路',
      ],
    ])
    // 平台 → 自定义接口：原来的模型接口里没有，用接口的第一个
    await p.call('engine:updateSession', 'plat', { source: { kind: 'provider', id: 'p1' } })
    expect(mutations().at(-1)).toEqual([
      'engine:updateSession',
      ['plat', { platform: null, provider: { id: 'p1' }, model: 'm1' }, 'mobile', '自定义接口 · 中转'],
    ])
    // 换来源同时指定模型
    await p.call('engine:updateSession', 'api', { source: { kind: 'platform', groupId: '34' }, model: 'gpt-6' })
    expect(mutations().at(-1)?.[1]).toEqual([
      'api',
      { platform: { groupId: '34', account: 'me@x.com' }, provider: null, model: 'gpt-6' },
      'mobile',
      '平台 · 便宜线路',
    ])
    // 平台 → 自己的账号：原来的模型引擎目录里没有，用引擎默认
    await p.call('engine:updateSession', 'plat', { source: { kind: 'self' } })
    expect(mutations().at(-1)?.[1]).toEqual([
      'plat',
      { platform: null, provider: null, model: null },
      'mobile',
      '自己的账号',
    ])
    // 原来的是引擎自己的型号（claude-…）：和电脑上一样留着
    await p.call('engine:updateSession', 'platc', { source: { kind: 'self' } })
    expect(mutations().at(-1)?.[1]).toEqual([
      'platc',
      { platform: null, provider: null, model: 'claude-opus-4-7' },
      'mobile',
      '自己的账号',
    ])
    // 接口没列模型：原来的模型照用
    await p.call('engine:updateSession', 'plat', { source: { kind: 'provider', id: 'p2' } })
    expect(mutations().at(-1)?.[1]).toEqual([
      'plat',
      { platform: null, provider: { id: 'p2' }, model: 'gpt-6' },
      'mobile',
      '自定义接口 · 没列模型',
    ])
  })

  it('平台 / 接口的会话换模型：对着那条线路 / 接口的模型核对，不是引擎目录', async () => {
    const { t, mutations } = settingsSetup()
    const p = await paired(t)
    await p.call('engine:updateSession', 'plat', { model: 'opus', effort: 'high' })
    expect(mutations().at(-1)).toEqual(['engine:updateSession', ['plat', { model: 'opus', effort: 'high' }, 'mobile']])
    await p.call('engine:updateSession', 'api', { model: 'm2' })
    expect(mutations().at(-1)).toEqual(['engine:updateSession', ['api', { model: 'm2' }, 'mobile']])
    const before = mutations().length
    const bad = (id: string, patch: unknown) =>
      expect(p.call('engine:updateSession', id, patch)).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    await bad('plat', { model: 'sonnet' }) // 引擎目录里有，线路上没有
    await bad('plat', { model: null })
    await bad('api', { model: null })
    expect(mutations()).toHaveLength(before)
  })

  it('拒绝不在列表里的来源、线路、接口和模型，电脑没登录平台时不能换到平台，新建时不能选来源', async () => {
    const { t, mutations } = settingsSetup()
    const p = await paired(t)
    const bad = (id: string, patch: unknown) =>
      expect(p.call('engine:updateSession', id, patch)).rejects.toThrow('MOBILE_BAD_ARGUMENT')
    await bad('cc', { source: { kind: 'platform', groupId: '99' } })
    await bad('cc', { source: { kind: 'provider', id: 'gone' } })
    await bad('cc', { source: { kind: 'provider', id: 'p1', baseUrl: 'https://evil' }, model: 'opus' })
    await bad('cc', { source: { kind: 'platform', groupId: '34' }, model: 'm1' })
    await bad('cc', { source: { kind: 'mine' } })
    await bad('cc', { source: 'self' })
    await expect(p.call('engine:createSession', { projectId: 'proj', source: { kind: 'self' } })).rejects.toThrow(
      'MOBILE_BAD_ARGUMENT',
    )
    expect(mutations()).toEqual([])
    const signedOut = await paired(settingsSetup(desktopSources(null)).t)
    await expect(
      signedOut.call('engine:updateSession', 'cc', { source: { kind: 'platform', groupId: '34' } }),
    ).rejects.toThrow('MOBILE_BAD_ARGUMENT')
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
            fast: true,
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

  it('checks the engine capability table: permission modes, efforts, thinking summaries, fast mode', () => {
    const codex = ENGINES.codex.caps
    expect(() => checkSettings(codex, { permissionMode: 'plan', effort: 'ultra' })).not.toThrow()
    // 引擎没有计划模式（旧版 Codex 的情形）：不让选
    const noPlan = { ...codex, permissionModes: codex.permissionModes.filter(m => m !== 'plan') }
    expect(() => checkSettings(noPlan, { permissionMode: 'plan' })).toThrow('MOBILE_BAD_ARGUMENT')
    expect(() => checkSettings(noPlan, { permissionMode: 'edits' })).not.toThrow()
    expect(() => checkSettings(ENGINES.pixel.caps, { thinkingSummaries: true })).toThrow('MOBILE_BAD_ARGUMENT')
    expect(() => checkSettings(ENGINES.claude.caps, { effort: 'ultra' })).toThrow('MOBILE_BAD_ARGUMENT')
    expect(() => checkSettings(ENGINES.pixel.caps, { fast: true })).not.toThrow()
    expect(() => checkSettings({ ...ENGINES.pixel.caps, fast: false }, { fast: true })).toThrow('MOBILE_BAD_ARGUMENT')
    expect(() => checkSettings(codex, { fast: true })).not.toThrow()
    expect(phoneSettings({ permissionMode: 'ask', fast: true, ultracode: true, engine: 'codex' })).toEqual({
      permissionMode: 'ask',
      fast: true,
    })
  })

  it('「先出计划」开关：批准后回到的档只能是手机能开的，引擎要认这一档', () => {
    expect(phoneSettings({ permissionMode: 'plan', planReturn: 'edits' })).toEqual({
      permissionMode: 'plan',
      planReturn: 'edits',
    })
    expect(phoneSettings({ planReturn: 'ask' })).toEqual({ planReturn: 'ask' })
    for (const bad of ['full', 'auto', 'plan', 1])
      expect(() => phoneSettings({ planReturn: bad })).toThrow('MOBILE_BAD_ARGUMENT')
    expect(sanitize('engine:updateSession', ['s', { planReturn: 'edits' }])[1]).toEqual({ planReturn: 'edits' })
    expect(() => checkSettings(ENGINES.claude.caps, { planReturn: 'edits' })).not.toThrow()
    const noEdits = {
      ...ENGINES.claude.caps,
      permissionModes: ['ask', 'plan'] as typeof ENGINES.claude.caps.permissionModes,
    }
    expect(() => checkSettings(noEdits, { planReturn: 'edits' })).toThrow('MOBILE_BAD_ARGUMENT')
  })
})

describe('helpers', () => {
  it('keeps only recent, unarchived sessions for the phone', () => {
    const list = Array.from({ length: 250 }, (_, i) => summary(String(i), i, i % 2 ? 1 : null))
    list[248] = { ...list[248], pending: { requestId: 'r1' } as never, pendingIds: ['r1'] }
    const out = phoneSessions(list)
    expect(out).toHaveLength(125)
    expect(out[0].record.id).toBe('248')
    expect(out[0]).not.toHaveProperty('pending')
    expect(out[0].pendingIds).toEqual(['r1'])
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
    expect(sanitize('engine:answer', ['s', 'r1', { type: 'allow' }])).toEqual(['s', 'r1', { type: 'allow' }, 'mobile'])
  })
  it('回退：手机只能回退对话，传了还原文件、指定文件也一律去掉（docs/mobile-app.md §14.3）', () => {
    expect(sanitize('engine:rewind', ['s', 'u1', { conversation: true, code: true, paths: ['a.txt'] }])).toEqual([
      's',
      'u1',
      { conversation: true, code: false },
    ])
    expect(sanitize('engine:rewind', ['s', 'u1'])).toEqual(['s', 'u1', { conversation: true, code: false }])
    expect(() => sanitize('engine:rewind', ['s', 7])).toThrow()
    // 旁聊：问题和历史只留文字，历史最多 20 轮
    const history = Array.from({ length: 25 }, (_, i) => ({ question: 'q' + i, answer: 'a' + i, extra: 1 }))
    const side = sanitize('engine:sideQuestion', ['s', '懒加载怎么写', history])
    expect(side[1]).toBe('懒加载怎么写')
    expect(side[2]).toHaveLength(20)
    expect((side[2] as unknown[])[0]).toEqual({ question: 'q5', answer: 'a5' })
    expect(sanitize('engine:sideQuestion', ['s', 'q'])[2]).toEqual([])
    expect(() => sanitize('engine:sideQuestion', ['s', ''])).toThrow('MOBILE_BAD_ARGUMENT')
    expect(() => sanitize('engine:sideQuestion', ['s', 'q', [{ question: 1 }]])).toThrow('MOBILE_BAD_ARGUMENT')
    expect(sanitize('engine:cancelSideQuestion', ['s', 'x'])).toEqual(['s'])
    expect(sanitize('engine:undoRewind', ['s', 'extra'])).toEqual(['s'])
  })
  it('回退的结果：手机发图上限内的图片带回，超了整组不带，文件附件不带，都算进 dropped', () => {
    const image = (bytes: number): ImageAttachment => ({
      id: String(bytes),
      name: 'a.png',
      mediaType: 'image/png',
      bytes,
      width: 1,
      height: 1,
      dataBase64: 'x',
    })
    expect(phoneRewind({ text: 'hi', undoable: true, attachments: [image(1000)] })).toEqual({
      text: 'hi',
      attachments: [image(1000)],
      dropped: 0,
      undoable: true,
    })
    expect(phoneRewind({ text: 'hi', attachments: [image(400_000), image(400_000)] })).toEqual({
      text: 'hi',
      dropped: 2,
      undoable: false,
    })
    const file = { id: 'f', name: 'a.pdf' } as never
    expect(phoneRewind({ text: '', files: [file], undoable: true }).dropped).toBe(1)
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
