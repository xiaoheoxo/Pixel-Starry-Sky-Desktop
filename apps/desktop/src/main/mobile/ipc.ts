// 手机端（docs/mobile-remote.md §5）：把本机数据、到中转的连接、手机网关接起来，注册设置 › 手机的接口。
// 默认关；打开、已登录平台账号、系统加密可用才连中转。中转默认是云端服务（登录用的同一个地址），
// 设置里可以改成别的地址（本机测试）。配对码、确认、移除经云端的 /v1/bridge/*（M2）。
import { hostname } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { app, powerSaveBlocker } from 'electron'
import { logger } from '@pixelsky/engine'
import { fingerprint, fromBase64Url, toBase64Url, type Codec } from '@pixelsky/link'
import * as ipc from '../ipc/guard'
import type { AppContext } from '../app/context'
import { shrinkImage } from '../app/images'
import { systemCipher } from '../app/system-cipher'
import { AwakeTracker } from './keepAwake'
import type { SessionSummary } from '@pixelsky/protocol'
import type { MobileLinkStatus, MobilePrefs, MobileSeats, MobileState } from '../../shared/types/mobile'
import { listDirectories } from '../core/directories'
import { addProjectPath } from '../core/engine/ops'
import {
  accountSnapshot,
  baseUrl,
  bridgeFetch,
  bridgeToken,
  onAccountChange,
  refreshAccountIfStale,
  signedInEmail,
} from '../account/account'
import { createDesktopRegistrar } from './desktop-register'
import { parseRelay, parseSeats, pickRelay } from './cloud-devices'
import { MobileGateway, phoneAccount, type CloudDevices } from './gateway'
import { RelayLink } from './relay'
import { MobileStore } from './store'

/** 电脑这边用 zlib；手机用 CompressionStream，格式都是 deflate-raw（M0 核对过互通） */
export const zlibCodec: Codec = {
  deflate: bytes => new Uint8Array(deflateRawSync(bytes)),
  inflate: (bytes, maxBytes) => new Uint8Array(inflateRawSync(bytes, { maxOutputLength: maxBytes })),
}

/** 默认中转：登录服务的同一个地址（https → wss） */
export function defaultRelay(base: string): string {
  return base.replace(/^http/, 'ws').replace(/\/+$/, '') + '/v1/bridge/ws'
}

