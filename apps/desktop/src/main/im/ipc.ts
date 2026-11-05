// 消息通道的接线（docs/ui/one-click-connectors.md）：凭据和待发内容加密存盘，把 QQ / 微信的收发、引擎事件接到 ImBridge，
// 注册设置 › 消息通道的接口。只在本机：用本机引擎宿主，不走 SSH 路由
import { join } from 'node:path'
import { app } from 'electron'
import { codedError } from '@pixelsky/protocol'
import { logger, object, text, type EngineHost } from '@pixelsky/engine'
import * as ipc from '../ipc/guard'
import type { AppContext } from '../app/context'
import { windowLocale } from '../app/ui-language'
import { systemCipher } from '../app/system-cipher'
import { SecureStore } from '../core/secure-store'
import { allMessages, type TranslationKey } from '../../shared/i18n/translate'
import { IM_PLATFORMS, type ImChannelState, type ImPlatform, type ImState, type ImStatus } from '../../shared/types/im'
import { emptyMemory, ImBridge, type BridgeEngine, type BridgeMemory, type ImInbound, type ImSender } from './bridge'
import { QqLink } from './qq'
import { WechatLink } from './wechat'

const FIELD_MAX = 256
const log = logger('im')

function say(key: TranslationKey, values: Record<string, string | number> = {}): string {
  const message = allMessages[key][windowLocale() === 'en-US' ? 'en' : 'zh']
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    values[name] === undefined ? placeholder : String(values[name]),
  )
}

/** 报白名单错误时才查一次，告诉用户要加哪个 IP；只有这个请求，不带任何内容 */
async function publicIp(): Promise<string | null> {
  const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) })
  const ip = (await res.text()).trim()
  return /^[\d.:a-fA-F]{3,45}$/.test(ip) ? ip : null
}

type Values = Record<string, string>

class ImChannel {
  private link: (ImSender & { start(): void; stop(): void }) | null = null
  private status: ImStatus = 'off'
  private error: string | null = null
  private errorDetail: string | null = null
  private qr: string | null = null
  private cache: BridgeMemory | null = null
  readonly bridge: ImBridge

  constructor(
    readonly platform: ImPlatform,
    private readonly store: SecureStore,
    engine: BridgeEngine,
    projectId: () => string | null,
    private readonly changed: () => void,
  ) {
    this.bridge = new ImBridge({
      // link 换了也发到当前这个；没连着算网络问题，内容留在队列里
      sender: {
        maxChars: 1800,
        send: (to, message, reply) => {
          if (!this.link) throw new Error('not connected')
          return this.link.send(to, message, reply)
        },
      },
      engine,
      projectId,
      memory: () => this.memory(),
      save: patch => this.saveMemory(patch),
      say,
      changed,
      warn: message => log.warn(message),
    })
  }

  private values(): Values {
    return { ...this.store.get(this.platform) }
  }

  private patch(patch: Values): void {
    this.store.set(this.platform, { ...this.values(), ...patch })
  }

  private memory(): BridgeMemory {
    if (this.cache) return this.cache
    try {
      this.cache = { ...emptyMemory(), ...JSON.parse(this.values().memory ?? '{}') }
    } catch {
      this.cache = emptyMemory()
    }
    return this.cache as BridgeMemory
  }

  private saveMemory(patch: Partial<BridgeMemory>): void {
    this.cache = { ...this.memory(), ...patch }
    this.patch({ memory: JSON.stringify(this.cache) })
  }

  private setStatus(status: ImStatus, error: string | null, detail: string | null = null): void {
    this.status = status
    this.error = error
    this.errorDetail = detail
    if (status === 'online') void this.bridge.retry()
    this.changed()
  }

  state(): ImChannelState {
    const v = this.values()
    return {
      platform: this.platform,
      status: this.status,
      error: this.error,
      errorDetail: this.errorDetail,
      configured: this.platform === 'qq' ? !!v.appSecret : !!v.token,
      appId: v.appId ?? null,
      accepted: v.accepted === '1',
      bound: !!this.memory().bound,
      qr: this.qr,
      pairing: this.bridge.pairingState(),
      ignored: this.bridge.ignored,
    }
  }

  private build(v: Values): NonNullable<ImChannel['link']> {
    const onMessage = (m: ImInbound): void => void this.bridge.receive(m)
    if (this.platform === 'qq')
      return new QqLink({
        appId: v.appId,
        appSecret: v.appSecret,
        onMessage,
        onStatus: (status, error, detail) => this.setStatus(status, error, detail ?? null),
        publicIp,
      })
    return new WechatLink({
      token: v.token ?? null,
      baseUrl: v.baseUrl ?? null,
      cursor: v.cursor ?? '',
      onMessage,
      onStatus: (status, error) => this.setStatus(status, error),
      onQr: url => {
        this.qr = url
        this.changed()
      },
      onLogin: (token, baseUrl) => this.patch({ token, baseUrl, cursor: '' }),
      onExpired: () => {
        const { token: _token, baseUrl: _baseUrl, cursor: _cursor, enabled: _enabled, ...rest } = this.values()
        this.store.set(this.platform, rest)
      },
      onCursor: cursor => this.patch({ cursor }),
    })
  }

  private run(): void {
    this.link?.stop()
    this.link = this.build(this.values())
    this.link.start()
  }

