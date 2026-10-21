// 手机端的本机数据（docs/mobile-remote.md §4、§5.1）：
// - 电脑的长期私钥：系统加密保存（<userData>/mobile/secrets.json）；系统加密不可用时不生成，不能配对；
// - 电脑 ID、偏好、已配对的手机（只有公钥和名字）：明文 <userData>/mobile/devices.json。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fingerprint, fromBase64Url, generateKeypair, keypairFrom, toBase64Url, type Keypair } from '@pixelsky/link'
import { SecureStore, type Cipher } from '../core/secure-store'
import type { MobileAccess, MobilePrefs } from '../../shared/types/mobile'

export interface StoredDevice {
  id: string
  name: string
  /** 手机长期公钥（base64url） */
  publicKey: string
  access: MobileAccess
  pairedAt: number
  lastSeenAt: number | null
}

interface StoreFile {
  version: 1
  desktopId: string
  /** 电脑 ID 在云端归属的账号（邮箱）；换账号时换电脑 ID */
  account?: string | null
  prefs: MobilePrefs
  devices: StoredDevice[]
}

/** 最多配几部手机（云端也有同样的上限） */
export const MAX_DEVICES = 5

const isAccess = (v: unknown): v is MobileAccess => v === 'view' || v === 'act'

function readDevices(raw: unknown): StoredDevice[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (d): d is StoredDevice =>
        !!d &&
        typeof d.id === 'string' &&
        typeof d.name === 'string' &&
        typeof d.publicKey === 'string' &&
        isAccess(d.access) &&
        typeof d.pairedAt === 'number',
    )
    .slice(0, MAX_DEVICES)
    .map(d => ({ ...d, lastSeenAt: typeof d.lastSeenAt === 'number' ? d.lastSeenAt : null }))
}

export class MobileStore {
  desktopId: string
  account: string | null
  prefs: MobilePrefs
  devices: StoredDevice[]
  private readonly file: string
  private readonly secrets: SecureStore
  private key: Keypair | null = null

  constructor(
    private readonly dir: string,
    cipher: Cipher,
    defaults: MobilePrefs,
  ) {
    this.file = join(dir, 'devices.json')
    this.secrets = new SecureStore(join(dir, 'secrets.json'), cipher)
    let saved: Partial<StoreFile> = {}
    try {
      if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {}
    const p = (saved.prefs ?? {}) as Partial<MobilePrefs>
    this.desktopId = typeof saved.desktopId === 'string' && saved.desktopId ? saved.desktopId : randomUUID()
    this.account = typeof saved.account === 'string' ? saved.account : null
    this.prefs = {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : defaults.enabled,
      relay: typeof p.relay === 'string' && p.relay ? p.relay : defaults.relay,
      keepAwake: typeof p.keepAwake === 'boolean' ? p.keepAwake : defaults.keepAwake,
    }
    this.devices = readDevices(saved.devices)
    if (!saved.desktopId) this.save()
  }

  /** 电脑的长期密钥；第一次用时生成。系统加密不可用时为 null（重启就丢的密钥会让已配对的手机失效，干脆不给配） */
  keypair(): Keypair | null {
    if (this.key) return this.key
    if (!this.secrets.persistent) return null
    const saved = this.secrets.get('desktop')?.privateKey
    if (saved) {
      try {
        this.key = keypairFrom(fromBase64Url(saved))
        return this.key
      } catch {}
    }
    // 私钥换了，以前配对的手机都握不了手，一起清掉
    this.key = generateKeypair()
    this.secrets.set('desktop', { privateKey: toBase64Url(this.key.privateKey) })
    if (this.devices.length) {
      this.devices = []
      this.save()
    }
    return this.key
  }

  fingerprint(): string | null {
    const key = this.keypair()
    return key ? fingerprint(key.publicKey) : null
  }

  device(id: string): StoredDevice | undefined {
    return this.devices.find(d => d.id === id)
  }

  /**
   * 记下这台电脑在云端归哪个账号。换了账号（云端认电脑 ID 的主人）就换一个电脑 ID，原来配对的手机作废。
   * 返回 true 表示换了。
   */
  bindAccount(email: string): boolean {
    const account = email.trim().toLowerCase()
    if (this.account === account) return false
    const changed = this.account !== null
    if (changed) {
      this.desktopId = randomUUID()
      this.devices = []
    }
    this.account = account
    this.save()
    return changed
  }

  setPrefs(patch: Partial<MobilePrefs>): MobilePrefs {
    const next = { ...this.prefs }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (typeof patch.keepAwake === 'boolean') next.keepAwake = patch.keepAwake
    if (typeof patch.relay === 'string') {
      const relay = patch.relay.trim()
      // 不收 # 片段：WebSocket 地址带片段时 new WebSocket 直接抛错
      if (relay && !/^wss?:\/\/[^\s#]+$/.test(relay)) throw new Error('MOBILE_BAD_RELAY')
      next.relay = relay
    }
    this.prefs = next
    this.save()
    return next
  }

  addDevice(device: Omit<StoredDevice, 'lastSeenAt'>): StoredDevice {
    if (!this.device(device.id) && this.devices.length >= MAX_DEVICES) throw new Error('MOBILE_TOO_MANY_DEVICES')
    const stored = { ...device, lastSeenAt: null }
    this.devices = [...this.devices.filter(d => d.id !== device.id), stored]
    this.save()
    return stored
  }

  removeDevice(id: string): boolean {
    const before = this.devices.length
    this.devices = this.devices.filter(d => d.id !== id)
    if (this.devices.length === before) return false
    this.save()
    return true
  }

  setAccess(id: string, access: unknown): StoredDevice {
    const device = this.device(id)
    if (!device || !isAccess(access)) throw new Error('MOBILE_NO_DEVICE')
    device.access = access
    this.save()
    return device
  }

  touch(id: string, now: number): void {
    const device = this.device(id)
    if (!device) return
    device.lastSeenAt = now
    this.save()
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true })
    const data: StoreFile = {
      version: 1,
      desktopId: this.desktopId,
      account: this.account,
      prefs: this.prefs,
      devices: this.devices,
    }
    const temp = this.file + '.tmp'
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
    try {
      renameSync(temp, this.file)
    } catch (err) {
      rmSync(temp, { force: true })
      throw err
    }
  }
}