/** 手机网页版的地址：云端服务的 /m/（和中转同一台服务器）；本机测试用 PIXELSKY_MOBILE_WEB 指到局域网的开发服务器 */
export function webUrl(relay: string): string {
  const override = (process.env.PIXELSKY_MOBILE_WEB ?? '').trim()
  if (override) return override
  const m = /^(wss?):\/\/([^/?#]+)/.exec(relay)
  return m ? (m[1] === 'wss' ? 'https://' : 'http://') + m[2] + '/m/' : ''
}

/** 云端接口出错：把 {error: 'not_owner'} 换成错误代码 MOBILE_NOT_OWNER（设置页按代码显示） */
async function cloudCall(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  let res: Response
  try {
    res = await bridgeFetch(method, path, body)
  } catch (e) {
    throw new Error((e as { code?: string }).code === 'AUTH_EXPIRED' ? 'MOBILE_NEED_LOGIN' : 'MOBILE_RELAY_OFFLINE')
  }
  if (res.status === 204) return null
  const data = (await res.json().catch(() => ({}))) as { error?: unknown }
  if (!res.ok) throw new Error('MOBILE_' + String(data.error ?? 'server_error').toUpperCase())
  return data
}

/** GET 云端接口；404（云端旧版本还没有这个接口）返回 null */
async function cloudGet(path: string): Promise<unknown> {
  let res: Response
  try {
    res = await bridgeFetch('GET', path)
  } catch (e) {
    throw new Error((e as { code?: string }).code === 'AUTH_EXPIRED' ? 'MOBILE_NEED_LOGIN' : 'MOBILE_RELAY_OFFLINE')
  }
  if (res.status === 404) return null
  const data = (await res.json().catch(() => ({}))) as { error?: unknown }
  if (!res.ok) throw new Error('MOBILE_' + String(data.error ?? 'server_error').toUpperCase())
  return data
}

export function initMobile(ctx: AppContext): void {
  const store = new MobileStore(join(app.getPath('userData'), 'mobile'), systemCipher, {
    enabled: false,
    // 空：用云端（defaultRelay）；环境变量只给开发测试用
    relay: process.env.PIXELSKY_MOBILE_RELAY ?? '',
    keepAwake: false,
  })
  let status: MobileLinkStatus = 'off',
    error: string | null = null
  let link: RelayLink | null = null,
    linkUrl = ''

  const state = (): MobileState => ({
    prefs: store.prefs,
    status,
    error,
    desktopName: hostname(),
    relayDefault: defaultRelay(baseUrl()),
    fingerprint: store.prefs.enabled ? store.fingerprint() : null,
    devices: store.devices.map(d => ({
      id: d.id,
      name: d.name,
      fingerprint: fingerprint(fromBase64Url(d.publicKey)),
      access: d.access,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt,
      online: gateway.online(d.id),
    })),
    pairing: gateway.pairingState(),
  })
  const changed = (): void => ctx.events.broadcast('mobile:changed', state())
  // 云端分配的中转（GET /v1/bridge/relay，有优质节点权益的账号分到优质节点）；没有、接口 404、出错都用默认中转
  let assigned: string | null = null,
    assignedFor: string | null = null,
    resolving = false,
    lastPremium: boolean | null = null
  const relayUrl = (): string => pickRelay(store.prefs.relay, assigned, defaultRelay(baseUrl()))
  /** 向云端要中转地址，拿到（或失败）后重新判断连接；取的时候换了账号就丢掉结果 */
  const resolveRelay = (email: string): void => {
    if (resolving) return
    resolving = true
    void cloudGet('/v1/bridge/relay')
      .then(parseRelay, () => null)
      .then(url => {
        resolving = false
        // 取的时候换了账号：结果作废，按新账号重新判断（会再问一次）
        if (signedInEmail() === email) {
          assigned = url
          assignedFor = email
        }
        apply()
      })
  }
  // 登记到账号：网页版靠它列出这台电脑（旧云端 404 静默跳过）
  const registrar = createDesktopRegistrar({
    signedIn: () => !!signedInEmail(),
    scope: () => `${baseUrl()}|${signedInEmail() ?? ''}`,
    input: () => {
      const key = store.prefs.enabled ? store.keypair() : null
      return {
        enabled: store.prefs.enabled,
        id: store.desktopId,
        name: hostname(),
        key: key ? toBase64Url(key.publicKey) : null,
        regenerated: store.keyGenerated,
      }
    },
    call: (method, path, body) => bridgeFetch(method, path, body),
    ver: app.getVersion(),
    warn: msg => logger('mobile').warn(msg),
  })
  const cloud: CloudDevices = {
    pairing: async () => {
      const r = (await cloudCall('POST', '/v1/bridge/pairings', { desktopId: store.desktopId })) as {
        code: string
        expiresAt: number
      }
      return { code: r.code, expiresAt: r.expiresAt }
    },
    confirm: async phone => void (await cloudCall('POST', `/v1/bridge/devices/${encodeURIComponent(phone)}/confirm`)),
    remove: async phone => void (await cloudCall('DELETE', `/v1/bridge/devices/${encodeURIComponent(phone)}`)),
    push: async (phone, payload) => {
      if (store.prefs.enabled) await cloudCall('POST', `/v1/bridge/devices/${encodeURIComponent(phone)}/push`, payload)
    },
  }

  let searchSeq = 0
  const gateway = new MobileGateway({
    store,
    desktopName: () => hostname(),
    relay: relayUrl,
    // 手机网页版总在主站（优质节点只做中转）；手机按二维码里的中转地址去连，只认主站列出的节点
    web: () => webUrl(store.prefs.relay || defaultRelay(baseUrl())) || null,
    // 手机的调用不经过 ipc.handle，自己计时：通道名加 mobile: 前缀，卡顿诊断里和窗口的请求分得开
    call: (channel, args, owner) =>
      ipc.track(`mobile:${channel}`, async () => {
        // 文件、项目工具（手机的 Git / 文件 / 任务）：和窗口同一层路由，参数里的项目在哪台机器就在哪台跑
        const tool = ctx.toolOps.get(channel)
        if (tool) return ctx.machines ? ctx.machines.invoke(channel, args, () => tool(args)) : tool(args)
        if (!ctx.engineCall) throw new Error('项目尚未加载')
        return ctx.engineCall(channel, args, owner)
      }),
    send: (phone, frame) => {
      if (!link) throw new Error('MOBILE_RELAY_OFFLINE')
      link.send(phone, frame)
    },
    codec: zlibCodec,
    cloud,
    changed,
    local: {
      defaultEngine: () => ctx.engine?.defaults().engine ?? 'claude',
      account: () => {
        // 不等云端：缓存过期就后台刷新，这次先回已有的，下次打开是新的
        void refreshAccountIfStale()
        return phoneAccount(accountSnapshot())
      },
      search: async (text, projectId, signal) => {
        if (!ctx.engine) throw new Error('项目尚未加载')
        return ctx.engine.search({ requestId: ++searchSeq, text, scope: 'all', projectId }, signal)
      },
      directories: path => listDirectories(path),
      addProject: path => {
        if (!ctx.engine) throw new Error('项目尚未加载')
        return addProjectPath(ctx.engine, path)
      },
    },
    shrinkImage,
  })

  // 对话运行时不让电脑睡眠（设置 › 通知，和手机开关无关；只看本机会话）
  const awakeTracker = new AwakeTracker()
  let sessions: readonly SessionSummary[] = [],
    awake = false,
    awakeRecheck: NodeJS.Timeout | undefined,
    blocker: number | null = null
  const keepAwake = (): void => {
    const want = store.prefs.keepAwake && awake
    if (want && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
    else if (!want && blocker !== null) {
      powerSaveBlocker.stop(blocker)
      blocker = null
    }
  }
  const updateAwake = (): void => {
    clearTimeout(awakeRecheck)
    const now = Date.now()
    const { awake: next, recheckAt } = awakeTracker.update(sessions, now)
    awake = next
    if (recheckAt !== null) awakeRecheck = setTimeout(updateAwake, recheckAt - now).unref()
    keepAwake()
  }
  ctx.hostListeners.add(event => {
    if (event.kind !== 'sessions') return
    sessions = event.sessions
    updateAwake()
  })

  const stopLink = (): void => {
    link?.stop()
    link = null
    linkUrl = ''
    gateway.dropAll()
  }
  const apply = (): void => {
    const { enabled } = store.prefs
    // 换了账号：这台电脑在云端归原来的账号，换一个电脑 ID，原来配对的手机作废
    const email = signedInEmail()
    if (email && store.bindAccount(email)) stopLink()
    const key = enabled ? store.keypair() : null
    const want = enabled && !!email && !!key
    // 没手填中转：先问云端连哪个节点。已连着的先不断，取到的地址变了下面再换
    if (want && email && !store.prefs.relay && assignedFor !== email) {
      resolveRelay(email)
      if (!link) {
        status = 'connecting'
        error = null
        keepAwake()
        changed()
        return
      }
    }
    const relay = relayUrl()
    if (link && (!want || linkUrl !== relay)) stopLink()
    if (want && !link) {
      linkUrl = relay
      link = new RelayLink({
        url: relay,
        desktopId: store.desktopId,
        token: force => bridgeToken(force),
        onFrame: (phone, frame) => gateway.receive(phone, frame),
        onNotice: notice => {
          if (notice.type === 'phone_left') gateway.phoneLeft(notice.phone)
        },
        onStatus: (next, reason) => {
          status = next
          error = reason
          if (next === 'online') void registrar.sync()
          if (next !== 'online') gateway.dropAll()
          changed()
        },
      })
      link.start()
    }
    if (!want) {
      status = 'off'
      error = !enabled ? null : !email ? 'MOBILE_NEED_LOGIN' : 'MOBILE_NO_CIPHER'
      gateway.cancelPairing()
    }
    keepAwake()
    changed()
    // 电脑 ID / 名字 / 密钥变了（和已登记的一样会跳过）；开关关着时也同步，用来重试没成功的注销（登录后会走到这里）
    if (status === 'online' || !store.prefs.enabled) void registrar.sync()
  }

  ipc.handle('mobile:state', () => state())
  ipc.handle('mobile:setPrefs', (_e, patch: Partial<MobilePrefs>) => {
    const wasEnabled = store.prefs.enabled
    store.setPrefs(patch ?? {})
    if (wasEnabled && !store.prefs.enabled) void registrar.unregister(store.desktopId)
    // 重新打开时再问一次云端分配的节点（期间可能买了优质节点）
    if (patch?.enabled === true) assignedFor = null
    apply()
    return state()
  })
  ipc.handle('mobile:pairStart', async () => {
    await gateway.startPairing()
    changed()
    return state()
  })
  ipc.handle('mobile:pairCancel', () => {
    gateway.cancelPairing()
    changed()
    return state()
  })
  ipc.handle('mobile:pairDecide', async (_e, accept: unknown) => {
    await gateway.decide(accept === true)
    return state()
  })
  ipc.handle('mobile:revoke', (_e, id: unknown) => {
    if (typeof id === 'string' && store.removeDevice(id)) gateway.revoke(id)
    changed()
    return state()
  })
  // 远程席位和账号下所有网页设备（跨桌面）。云端旧版本 404：{ available: false }，界面不显示席位
  ipc.handle('mobile:seats', async (): Promise<MobileSeats> => {
    if (!signedInEmail()) return { available: false }
    const seats = parseSeats(await cloudGet('/v1/bridge/devices'), store.desktopId) ?? { available: false }
    // 优质节点权益变了（刚买或到期）：重新问云端连哪个节点
    if (seats.available) {
      if (lastPremium !== null && lastPremium !== seats.premium) {
        assignedFor = null
        apply()
      }
      lastPremium = seats.premium
    }
    return seats
  })
  // 移除账号下其它桌面配对的网页设备（云端按账号核对归属）；本机配对的走 mobile:revoke
  ipc.handle('mobile:removeCloudDevice', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 64) throw new Error('MOBILE_NOT_FOUND')
    if (store.device(id)) {
      store.removeDevice(id)
      gateway.revoke(id)
      changed()
      return
    }
    await cloudCall('DELETE', `/v1/bridge/devices/${encodeURIComponent(id)}`)
  })
  ipc.handle('mobile:setAccess', (_e, id: unknown, access: unknown) => {
    store.setAccess(String(id), access)
    changed()
    return state()
  })

  ctx.events.taps.add((channel, args) => gateway.hostEvent(channel, args))
  // 登录 / 退出 / 换账号：重新判断连不连（退出时断开，登录后马上连）
  let signedIn = signedInEmail()
  onAccountChange(() => {
    const now = signedInEmail()
    if (now === signedIn) return
    signedIn = now
    assigned = assignedFor = lastPremium = null
    stopLink()
    apply()
  })
  ctx.lifecycle.onShutdown(() => {
    stopLink()
    gateway.close()
    clearTimeout(awakeRecheck)
    awake = false
    keepAwake()
  })
  apply()
}