  /** 上次开着的：启动时接着连 */
  resume(): void {
    const v = this.values()
    if (v.enabled === '1' && v.accepted === '1') this.run()
  }

  connect(input: { accepted: boolean; appId?: string; appSecret?: string }): void {
    if (!this.store.persistent) throw codedError('im.noCipher')
    const v = this.values()
    if (!input.accepted && v.accepted !== '1') throw codedError('im.notAccepted')
    const patch: Values = { accepted: '1', enabled: '1' }
    if (this.platform === 'qq') {
      const appId = input.appId?.trim() || v.appId
      const appSecret = input.appSecret?.trim() || v.appSecret
      if (!appId || !appSecret) throw codedError('im.missing')
      // openid 按机器人分，换了机器人原来绑定的人对不上
      if (v.appId && v.appId !== appId) this.bridge.unbind()
      Object.assign(patch, { appId, appSecret })
    }
    this.patch(patch)
    this.run()
    this.changed()
  }

  private halt(): void {
    this.link?.stop()
    this.link = null
    this.qr = null
    this.bridge.cancelPairing()
    this.status = 'off'
    this.error = null
    this.errorDetail = null
  }

  disconnect(): void {
    this.halt()
    this.patch({ enabled: '' })
    this.changed()
  }

  /** 清掉这个通道的全部东西：凭据、绑定、待发内容、确认记录 */
  forget(): void {
    this.halt()
    this.cache = emptyMemory()
    this.bridge.unbind()
    this.store.remove(this.platform)
    this.cache = emptyMemory()
    this.changed()
  }

  stop(): void {
    this.link?.stop()
    this.link = null
  }
}

export function initIm(ctx: AppContext): void {
  const store = new SecureStore(join(app.getPath('userData'), 'im', 'secrets.json'), systemCipher)
  const host = (): EngineHost => {
    if (!ctx.engine) throw new Error('engine not ready')
    return ctx.engine
  }
  const engine: BridgeEngine = {
    // 固定询问模式；rememberChoices: false 不改用户以后新建对话的默认设置
    create: projectId => host().createSession({ projectId, permissionMode: 'ask', rememberChoices: false }),
    record: id => {
      const record = host().record(id)
      return record && !record.archivedAt ? record : null
    },
    send: (id, message) => host().send(id, message),
    answer: (id, requestId, decision) => host().answer(id, requestId, decision),
    interrupt: id => host().interrupt(id),
    reconnecting: id =>
      !!host()
        .loaded(id)
        ?.queue.some(q => q.reconnect),
  }
  const prefs = (): Values => ({ ...store.get('prefs') })
  const projectId = (): string | null => {
    const id = prefs().projectId
    return id && ctx.engine?.projects().some(p => p.id === id) ? id : null
  }
  const state = (): ImState => ({
    cipher: store.persistent,
    projectId: projectId(),
    projects: (ctx.engine?.projects() ?? []).map(p => ({ id: p.id, name: p.name })),
    channels: IM_PLATFORMS.map(platform => channels[platform].state()),
  })
  const changed = (): void => ctx.events.broadcast('im:changed', state())
  const channels: Record<ImPlatform, ImChannel> = {
    qq: new ImChannel('qq', store, engine, projectId, changed),
    wechat: new ImChannel('wechat', store, engine, projectId, changed),
  }
  const channelOf = (raw: unknown): ImChannel => {
    if (!IM_PLATFORMS.includes(raw as ImPlatform)) throw codedError('im.missing')
    return channels[raw as ImPlatform]
  }
  const field = (raw: unknown): string | undefined => {
    if (raw === undefined || raw === null || raw === '') return undefined
    if (typeof raw !== 'string' || raw.length > FIELD_MAX) throw codedError('im.missing')
    return raw
  }

  ctx.hostListeners.add(event => {
    if (event.kind !== 'session') return
    for (const platform of IM_PLATFORMS) void channels[platform].bridge.onEvent(event.sessionId, event.event)
  })

  ipc.handle('im:state', () => state())
  ipc.handle('im:connect', (_e, platform: unknown, raw: unknown) => {
    const input = object(raw)
    channelOf(platform).connect({
      accepted: input.accepted === true,
      appId: field(input.appId),
      appSecret: field(input.appSecret),
    })
    return state()
  })
  ipc.handle('im:disconnect', (_e, platform: unknown) => {
    channelOf(platform).disconnect()
    return state()
  })
  ipc.handle('im:forget', (_e, platform: unknown) => {
    channelOf(platform).forget()
    return state()
  })
  ipc.handle('im:pairStart', (_e, platform: unknown) => {
    channelOf(platform).bridge.startPairing()
    return state()
  })
  ipc.handle('im:pairCancel', (_e, platform: unknown) => {
    channelOf(platform).bridge.cancelPairing()
    return state()
  })
  ipc.handle('im:unbind', (_e, platform: unknown) => {
    channelOf(platform).bridge.unbind()
    return state()
  })
  ipc.handle('im:setProject', (_e, raw: unknown) => {
    const id = text(raw, 'projectId')
    if (!ctx.engine?.projects().some(p => p.id === id)) throw codedError('im.noProject')
    store.set('prefs', { ...prefs(), projectId: id })
    return state()
  })

  ctx.lifecycle.onShutdown(() => {
    for (const platform of IM_PLATFORMS) channels[platform].stop()
  })
  for (const platform of IM_PLATFORMS) channels[platform].resume()
}
