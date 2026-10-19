import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { keyIdOf, type StoreKey } from './keys'
import { signedText, verifyError, verifyPackage, type VerifyInput } from './verify'

vi.mock('electron', () => ({ app: { isPackaged: true } }))

const SITE = 'https://auth.pixelstarrysky.xyz'
const ID = 'acme.one'
const VERSION = '1.0.0'

interface Pair {
  priv: KeyObject
  publicKey: string
  keyId: string
}
function pair(): Pair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64')
  return { priv: privateKey, publicKey: raw, keyId: keyIdOf(raw)! }
}
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const signWith = (p: Pair, id: string, version: string, shaHex: string): string =>
  sign(null, signedText(id, version, shaHex), p.priv).toString('base64')

function setup(status: StoreKey['status'] = 'active'): {
  p: Pair
  table: StoreKey[]
  bytes: Buffer
  input: VerifyInput
  headers: Record<string, string>
} {
  const p = pair()
  const table: StoreKey[] = [{ keyId: p.keyId, publicKey: p.publicKey, sites: [SITE], status }]
  const bytes = Buffer.from('PK\x03\x04 some zip bytes')
  const hash = sha(bytes)
  const signature = signWith(p, ID, VERSION, hash)
  const headers = {
    'X-Pixelsky-Ext-Sha256': hash,
    'X-Pixelsky-Ext-Signature': signature,
    'X-Pixelsky-Ext-Key-Id': p.keyId,
  }
  const input: VerifyInput = {
    id: ID,
    version: VERSION,
    bytes,
    headers,
    detail: { sha256: hash, signature, keyId: p.keyId },
    site: SITE,
    table,
    dev: { packaged: true, value: undefined },
  }
  return { p, table, bytes, input, headers }
}
const fail = (r: ReturnType<typeof verifyPackage>): string => (r.ok ? 'ok' : r.code)

describe('signedText', () => {
  it('is pixelsky-ext/1 + id + version + sha256, newline separated, no trailing newline', () => {
    const hash = '17553dddad3904010538202fce475ed65519dde2f875cecb319e5a1c1ddedf1c'
    expect(signedText(ID, VERSION, hash).toString()).toBe(`pixelsky-ext/1\nacme.one\n1.0.0\n${hash}`)
  })
})

describe('cross-language vector (Go services/cloud/internal/extensions/sign.go)', () => {
  // 用云端 sign.go 的 Signer 生成：seed = sha256("pixelsky-ext-test-vector")，
  // 被签的 zip = "PK\x03\x04pixelsky test zip bytes"（生成程序见 scratch/2026-10-16-ext-step7/gosign）
  const seed = Buffer.from('3bf6cadda5b762a82cc3eb3dc09f206f3baf0e34e9afa20700b9399f7ff4c0ec', 'hex')
  const publicKey = 'qsiskFKPwV6UBNZBthj2i3KwEstON8tSTo98sZ5CQnA='
  const keyId = '823cb558'
  const zip = Buffer.from('PK\x03\x04pixelsky test zip bytes', 'latin1')
  const zipSha = 'df4b26f84180edb0b721d117cfe4243f5bd84ef6ddc046eb5cdc78375f14f682'
  const goSig = 'SyBFTcX9FKfKIWdkHXRUpzPeZ9voWCOiSBDscq8a6LQnhvxo2gNeUE1COpBVblN4rwoni+do02OXbwU0vqzxAw=='
  const table: StoreKey[] = [{ keyId, publicKey, sites: [SITE], status: 'active' }]
  const base = (): VerifyInput => ({
    id: ID,
    version: VERSION,
    bytes: zip,
    headers: { 'X-Pixelsky-Ext-Sha256': zipSha, 'X-Pixelsky-Ext-Signature': goSig, 'X-Pixelsky-Ext-Key-Id': keyId },
    detail: null,
    site: SITE,
    table,
    dev: { packaged: true, value: undefined },
  })

  it('the key id and public key match what Go computed', () => {
    expect(keyIdOf(publicKey)).toBe(keyId)
    expect(sha(zip)).toBe(zipSha)
  })
  it('node signs the same bytes as Go (Ed25519 is deterministic)', () => {
    // PKCS#8 前缀 + seed
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
    const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    expect(sign(null, signedText(ID, VERSION, zipSha), priv).toString('base64')).toBe(goSig)
  })
  it('verifies the Go signature', () => {
    expect(verifyPackage(base())).toMatchObject({ ok: true, keyId, sha256: zipSha, signature: goSig })
  })
  it('rejects the Go signature for another id / version / byte', () => {
    expect(fail(verifyPackage({ ...base(), id: 'acme.two' }))).toBe('extstore.badSignature')
    expect(fail(verifyPackage({ ...base(), version: '1.0.1' }))).toBe('extstore.badSignature')
    expect(fail(verifyPackage({ ...base(), id: 'acme.one\n1', version: '.0.0' }))).toBe('extstore.badSignature')
    const flipped = Buffer.from(zip)
    flipped[10] ^= 1
    expect(fail(verifyPackage({ ...base(), bytes: flipped }))).toBe('extstore.badSignature')
  })
})

