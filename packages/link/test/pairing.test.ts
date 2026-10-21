import { describe, expect, it } from 'vitest'
import {
  bridgeApiBase,
  decodeOffer,
  encodeOffer,
  fingerprint,
  fromBase64Url,
  generateKeypair,
  newPairingSecret,
  pairRequest,
  toBase64Url,
  utf8,
  verifyPairRequest,
  type PairingOffer,
} from '../src'

const desk = generateKeypair(),
  phone = generateKeypair()
const offer: PairingOffer = {
  v: 1,
  relay: 'wss://auth.example/v1/bridge/ws',
  desktop: 'd-1',
  key: toBase64Url(desk.publicKey),
  secret: newPairingSecret(),
  name: '我的电脑',
  expires: 1_800_000_000_000,
}

describe('pairing', () => {
  it('round-trips base64url of every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255)
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes)
    }
    expect(() => fromBase64Url('a+b=')).toThrow('LINK_BAD_ENCODING')
  })

  it('round-trips the QR text and rejects other text', () => {
    expect(decodeOffer(encodeOffer(offer))).toEqual(offer)
    expect(() => decodeOffer('https://example.com')).toThrow('LINK_BAD_OFFER')
    expect(() => decodeOffer('pixelsky://pair?d=' + toBase64Url(utf8('{"v":2}')))).toThrow('LINK_BAD_OFFER')
    // 解出来不是对象（null、数字、数组）：同样是 LINK_BAD_OFFER，不是 TypeError
    for (const json of ['null', '1', '[]', '"x"'])
      expect(() => decodeOffer('pixelsky://pair?d=' + toBase64Url(utf8(json)))).toThrow('LINK_BAD_OFFER')
  })

  it('accepts a request made with the QR secret only', () => {
    const request = pairRequest(offer, phone.publicKey, ' 小米 14' + String.fromCharCode(7) + ' ')
    expect(request.name).toBe('小米 14')
    expect(verifyPairRequest(request, offer.secret, desk.publicKey)).toEqual({
      publicKey: phone.publicKey,
      name: '小米 14',
    })
    // 别的密钥、改过的名字或公钥、给别的电脑的请求都不行
    expect(verifyPairRequest(request, newPairingSecret(), desk.publicKey)).toBeNull()
    expect(verifyPairRequest({ ...request, name: 'iPhone' }, offer.secret, desk.publicKey)).toBeNull()
    expect(
      verifyPairRequest({ ...request, key: toBase64Url(generateKeypair().publicKey) }, offer.secret, desk.publicKey),
    ).toBeNull()
    expect(verifyPairRequest(request, offer.secret, generateKeypair().publicKey)).toBeNull()
    expect(verifyPairRequest({ key: 1 }, offer.secret, desk.publicKey)).toBeNull()
    expect(verifyPairRequest(null, offer.secret, desk.publicKey)).toBeNull()
  })

  it('derives the cloud API from the relay and accepts a pairing code', () => {
    expect(bridgeApiBase('wss://auth.example/v1/bridge/ws')).toBe('https://auth.example')
    expect(bridgeApiBase('ws://127.0.0.1:9080/v1/bridge/ws')).toBe('http://127.0.0.1:9080')
    expect(decodeOffer(encodeOffer({ ...offer, code: 'abc' })).code).toBe('abc')
    expect(() => decodeOffer(encodeOffer({ ...offer, code: 1 as never }))).toThrow('LINK_BAD_OFFER')
  })

  it('encodes the offer as a web link the phone camera can open', () => {
    const link = encodeOffer(offer, 'https://auth.example/m/#old')
    expect(link.startsWith('https://auth.example/m/#pair=')).toBe(true)
    expect(decodeOffer(link)).toEqual(offer)
    expect(() => decodeOffer('https://auth.example/m/#other=1')).toThrow('LINK_BAD_OFFER')
  })

  it('shows a short fingerprint', () => {
    expect(fingerprint(desk.publicKey)).toMatch(/^[0-9A-F]{4}(·[0-9A-F]{4}){3}$/)
  })
})
