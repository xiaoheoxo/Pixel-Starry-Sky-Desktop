import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DEV_KEYS_ENV, STORE_KEYS, keyIdOf, keyStatus, keysForSite, siteOrigin, type StoreKey } from './keys'

vi.mock('electron', () => ({ app: { isPackaged: true } }))

const SITE = 'https://auth.pixelstarrysky.xyz'

function newKey(): { publicKey: string; keyId: string } {
  const { publicKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64')
  return { publicKey: raw, keyId: keyIdOf(raw)! }
}
const row = (site: string, status: StoreKey['status'] = 'active'): StoreKey => ({ ...newKey(), sites: [site], status })

describe('STORE_KEYS', () => {
  it('has one active key per site: the test site and the production site', () => {
    expect(STORE_KEYS).toEqual([
      {
        keyId: '8273f03a',
        publicKey: 'z+QHBZ24TLfmMDcrApDCKzSk4VYBsmYYpfDn6jInMjU=',
        sites: [SITE],
        status: 'active',
      },
      {
        keyId: '4f9edb34',
        publicKey: '89lbJp/zJJSNBbrcD7tCIhJFMfXO3mtdaQDs0/6RHzY=',
        sites: ['https://pixelstarrysky.xyz'],
        status: 'active',
      },
    ])
    for (const k of STORE_KEYS) expect(keyIdOf(k.publicKey)).toBe(k.keyId)
  })
  it('keyId is the first 8 hex chars of SHA-256 of the 32 raw public key bytes', () => {
    for (const k of STORE_KEYS) {
      const raw = Buffer.from(k.publicKey, 'base64')
      expect(raw).toHaveLength(32)
      expect(k.keyId).toBe(createHash('sha256').update(raw).digest('hex').slice(0, 8))
      expect(keyIdOf(k.publicKey)).toBe(k.keyId)
    }
  })
  it('sites are canonical origins, no duplicate key on one site, status is one of three, no private key', () => {
    const seen = new Set<string>()
    for (const k of STORE_KEYS) {
      expect(k.sites.length).toBeGreaterThan(0)
      for (const s of k.sites) {
        expect(s).toBe(new URL(s).origin)
        expect(seen.has(`${s}|${k.keyId}`)).toBe(false)
        seen.add(`${s}|${k.keyId}`)
      }
      expect(['active', 'verifyOnly', 'revoked']).toContain(k.status)
      expect(Object.keys(k).sort()).toEqual(['keyId', 'publicKey', 'sites', 'status'])
      // 公钥是 32 字节；私钥（PKCS8 / 64 字节）放进来这里就会挂
      expect(Buffer.from(k.publicKey, 'base64')).toHaveLength(32)
    }
  })
})

describe('keyIdOf', () => {
  it('rejects anything that is not 32 raw bytes in standard base64', () => {
    expect(keyIdOf('')).toBeNull()
    expect(keyIdOf('AAAA')).toBeNull()
    expect(keyIdOf(Buffer.alloc(64).toString('base64'))).toBeNull()
    expect(keyIdOf('not base64!!')).toBeNull()
  })
})

describe('keysForSite', () => {
  const dev = { packaged: true, value: undefined }
  it('picks the production key for the production site only', () => {
    expect(keysForSite(SITE, undefined, dev).map(k => k.keyId)).toEqual(['8273f03a'])
    expect(keysForSite('http://127.0.0.1:8080', undefined, dev)).toEqual([])
    expect(keysForSite('https://other.example', undefined, dev)).toEqual([])
    expect(keysForSite('', undefined, dev)).toEqual([])
    expect(keysForSite('not a url', undefined, dev)).toEqual([])
  })
  it('normalizes paths, trailing slashes and case to the origin', () => {
    for (const s of [`${SITE}/`, `${SITE}/cloud/api`, 'HTTPS://AUTH.PIXELSTARRYSKY.XYZ/x?y=1', `${SITE}:443`])
      expect(
        keysForSite(s, undefined, dev).map(k => k.keyId),
        s,
      ).toEqual(['8273f03a'])
    expect(siteOrigin('http://127.0.0.1:8080/a')).toBe('http://127.0.0.1:8080')
    expect(siteOrigin('file:///x')).toBe('')
  })
  it('gives each site of a two-site table only its own rows', () => {
    const a = row('https://a.example'),
      b = row('http://127.0.0.1:8080', 'verifyOnly'),
      c = row('https://a.example', 'revoked')
    const table = [a, b, c]
    expect(keysForSite('https://a.example/x', table, dev)).toEqual([a, c])
    expect(keysForSite('http://127.0.0.1:8080/', table, dev)).toEqual([b])
    expect(keysForSite('https://c.example', table, dev)).toEqual([])
  })
})

describe('keyStatus', () => {
  const dev = { packaged: true, value: undefined }
  it('reports all four states per site', () => {
    const act = row('https://a.example', 'active'),
      old = row('https://a.example', 'verifyOnly'),
      rev = row('https://a.example', 'revoked'),
      other = row('https://b.example', 'active')
    const table = [act, old, rev, other]
    expect(keyStatus(act.keyId, 'https://a.example', table, dev)).toBe('active')
    expect(keyStatus(old.keyId, 'https://a.example', table, dev)).toBe('verifyOnly')
    expect(keyStatus(rev.keyId, 'https://a.example', table, dev)).toBe('revoked')
    expect(keyStatus(other.keyId, 'https://a.example', table, dev)).toBe('unknown')
    expect(keyStatus('', 'https://a.example', table, dev)).toBe('unknown')
    expect(keyStatus('8273f03a', 'http://127.0.0.1:8080', undefined, dev)).toBe('unknown')
  })
})

describe('dev keys (PIXELSKY_EXT_DEV_KEYS)', () => {
  const k1 = newKey(),
    k2 = newKey()
  const value = `${k1.publicKey}, ${k2.publicKey},garbage,${k1.publicKey}`
  it('is named as planned', () => expect(DEV_KEYS_ENV).toBe('PIXELSKY_EXT_DEV_KEYS'))
  it('adds active keys for the current site only, in an unpackaged build', () => {
    const local = keysForSite('http://127.0.0.1:8080', undefined, { packaged: false, value })
    expect(local.map(k => k.keyId)).toEqual([k1.keyId, k2.keyId])
    expect(local.every(k => k.status === 'active' && k.sites[0] === 'http://127.0.0.1:8080')).toBe(true)
    // 生产站也只会多出这一次调用里指定站点的钥匙，别的站点不受影响
    const prod = keysForSite(SITE, undefined, { packaged: false, value })
    expect(prod.map(k => k.keyId)).toEqual(['8273f03a', k1.keyId, k2.keyId])
    expect(keysForSite('', undefined, { packaged: false, value })).toEqual([])
  })
  it('is ignored in a packaged build and when unset', () => {
    expect(keysForSite('http://127.0.0.1:8080', undefined, { packaged: true, value })).toEqual([])
    expect(keysForSite('http://127.0.0.1:8080', undefined, { packaged: false, value: undefined })).toEqual([])
    expect(keysForSite('http://127.0.0.1:8080', undefined, { packaged: false, value: '' })).toEqual([])
  })
  it('does not override or duplicate a key already in the table', () => {
    const revoked: StoreKey = { ...k1, sites: ['http://127.0.0.1:8080'], status: 'revoked' }
    const got = keysForSite('http://127.0.0.1:8080', [revoked], { packaged: false, value: k1.publicKey })
    expect(got).toEqual([revoked])
  })
  it('reads the real environment and app.isPackaged by default', () => {
    // electron 被替换成 isPackaged:true，所以默认来源下环境变量不生效
    vi.stubEnv(DEV_KEYS_ENV, k1.publicKey)
    try {
      expect(keysForSite('http://127.0.0.1:8080')).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
