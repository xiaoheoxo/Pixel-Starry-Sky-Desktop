// 连接层的入口：配对（扫码 → 用配对码换设备令牌）和每台电脑一条连接。界面只通过这里接触 packages/link。
import {
  bridgeApiBase,
  fingerprint,
  fromBase64Url,
  generateKeypair,
  keypairFrom,
  pairRequest,
  toBase64Url,
} from '@pixelsky/link'
import { inApp } from '@/platform'
import { type Offer } from './offer'
import { DesktopLink, type LinkHooks, type LinkState } from './link'
import { dropPush, retryDrops, syncPush } from './push'
import { DEMO_PAIRING, DemoLink, demoEnabled } from './demo'
import { activeDevice, loadPairings, savePairings, setActiveDevice, type Pairing } from './storage'

export type { Hello, LinkState } from './link'
export type { Pairing } from './storage'
export { DesktopLink } from './link'
export { findOffer, parseOffer, readOffer, type Offer } from './offer'
export { activeDevice, setActiveDevice } from './storage'
export { disablePush, enablePush, pushState, type PushState } from './push'

const PAIR_ERRORS: Record<string, string> = {
  invalid_code: '二维码已过期或已经用过，请在电脑上重新生成。',
  too_many_devices: '这台电脑已经配了 5 部手机，先在电脑上移除一部。',
}

/** 扫码后：生成手机密钥，用配对码向云端换设备令牌，存下来（等电脑上确认） */
export async function pairWithOffer(offer: Offer, phoneName: string): Promise<Pairing> {
  if (!offer.raw.code) throw new Error('这个二维码不是经云端配对的，手机连不上。')
  const key = generateKeypair()
  let res: Response
  try {
    // App 里页面不和云端同源：按二维码里的中转地址找云端（请求走原生 HTTP，没有跨域问题）
    const api = inApp ? bridgeApiBase(offer.raw.relay) : location.origin
    res = await fetch(api + '/v1/bridge/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: offer.raw.code, name: phoneName }),
    })
  } catch {
    throw new Error('连不上云端，检查一下网络。')
  }
  const body = (await res.json().catch(() => ({}))) as { deviceId?: string; token?: string; error?: string }
  if (!res.ok || !body.deviceId || !body.token)
    throw new Error(PAIR_ERRORS[body.error ?? ''] ?? '配对失败，请在电脑上重新生成二维码。')
  const pairing: Pairing = {
    deviceId: body.deviceId,
    token: body.token,
    desktopId: offer.raw.desktop,
    desktopName: offer.desktopName,
    relay: offer.raw.relay,
    desktopKey: offer.raw.key,
    fingerprint: offer.fingerprint,
    phoneKey: toBase64Url(key.privateKey),
    pairedAt: Date.now(),
    status: 'pending',
    request: pairRequest(offer.raw, key.publicKey, phoneName),
  }
  connections.add(pairing)
  return pairing
}

/** 手机自己的指纹（配对时和电脑上显示的对一下） */
export function phoneFingerprint(p: Pairing): string {
  return fingerprint(keypairFrom(fromBase64Url(p.phoneKey)).publicKey)
}

type Listener = () => void

/** 所有配对过的电脑和它们的连接 */
class Connections {
  // 演示模式（只在 vite dev 里，地址加 ?demo）：不读也不写本机的配对，用假电脑。
  // 每处都直接写 import.meta.env.DEV &&，正式构建里条件是字面量 false，demo.ts 整个不进包
  private pairings: Pairing[] = import.meta.env.DEV && demoEnabled() ? [DEMO_PAIRING] : loadPairings()
  private readonly links = new Map<string, DesktopLink>()
  private readonly listeners = new Set<Listener>()
  /** 电脑推来的事件：按设备 ID 分 */
  readonly eventListeners = new Set<(deviceId: string, event: unknown) => void>()
  private version = 0

  constructor() {
    for (const p of this.pairings) this.linkOf(p)
    if (typeof document !== 'undefined' && !(import.meta.env.DEV && demoEnabled())) {
      // 切到后台时告诉电脑（电脑照样推送提醒，§22.2），回到前台时马上重连或探一下
      document.addEventListener('visibilitychange', () => {
        const visible = document.visibilityState === 'visible'
        for (const l of this.links.values()) {
          if (visible) l.wake()
          l.away(!visible)
        }
      })
      // 在前台时每 20 秒说一声：突然断网时电脑据此知道该推送了（gateway.ts 的 SILENT_AFTER）
      setInterval(() => {
        if (document.visibilityState === 'visible') for (const l of this.links.values()) l.away(false)
      }, 20_000)
      void syncPush(this.pairings)
      void retryDrops()
      window.addEventListener('online', () => void retryDrops())
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 变了就加一（给 useSyncExternalStore 用） */
  snapshot(): number {
    return this.version
  }

  private changed(): void {
    this.version++
    for (const l of this.listeners) l()
  }

  list(): Pairing[] {
    return this.pairings
  }

  link(deviceId: string): DesktopLink | undefined {
    return this.links.get(deviceId)
  }

  state(deviceId: string): LinkState | undefined {
    return this.links.get(deviceId)?.state
  }

  private linkOf(p: Pairing): DesktopLink {
    let link = this.links.get(p.deviceId)
    if (link) return link
    const hooks: LinkHooks = {
      onState: () => this.changed(),
      onEvent: event => {
        for (const l of this.eventListeners) l(p.deviceId, event)
      },
      onPairing: next => {
        const before = this.pairings.find(x => x.deviceId === next.deviceId)
        if (next.status === 'paired' && before?.status !== 'paired') void syncPush([next])
        this.pairings = this.pairings.map(x => (x.deviceId === next.deviceId ? next : x))
        savePairings(this.pairings)
        this.changed()
      },
    }
    link =
      import.meta.env.DEV && demoEnabled()
        ? (new DemoLink(p, hooks) as unknown as DesktopLink)
        : new DesktopLink(p, hooks)
    this.links.set(p.deviceId, link)
    link.start()
    return link
  }

  add(p: Pairing): void {
    // 同一台电脑重新配对：旧记录（不管是否已被移除）换成新的，不留两条
    for (const old of this.pairings.filter(x => x.desktopId === p.desktopId && x.deviceId !== p.deviceId)) {
      this.links.get(old.deviceId)?.stop()
      this.links.delete(old.deviceId)
    }
    this.pairings = [...this.pairings.filter(x => x.desktopId !== p.desktopId), p]
    savePairings(this.pairings)
    setActiveDevice(p.deviceId)
    this.linkOf(p)
    this.changed()
  }

  /** 在手机上忘掉这台电脑（电脑那边的记录要在电脑上移除） */
  forget(deviceId: string): void {
    const p = this.pairings.find(x => x.deviceId === deviceId)
    if (p) dropPush(p)
    this.links.get(deviceId)?.stop()
    this.links.delete(deviceId)
    this.pairings = this.pairings.filter(p => p.deviceId !== deviceId)
    savePairings(this.pairings)
    if (activeDevice() === deviceId) setActiveDevice(this.pairings[0]?.deviceId ?? null)
    this.changed()
  }

  /** 当前看的电脑：上次选的，或者第一台 */
  active(): Pairing | null {
    const id = activeDevice()
    return this.pairings.find(p => p.deviceId === id) ?? this.pairings[0] ?? null
  }

  select(deviceId: string): void {
    setActiveDevice(deviceId)
    this.changed()
  }
}

export const connections = new Connections()
