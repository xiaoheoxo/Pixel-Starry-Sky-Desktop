import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Cipher } from '../core/secure-store'
import { MAX_DEVICES, MobileStore } from './store'

const defaults = { enabled: false, relay: '', keepAwake: false }
const cipher = (available = true): Cipher => ({
  available: () => available,
  encrypt: text => Buffer.from(text).toString('base64'),
  decrypt: text => Buffer.from(text, 'base64').toString(),
})
const device = (id: string) => ({ id, name: id, publicKey: 'AAAA', access: 'act' as const, pairedAt: 1 })

let dir = ''
beforeEach(async () => {
  const scratch = resolve('../../scratch')
  await mkdir(scratch, { recursive: true })
  dir = await mkdtemp(join(scratch, 'mobile-store-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('MobileStore', () => {
  it('keeps the desktop id, key, prefs and devices across restarts', async () => {
    const a = new MobileStore(dir, cipher(), defaults)
    const key = a.keypair()!
    a.setPrefs({ enabled: true, relay: ' ws://127.0.0.1:47812 ' })
    a.addDevice(device('p1'))
    a.touch('p1', 42)
    const b = new MobileStore(dir, cipher(), defaults)
    expect(b.desktopId).toBe(a.desktopId)
    expect(b.keypair()!.publicKey).toEqual(key.publicKey)
    expect(b.prefs).toEqual({ enabled: true, relay: 'ws://127.0.0.1:47812', keepAwake: false })
    expect(b.devices).toEqual([{ ...device('p1'), lastSeenAt: 42 }])
    // 私钥不在明文文件里
    expect(await readFile(join(dir, 'devices.json'), 'utf8')).not.toContain('privateKey')
  })

  it('refuses to pair without system encryption', () => {
    const store = new MobileStore(dir, cipher(false), defaults)
    expect(store.keypair()).toBeNull()
    expect(store.fingerprint()).toBeNull()
  })

  it('forgets paired phones when the desktop key had to be replaced', async () => {
    const a = new MobileStore(dir, cipher(), defaults)
    a.keypair()
    a.addDevice(device('p1'))
    await rm(join(dir, 'secrets.json'))
    const b = new MobileStore(dir, cipher(), defaults)
    expect(b.devices).toHaveLength(1)
    b.keypair()
    expect(b.devices).toEqual([])
  })

  it('starts over with a new desktop id when the account changes', () => {
    const store = new MobileStore(dir, cipher(), defaults)
    expect(store.bindAccount('Amy@x.com')).toBe(false)
    store.addDevice(device('p1'))
    const id = store.desktopId
    expect(store.bindAccount('amy@x.com')).toBe(false)
    expect(store.bindAccount('bob@x.com')).toBe(true)
    expect(store.desktopId).not.toBe(id)
    expect(store.devices).toEqual([])
    expect(new MobileStore(dir, cipher(), defaults).account).toBe('bob@x.com')
  })

  it('validates prefs, access and the device limit', () => {
    const store = new MobileStore(dir, cipher(), defaults)
    expect(() => store.setPrefs({ relay: 'http://example.com' })).toThrow('MOBILE_BAD_RELAY')
    expect(() => store.setPrefs({ relay: 'wss://relay.example/ws#x' })).toThrow('MOBILE_BAD_RELAY')
    for (let i = 0; i < MAX_DEVICES; i++) store.addDevice(device('p' + i))
    expect(() => store.addDevice(device('extra'))).toThrow('MOBILE_TOO_MANY_DEVICES')
    store.addDevice(device('p0'))
    expect(store.setAccess('p1', 'view').access).toBe('view')
    expect(() => store.setAccess('p1', 'admin')).toThrow('MOBILE_NO_DEVICE')
    expect(store.removeDevice('p1')).toBe(true)
    expect(store.removeDevice('p1')).toBe(false)
  })
})