describe('verifyPackage', () => {
  it('accepts a good package, with detail and with headers only', () => {
    const { input } = setup()
    expect(verifyPackage(input)).toMatchObject({ ok: true, keyStatus: 'active' })
    expect(verifyPackage({ ...input, detail: null })).toMatchObject({ ok: true })
  })
  it('reads headers from a Fetch Headers object, case-insensitively', () => {
    const { input, headers } = setup()
    const h = new Headers(headers)
    expect(verifyPackage({ ...input, headers: h })).toMatchObject({ ok: true })
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    expect(verifyPackage({ ...input, headers: lower })).toMatchObject({ ok: true })
  })
  it('accepts a package signed by a verifyOnly key, same as active', () => {
    const { input } = setup('verifyOnly')
    expect(verifyPackage(input)).toMatchObject({ ok: true, keyStatus: 'verifyOnly' })
    expect(verifyPackage({ ...input, detail: null })).toMatchObject({ ok: true, keyStatus: 'verifyOnly' })
  })
  it('rejects a changed byte', () => {
    const { input, bytes } = setup()
    const bad = Buffer.from(bytes)
    bad[bad.length - 1] ^= 1
    expect(verifyPackage({ ...input, bytes: bad })).toMatchObject({ ok: false, code: 'extstore.badSignature' })
  })
  it('rejects a signature made by another key', () => {
    const { input, bytes, headers } = setup()
    const other = pair()
    const signature = signWith(other, ID, VERSION, sha(bytes))
    expect(
      fail(verifyPackage({ ...input, headers: { ...headers, 'X-Pixelsky-Ext-Signature': signature }, detail: null })),
    ).toBe('extstore.badSignature')
  })
  it('rejects a signature for another id or version', () => {
    const { input } = setup()
    expect(fail(verifyPackage({ ...input, id: 'acme.two' }))).toBe('extstore.badSignature')
    expect(fail(verifyPackage({ ...input, version: '1.0.1' }))).toBe('extstore.badSignature')
  })
  it('rejects when headers and detail disagree', () => {
    const { input, headers } = setup()
    const other = pair()
    expect(fail(verifyPackage({ ...input, detail: { ...input.detail!, sha256: 'a'.repeat(64) } }))).toBe(
      'extstore.badSignature',
    )
    expect(fail(verifyPackage({ ...input, detail: { ...input.detail!, keyId: other.keyId } }))).toBe(
      'extstore.badSignature',
    )
    expect(
      fail(verifyPackage({ ...input, detail: { ...input.detail!, signature: signWith(other, ID, VERSION, 'x') } })),
    ).toBe('extstore.badSignature')
    expect(headers['X-Pixelsky-Ext-Sha256']).toBeTruthy()
  })
  it('with no detail, a changed sha256 header is rejected', () => {
    const { input, headers } = setup()
    const flipped = headers['X-Pixelsky-Ext-Sha256'].replace(/^./, c => (c === '0' ? '1' : '0'))
    expect(
      fail(verifyPackage({ ...input, detail: null, headers: { ...headers, 'X-Pixelsky-Ext-Sha256': flipped } })),
    ).toBe('extstore.badSignature')
    expect(fail(verifyPackage({ ...input, detail: null, headers: { ...headers, 'X-Pixelsky-Ext-Sha256': '' } }))).toBe(
      'extstore.badSignature',
    )
    // 大写十六进制也不认：云端发的是小写
    expect(
      fail(
        verifyPackage({
          ...input,
          detail: null,
          headers: { ...headers, 'X-Pixelsky-Ext-Sha256': headers['X-Pixelsky-Ext-Sha256'].toUpperCase() },
        }),
      ),
    ).toBe('extstore.badSignature')
  })
  it('rejects an empty, unknown or revoked key id and never tries other keys', () => {
    const { input, headers, table } = setup()
    expect(fail(verifyPackage({ ...input, detail: null, headers: { ...headers, 'X-Pixelsky-Ext-Key-Id': '' } }))).toBe(
      'extstore.unknownKey',
    )
    const stranger = pair()
    // 签名其实是表里那把钥匙签的；头里写一个不认识的 id 也要拒绝，不能改去试别的钥匙
    expect(
      verifyPackage({ ...input, detail: null, headers: { ...headers, 'X-Pixelsky-Ext-Key-Id': stranger.keyId } }),
    ).toMatchObject({ ok: false, code: 'extstore.unknownKey' })
    const revoked = setup('revoked')
    expect(verifyPackage(revoked.input)).toMatchObject({ ok: false, code: 'extstore.revokedKey' })
    expect(verifyPackage({ ...revoked.input, detail: null })).toMatchObject({ ok: false, code: 'extstore.revokedKey' })
    expect(table).toHaveLength(1)
  })
  it('says unknownSite (with the site) when the site has no keys at all', () => {
    const { input } = setup()
    const r = verifyPackage({ ...input, site: 'http://127.0.0.1:8080' })
    expect(r).toMatchObject({ ok: false, code: 'extstore.unknownSite', params: { site: 'http://127.0.0.1:8080' } })
    // 钥匙在另一个站点下也一样不认
    expect(fail(verifyPackage({ ...input, site: 'https://other.example' }))).toBe('extstore.unknownSite')
  })
  it('accepts a dev key for the current site in an unpackaged build only', () => {
    const { input, p } = setup()
    const local = 'http://127.0.0.1:8080'
    const withDev = { ...input, site: local, table: [], dev: { packaged: false, value: p.publicKey } }
    expect(verifyPackage(withDev)).toMatchObject({ ok: true, keyId: p.keyId })
    expect(fail(verifyPackage({ ...withDev, dev: { packaged: true, value: p.publicKey } }))).toBe(
      'extstore.unknownSite',
    )
  })
  it('does not throw on broken base64 or a wrong signature length', () => {
    const { input, headers } = setup()
    const sigs = [
      '',
      '!!!not base64!!!',
      'AAAA',
      Buffer.alloc(63).toString('base64'),
      Buffer.alloc(65).toString('base64'),
      Buffer.alloc(64).toString('base64').slice(0, -2),
      headers['X-Pixelsky-Ext-Signature'].replace(/=+$/, ''),
      Buffer.alloc(64).toString('base64url') + '-_',
    ]
    for (const s of sigs) {
      const r = verifyPackage({ ...input, detail: null, headers: { ...headers, 'X-Pixelsky-Ext-Signature': s } })
      expect(r.ok, JSON.stringify(s)).toBe(false)
      expect(fail(r)).toBe('extstore.badSignature')
    }
    // 64 字节但不是这把钥匙签的
    const zero = Buffer.alloc(64).toString('base64')
    expect(
      fail(verifyPackage({ ...input, detail: null, headers: { ...headers, 'X-Pixelsky-Ext-Signature': zero } })),
    ).toBe('extstore.badSignature')
  })
  it('does not throw when the table holds a broken public key', () => {
    const { input, p } = setup()
    const table: StoreKey[] = [{ keyId: p.keyId, publicKey: 'AAAA', sites: [SITE], status: 'active' }]
    expect(fail(verifyPackage({ ...input, table }))).toBe('extstore.badSignature')
  })
  it('rejects empty id / version', () => {
    const { input } = setup()
    expect(fail(verifyPackage({ ...input, id: '' }))).toBe('extstore.badSignature')
    expect(fail(verifyPackage({ ...input, version: '' }))).toBe('extstore.badSignature')
  })
})

describe('verifyError', () => {
  it('carries the code (and the site for unknownSite)', () => {
    expect(verifyError({ ok: false, code: 'extstore.badSignature', reason: 'x' }).message).toContain(
      'extstore.badSignature',
    )
    const e = verifyError({ ok: false, code: 'extstore.unknownSite', reason: 'x', params: { site: 'http://a' } })
    expect(e.message).toContain('extstore.unknownSite')
    expect(e.message).toContain('http://a')
  })
})
