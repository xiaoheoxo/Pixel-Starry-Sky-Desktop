// 给手机 App（Flutter，apps/app）导出共用测试样例（docs/mobile-app.md §5.2）：结果都由这里的 TS 实现算出，
// Dart 测试（apps/app/test/link/）读同一批样例逐项比对，哪一边改了行为都会有一边的测试失败。
// 平时只比较，样例不是最新就失败；改了 link 之后运行 node scripts/export-app-fixtures.mjs 重写（APP_FIXTURES_UPDATE=1）。
// 样例必须确定：密钥由固定标签算出，输入都写死，不用随机数。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import {
  BRIDGE_PROTOCOL,
  CipherState,
  FrameType,
  Initiator,
  LINK_VERSION,
  MAX_FRAME,
  MAX_PAYLOAD,
  PROLOGUE,
  Responder,
  RpcCore,
  SecureChannel,
  bridgeApiBase,
  bridgeProtocols,
  concat,
  decodeFrame,
  decodeJson,
  decodeOffer,
  encodeFrame,
  encodeJson,
  encodeOffer,
  fingerprint,
  fromBase64Url,
  fromUtf8,
  keypairFrom,
  newPairingSecret,
  pairRequest,
  toBase64Url,
  toHex,
  utf8,
  verifyPairRequest,
  type Codec,
  type HandshakeResult,
  type Keypair,
  type PairStatus,
  type PairingOffer,
  type RpcMessage,
} from '../src'
import { RPC_SIZE_LIMIT } from '../src/rpc'
import vector from './noise-kk-vector.json'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'app', 'test', 'fixtures')
const UPDATE = process.env.APP_FIXTURES_UPDATE === '1'
const GENERATED_BY = '由 packages/link/test/app-fixtures.test.ts 生成（node scripts/export-app-fixtures.mjs），不要手改'

const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], b => parseInt(b, 16))
/** 固定的 32 字节：按标签算，每次生成都一样 */
const fixed = (label: string) => sha256(utf8('pixelsky-app-fixture/' + label))
const errorOf = (f: () => unknown): string | null => {
  try {
    f()
    return null
  } catch (e) {
    return (e as Error).message
  }
}
const flip = (bytes: Uint8Array, at: number) => {
  const out = bytes.slice()
  out[at] ^= 1
  return out
}
const settle = () => new Promise(r => setTimeout(r, 0))
/** CipherState 的密钥是私有字段；样例要记下双方算出的密钥，只在这里读一下 */
const keyOf = (state: CipherState) => (state as unknown as { key: Uint8Array }).key

function readStored(name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(OUT, name), 'utf8'))
  } catch {
    return null
  }
}

function check(name: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2) + '\n'
  const file = join(OUT, name)
  if (UPDATE) {
    mkdirSync(OUT, { recursive: true })
    writeFileSync(file, text)
    return
  }
  const old = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null
  if (old === text) return
  // 不贴整份差异（有几十 KB 的十六进制），只指出第一处不同
  const lines = text.split('\n')
  const at = old === null ? 0 : old.split('\n').findIndex((line, i) => line !== lines[i]) + 1
  throw new Error(
    `apps/app/test/fixtures/${name} ${old === null ? '不存在' : `不是最新（第 ${at} 行起不同）`}：` +
      '运行 node scripts/export-app-fixtures.mjs 重新导出，再到 apps/app 跑 flutter test',
  )
}

// ---- 固定密钥 ----
const phone = keypairFrom(fixed('phone-static'))
const desk = keypairFrom(fixed('desktop-static'))
const mallory = keypairFrom(fixed('mallory-static'))
const phoneE = keypairFrom(fixed('phone-ephemeral'))
const deskE = keypairFrom(fixed('desktop-ephemeral'))
const EMPTY: Uint8Array = new Uint8Array(0)

// ---- bytes ----
function bytesFixture() {
  const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255)
  const decodeTexts = [
    '',
    'AA',
    'AB',
    'AP',
    'AAA',
    'AAB',
    '_-8',
    'A',
    'AAAAA',
    'a+b=',
    'ab=',
    'AA==',
    ' ab',
    'ab\n',
    'é',
  ]
  const utf8Hex = [
    '',
    '41',
    'e4b8ade69687',
    'f09f9880',
    'efbbbf41',
    'efbbbfefbbbf41',
    '41efbbbf',
    'ff',
    '80',
    'c3',
    'c0af',
    'e4b8',
    'eda080',
    'f4908080',
  ]
  return {
    generated_by: GENERATED_BY,
    base64url: Array.from({ length: 41 }, (_, n) => ({ hex: toHex(pattern(n)), text: toBase64Url(pattern(n)) })),
    base64url_decode: decodeTexts.map(text => {
      const error = errorOf(() => fromBase64Url(text))
      return error ? { text, error } : { text, hex: toHex(fromBase64Url(text)) }
    }),
    // 解不开时 TS 抛 TextDecoder 的 TypeError（不是协议错误码），这里只记「解不开」
    utf8_decode: utf8Hex.map(h =>
      errorOf(() => fromUtf8(hex(h))) ? { hex: h, invalid: true } : { hex: h, text: fromUtf8(hex(h)) },
    ),
    utf8_encode: ['', 'abc', '中文', '😀', 'a\ud83d', '\udc00b', '\u0000', '﻿'].map(text => ({
      text,
      hex: toHex(utf8(text)),
    })),
  }
}

// ---- frame ----
function framesFixture() {
  const large = (length: number, f: () => unknown) => {
    const error = errorOf(f)
    return error ? { length, error } : { length }
  }
  const decodeHex = ['01', '03616263', '0500ff', '00', '06', '07', 'ff', '']
  const jsonTexts = [
    '{}',
    ' {"a":[1,2,{"b":null}]} ',
    'null',
    '"x"',
    '1.5',
    '-3',
    '-0',
    '{"a":1,"a":2}',
    '"\\ud83d"',
    '"\\u4e2d\\n"',
    '[1,]',
    '{bad',
    '',
    'undefined',
    "'x'",
    'NaN',
    '01',
    '1.',
    '.5',
    '"\t"',
    '{"a":1}x',
    ' {}',
  ]
  const jsonBytes = [
    ...jsonTexts.map(t => utf8(t)),
    concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8('{"x":1}')),
    concat(Uint8Array.of(0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf), utf8('{}')),
    Uint8Array.of(0xff),
  ]
  return {
    generated_by: GENERATED_BY,
    constants: { max_frame: MAX_FRAME, max_payload: MAX_PAYLOAD, types: FrameType },
    encode: Object.values(FrameType).flatMap(type =>
      ['', '616263', '00ff'].map(body => ({ type, body, frame: toHex(encodeFrame(type, hex(body))) })),
    ),
    // 大帧不写进文件：内容是第 1 字节 3、其余全是 7
    encode_large: [MAX_FRAME - 1, MAX_FRAME].map(n =>
      large(n, () => expect(encodeFrame(FrameType.Data, new Uint8Array(n).fill(7)).length).toBe(n + 1)),
    ),
    decode: decodeHex.map(h => {
      const error = errorOf(() => decodeFrame(hex(h)))
      if (error) return { frame: h, error }
      const { type, body } = decodeFrame(hex(h))
      return { frame: h, type, body: toHex(body) }
    }),
    decode_large: [MAX_FRAME, MAX_FRAME + 1].map(n =>
      large(n, () => {
        const frame = new Uint8Array(n).fill(7)
        frame[0] = FrameType.Data
        expect(decodeFrame(frame).body.length).toBe(n - 1)
      }),
    ),
    json_decode: jsonBytes.map(b => {
      const error = errorOf(() => decodeJson(b))
      return error ? { hex: toHex(b), error } : { hex: toHex(b), value: decodeJson(b) }
    }),
    json_encode: [
      { n: 1 },
      '中文😀',
      'a"b\\c\n\t\u0001\u001f\u007f /',
      'x\ud83dy',
      [1, -2, 1.5, 0.1, 1e21, 123456789, true, false, null],
      { nested: { k: ['x', {}] }, empty: [] },
    ].map(value => ({ value, hex: toHex(encodeJson(value)) })),
  }
}

// ---- pairing ----
// PairStatus 只是类型：加减状态时这里编译不过，提醒同时改 App
const PAIR_STATUSES = {
  pending: 0,
  accepted: 0,
  rejected: 0,
  expired: 0,
  unknown: 0,
  unavailable: 0,
  handshake_failed: 0,
} satisfies Record<PairStatus, 0>

function pairingFixture() {
  const offer: PairingOffer = {
    v: LINK_VERSION,
    relay: 'wss://auth.example/v1/bridge/ws',
    desktop: 'd-1',
    key: toBase64Url(desk.publicKey),
    secret: toBase64Url(fixed('pairing-secret').slice(0, 16)),
    name: '我的电脑',
    expires: 1_800_000_000_000,
  }
  const withCode: PairingOffer = { ...offer, code: 'c0de' }
  const offerJson = JSON.stringify(offer)
  const link = encodeOffer(offer)
  const d = (o: unknown) => 'pixelsky://pair?d=' + toBase64Url(utf8(JSON.stringify(o)))
  const decodeTexts: [string, string][] = [
    ['app_link', link],
    ['with_code', encodeOffer(withCode)],
    ['web_link', encodeOffer(offer, 'https://auth.example/m/')],
    ['http_web_link', encodeOffer(withCode, 'http://192.168.1.5:9080/m/?a=1')],
    ['surrounding_whitespace', '  \n' + link + '\t '],
    ['ideographic_space', '　' + link + '　'],
    ['nel_not_trimmed', '\u0085' + link],
    ['extra_field', d({ ...offer, extra: 1 })],
    ['bom_json', 'pixelsky://pair?d=' + toBase64Url(concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8(offerJson)))],
    ['relay_ws', d({ ...offer, relay: 'ws://127.0.0.1:9080/v1/bridge/ws' })],
    ['relay_prefix_only', d({ ...offer, relay: 'ws://' })],
    ['float_version', 'pixelsky://pair?d=' + toBase64Url(utf8(offerJson.replace('"v":1', '"v":1.0')))],
    ['float_expires', d({ ...offer, expires: 1.5 })],
    ['plain_url', 'https://example.com'],
    ['other_fragment', 'https://auth.example/m/#other=1'],
    ['upper_case_scheme', link.replace('pixelsky://', 'PIXELSKY://')],
    ['upper_case_https', encodeOffer(offer, 'HTTPS://auth.example/m/')],
    ['space_in_url', 'https://auth example/m/#pair=' + toBase64Url(utf8(offerJson))],
    ['empty_data', 'pixelsky://pair?d='],
    ['bad_base64_length', 'pixelsky://pair?d=A'],
    ['padding', link + '='],
    ['trailing_text', link + ' x'],
    ['bad_utf8', 'pixelsky://pair?d=' + toBase64Url(Uint8Array.of(0xff, 0xfe))],
    ['not_json', 'pixelsky://pair?d=' + toBase64Url(utf8('{bad'))],
    ['null', d(null)],
    ['number', d(1)],
    ['array', d([])],
    ['string', d('x')],
    ['true', d(true)],
    ['empty_object', d({})],
    ['version_2', d({ ...offer, v: 2 })],
    ['version_string', d({ ...offer, v: '1' })],
    ['relay_https', d({ ...offer, relay: 'https://auth.example' })],
    ['missing_name', d({ ...offer, name: undefined })],
    ['name_number', d({ ...offer, name: 1 })],
    ['key_number', d({ ...offer, key: 1 })],
    ['expires_string', d({ ...offer, expires: '1800000000000' })],
    ['code_null', d({ ...offer, code: null })],
    ['code_number', d({ ...offer, code: 1 })],
  ]
  const names = [
    ' 小米 14' + String.fromCharCode(7) + ' ',
    'iPhone',
    '',
    '   ',
    'a\u0000b\u001fc\u007fd',
    '　名字　',
    '\u0085NEL\u0085',
    '﻿BOM ',
    ' 行 ',
    'x'.repeat(100),
    'y'.repeat(63) + '😀z',
  ]
  const good = pairRequest(offer, phone.publicKey, names[0])
  const other = keypairFrom(fixed('other-phone'))
  const shortKey = phone.publicKey.slice(0, 31)
  const verifyCases: [string, unknown, string?, Uint8Array?][] = [
    ['valid', good],
    ['other_secret', good, toBase64Url(fixed('other-secret').slice(0, 16))],
    ['name_changed', { ...good, name: 'iPhone' }],
    ['key_changed', { ...good, key: toBase64Url(other.publicKey) }],
    ['other_desktop', good, undefined, mallory.publicKey],
    ['mac_of_other_request', { ...good, mac: pairRequest(offer, other.publicKey, good.name).mac }],
    ['mac_truncated', { ...good, mac: good.mac.slice(0, 20) }],
    ['key_not_string', { key: 1 }],
    ['null', null],
    ['array', []],
    ['string', 'text'],
    ['untrimmed_name', { ...good, name: ' 小米 14 ' }],
    ['missing_name', { key: good.key, mac: pairRequest(offer, phone.publicKey, '').mac }],
    ['empty_name', pairRequest(offer, phone.publicKey, '')],
    ['short_key', { key: toBase64Url(shortKey), name: 'x', mac: pairRequest(offer, shortKey, 'x').mac }],
    ['bad_mac_encoding', { ...good, mac: 'a+b' }],
    ['bad_secret_encoding', good, 'a+b'],
    ['name_64', pairRequest(offer, phone.publicKey, 'n'.repeat(64))],
    ['name_65', { key: good.key, name: 'n'.repeat(65), mac: pairRequest(offer, phone.publicKey, 'n'.repeat(65)).mac }],
    ['lone_surrogate_name', pairRequest(offer, phone.publicKey, names[10])],
    ['extra_fields', { ...good, extra: true }],
    ['empty_secret', pairRequest({ ...offer, secret: '' }, phone.publicKey, 'x'), ''],
  ]
  return {
    generated_by: GENERATED_BY,
    constants: {
      link_version: LINK_VERSION,
      prologue: { text: fromUtf8(PROLOGUE), hex: toHex(PROLOGUE) },
      bridge_protocol: BRIDGE_PROTOCOL,
      bridge_protocols: { token: 'tok.123', protocols: bridgeProtocols('tok.123') },
      pair_statuses: Object.keys(PAIR_STATUSES),
      pairing_secret_bytes: fromBase64Url(newPairingSecret()).length,
    },
    keys: { desktop: toHex(desk.publicKey), phone: toHex(phone.publicKey) },
    offer,
    encode: (
      [
        [offer, undefined],
        [withCode, undefined],
        [{ ...offer, name: 'A "q" \\ \n😀 ' }, undefined],
        [offer, ''],
        [offer, 'https://auth.example/m/'],
        [offer, 'https://auth.example/m/#old'],
        [withCode, 'http://192.168.1.5:9080/m/?a=1#x#y'],
      ] as [PairingOffer, string | undefined][]
    ).map(([o, web]) => ({ offer: o, web: web ?? null, text: encodeOffer(o, web) })),
    decode: decodeTexts.map(([name, text]) => {
      const error = errorOf(() => decodeOffer(text))
      return error ? { name, text, error } : { name, text, offer: decodeOffer(text) }
    }),
    pair_requests: names.map(name => ({ name, request: pairRequest(offer, phone.publicKey, name) })),
    verify: verifyCases.map(([name, raw, secret = offer.secret, desktop = desk.publicKey]) => {
      const r = verifyPairRequest(raw, secret, desktop)
      return {
        name,
        raw,
        secret,
        desktop_public: toHex(desktop),
        result: r ? { public_key: toHex(r.publicKey), name: r.name } : null,
      }
    }),
    fingerprints: [desk.publicKey, phone.publicKey, new Uint8Array(32), EMPTY].map(k => ({
      public_key: toHex(k),
      fingerprint: fingerprint(k),
    })),
    bridge_api_base: [
      'wss://auth.example/v1/bridge/ws',
      'ws://127.0.0.1:9080/v1/bridge/ws',
      'wss://h?x=1',
      'wss://h#f',
      'wss://user@h:1/x',
      'https://auth.example',
      'wss://',
      'wss:///path',
      'WSS://h',
      ' wss://h',
    ].map(relay => {
      const error = errorOf(() => bridgeApiBase(relay))
      return error ? { relay, error } : { relay, base: bridgeApiBase(relay) }
    }),
  }
}

// ---- noise + channel ----
const P = 2n ** 255n - 19n
const le32 = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 255n))
const highBit = (u: Uint8Array) => {
  const out = u.slice()
  out[31] |= 0x80
  return out
}
const keypairJson = (k: Keypair) => ({ private: toHex(k.privateKey), public: toHex(k.publicKey) })

function x25519Cases() {
  // 同 noise.ts 的 dh：noble 拒绝低阶点和全 0 结果，一律算握手失败
  const dh = (scalar: Uint8Array, u: Uint8Array) => {
    try {
      return { out: toHex(x25519.getSharedSecret(scalar, u)) }
    } catch {
      return { error: 'LINK_HANDSHAKE_FAILED' }
    }
  }
  const rfc1 = hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4')
  const rfc1u = hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c')
  const lowOrder = [
    0n,
    1n,
    P - 1n,
    325606250916557431795983626356110631294008115727848805560023387167927233504n,
    39382357235489614581723060781553021112529911719440698176882885853963445705823n,
  ]
  const s = phone.privateKey
  const cases: [string, Uint8Array, Uint8Array][] = [
    ['rfc7748_1', rfc1, rfc1u],
    [
      'rfc7748_2',
      hex('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d'),
      hex('e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493'),
    ],
    ['basepoint', s, le32(9n)],
    ['basepoint_non_canonical', s, le32(9n + P)],
    ['high_bit_ignored', rfc1, highBit(rfc1u)],
    ['peer_public', s, desk.publicKey],
    ...lowOrder.flatMap((v, k): [string, Uint8Array, Uint8Array][] => [
      [`low_order_${k}`, s, le32(v)],
      [`low_order_${k}_high_bit`, s, highBit(le32(v))],
    ]),
    ['low_order_0_plus_p', s, le32(P)],
    ['low_order_1_plus_p', s, le32(P + 1n)],
  ]
  const out = cases.map(([name, scalar, u]) => ({ name, scalar: toHex(scalar), u: toHex(u), ...dh(scalar, u) }))
  expect(out[0].out).toBe('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552')
  expect(out[2].out).toBe(toHex(phone.publicKey))
  return out
}

function handshake(prologue: Uint8Array, payload1 = EMPTY, payload2 = EMPTY) {
  const i = new Initiator({ local: phone, remote: desk.publicKey, ephemeral: phoneE, prologue })
  const r = new Responder({ local: desk, remote: phone.publicKey, ephemeral: deskE, prologue })
  const m1 = i.writeMessage1(payload1)
  expect(r.readMessage1(m1)).toEqual(payload1)
  const { message: m2, result: rr } = r.writeMessage2(payload2)
  const { payload, result: ir } = i.readMessage2(m2)
  expect(payload).toEqual(payload2)
  expect(ir.hash).toEqual(rr.hash)
  return { m1, m2, ir, rr }
}

function session(name: string, prologue: Uint8Array, p1: string, p2: string, transport: [string, string][]) {
  const { m1, m2, ir, rr } = handshake(prologue, utf8(p1), utf8(p2))
  return {
    name,
    prologue: toHex(prologue),
    initiator: { static: keypairJson(phone), ephemeral: keypairJson(phoneE), remote_static: toHex(desk.publicKey) },
    responder: { static: keypairJson(desk), ephemeral: keypairJson(deskE), remote_static: toHex(phone.publicKey) },
    message1: { payload: toHex(utf8(p1)), message: toHex(m1) },
    message2: { payload: toHex(utf8(p2)), message: toHex(m2) },
    handshake_hash: toHex(ir.hash),
    keys: {
      initiator_send: toHex(keyOf(ir.send)),
      initiator_receive: toHex(keyOf(ir.receive)),
      responder_send: toHex(keyOf(rr.send)),
      responder_receive: toHex(keyOf(rr.receive)),
    },
    // 握手后按顺序互发：计数各方向独立
    transport: transport.map(([from, text]) => {
      const [a, b] = from === 'initiator' ? [ir, rr] : [rr, ir]
      const ciphertext = a.send.seal(utf8(text))
      expect(b.receive.open(ciphertext)).toEqual(utf8(text))
      return { from, payload: toHex(utf8(text)), ciphertext: toHex(ciphertext) }
    }),
  }
}

function handshakeFailures() {
  const { m1, m2 } = handshake(PROLOGUE)
  const zeros = new Uint8Array(32)
  const read1 = (name: string, message: Uint8Array, o: { local?: Keypair; prologue?: Uint8Array } = {}) => {
    const local = o.local ?? desk,
      prologue = o.prologue ?? PROLOGUE
    const error = errorOf(() =>
      new Responder({ local, remote: phone.publicKey, ephemeral: deskE, prologue }).readMessage1(message),
    )
    return {
      name,
      kind: 'read1',
      responder: {
        static_private: toHex(local.privateKey),
        remote_static: toHex(phone.publicKey),
        ephemeral_private: toHex(deskE.privateKey),
        prologue: toHex(prologue),
      },
      message: toHex(message),
      error,
    }
  }
  const read2 = (name: string, message: Uint8Array) => {
    const i = new Initiator({ local: phone, remote: desk.publicKey, ephemeral: phoneE, prologue: PROLOGUE })
    i.writeMessage1()
    return {
      name,
      kind: 'read2',
      initiator: {
        static_private: toHex(phone.privateKey),
        remote_static: toHex(desk.publicKey),
        ephemeral_private: toHex(phoneE.privateKey),
        prologue: toHex(PROLOGUE),
      },
      message: toHex(message),
      error: errorOf(() => i.readMessage2(message)),
    }
  }
  const write1 = (name: string, remote: Uint8Array) => {
    let at = 'construct'
    const error = errorOf(() => {
      const i = new Initiator({ local: phone, remote, ephemeral: phoneE, prologue: PROLOGUE })
      at = 'write1'
      i.writeMessage1()
    })
    return {
      name,
      kind: 'write1',
      initiator: {
        static_private: toHex(phone.privateKey),
        remote_static: toHex(remote),
        ephemeral_private: toHex(phoneE.privateKey),
        prologue: toHex(PROLOGUE),
      },
      at,
      error,
    }
  }
  const out = [
    read1(
      'phone_with_wrong_key',
      new Initiator({ local: mallory, remote: desk.publicKey, ephemeral: phoneE, prologue: PROLOGUE }).writeMessage1(),
    ),
    read1('desktop_with_wrong_key', m1, { local: mallory }),
    read1('prologue_mismatch', m1, { prologue: utf8('pixelsky-mobile/2') }),
    read1('tampered_tag', flip(m1, 40)),
    read1('tampered_ephemeral', flip(m1, 0)),
    read1('too_short', m1.slice(0, 47)),
    read1('low_order_ephemeral', concat(zeros, m1.slice(32))),
    read2('tampered_tag', flip(m2, 40)),
    read2('tampered_ephemeral', flip(m2, 0)),
    read2('too_short', m2.slice(0, 47)),
    read2('low_order_ephemeral', concat(zeros, m2.slice(32))),
    write1('remote_too_short', desk.publicKey.slice(0, 31)),
    write1('remote_too_long', concat(desk.publicKey, Uint8Array.of(0))),
    write1('remote_low_order', zeros),
  ]
  for (const f of out) expect(f.error, f.name).toBe('LINK_HANDSHAKE_FAILED')
  return out
}

/** 解压照电脑端 zlib；超过上限报 LINK_FRAME_TOO_LARGE（同网页版 connection/codec.ts），别的解不开报 LINK_BAD_FRAME（同 App） */
function inflate(bytes: Uint8Array, max: number): Uint8Array {
  try {
    return new Uint8Array(inflateRawSync(bytes, { maxOutputLength: max }))
  } catch (e) {
    throw new Error(
      (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'LINK_FRAME_TOO_LARGE' : 'LINK_BAD_FRAME',
    )
  }
}

type StoredChannel = {
  channel?: { to_phone?: { frame: string }[]; to_desktop?: { frame: string }[]; failures?: { frames: string[] }[] }
} | null

/**
 * 压缩输出随 zlib 版本可能不同：已有样例里的压缩数据只要还解得开、原文相同就沿用，换了 Node 版本样例仍是最新。
 * 密钥、帧格式等真正的改动会让旧帧解不开，照样生成新的、和文件对不上。
 */
function stickyDeflate(stored: StoredChannel, phoneReceive: Uint8Array, desktopReceive: Uint8Array) {
  const known = new Map<string, Uint8Array>()
  const c = stored?.channel
  const lists: [Uint8Array, string[]][] = [
    [phoneReceive, (c?.to_phone ?? []).map(m => m.frame)],
    [desktopReceive, (c?.to_desktop ?? []).map(m => m.frame)],
    ...(c?.failures ?? []).map((f): [Uint8Array, string[]] => [phoneReceive, f.frames]),
  ]
  for (const [key, frames] of lists) {
    const state = new CipherState(key)
    for (const frame of frames) {
      try {
        const plain = state.open(decodeFrame(hex(frame)).body)
        if (plain[0] !== 1) continue
        const data = plain.slice(1)
        known.set(toHex(sha256(inflateRawSync(data, { maxOutputLength: 64 << 20 }))), data)
      } catch {
        // 篡改、截断、重放的帧：跳过
      }
    }
  }
  return (json: Uint8Array) => known.get(toHex(sha256(json))) ?? new Uint8Array(deflateRawSync(json))
}

const TO_PHONE: unknown[] = [
  { n: 1 },
  { id: 1, result: { sessions: [] } },
  { event: 'engine:event', data: { kind: 'delta', text: '你好，世界 👋🏽 emoji 和中文' } },
  'just a string',
  [1, -2, 1.5, true, false, null, '', {}, []],
  { t: 'a'.repeat(1023 - 8) },
  { t: 'a'.repeat(1024 - 8) },
  { t: '中'.repeat(338) + 'ab' },
  {
    event: 'engine:event',
    data: {
      items: Array.from({ length: 200 }, (_, i) => ({
        id: `item-${i}`,
        text: `第 ${i} 条：😀 ${'内容'.repeat(i % 7)}`,
        done: i % 3 === 0,
      })),
    },
  },
  { text: 'a"b\\c\n\t\u0001\u007f /' },
  { n: 2 },
]
const TO_DESKTOP: unknown[] = [
  { id: 1, method: 'hello', args: [{ client: 'app', version: '0.1.0' }] },
  { id: 2, method: 'engine:sessions', args: [] },
  { id: 3, method: 'engine:send', args: ['s-1', { text: '帮我看看这个报错 🙏 '.repeat(80) }] },
  { n: 3 },
]

async function channelFixture(stored: StoredChannel) {
  const { ir } = handshake(PROLOGUE)
  const phoneSend = keyOf(ir.send),
    phoneReceive = keyOf(ir.receive)
  const keys = (send: Uint8Array, receive: Uint8Array): HandshakeResult => ({
    send: new CipherState(send),
    receive: new CipherState(receive),
    hash: EMPTY,
    remoteStatic: EMPTY,
  })
  const deflate = stickyDeflate(stored, phoneReceive, phoneSend)
  // 记下通道交给解压的上限：16 MB 是两端共用的协议上限，Dart 测试核对它用的是同一个值
  const limits = new Set<number>()
  const codec: Codec = { deflate, inflate: (b, max) => (limits.add(max), inflate(b, max)) }

  const sendAll = async (k: HandshakeResult, values: unknown[]) => {
    const frames: Uint8Array[] = []
    const channel = new SecureChannel(
      k,
      f => frames.push(f),
      () => {},
      e => {
        throw e
      },
      codec,
    )
    for (const v of values) await channel.send(v)
    return frames
  }
  const receiveAll = async (k: HandshakeResult, frames: Uint8Array[]) => {
    const values: unknown[] = [],
      errors: string[] = []
    const channel = new SecureChannel(
      k,
      () => {},
      v => values.push(v),
      e => errors.push(e.message),
      codec,
    )
    // 一轮事件循环交一帧，同 WebSocket 一条消息一个事件（Dart 测试也这样喂）
    for (const f of frames) {
      channel.receive(decodeFrame(f).body)
      await settle()
    }
    expect(errors.length).toBeLessThanOrEqual(1)
    return { values, error: errors[0] ?? null }
  }
  /** 按发送方的计数逐帧解开，看第 1 字节（1 = 压缩过） */
  const flags = (key: Uint8Array, frames: Uint8Array[]) => {
    const state = new CipherState(key)
    return frames.map(f => state.open(decodeFrame(f).body)[0] === 1)
  }
  const messages = async (send: Uint8Array, receive: Uint8Array, values: unknown[]) => {
    const frames = await sendAll(keys(send, receive), values)
    expect(await receiveAll(keys(receive, send), frames)).toEqual({ values, error: null })
    const compressed = flags(send, frames)
    return values.map((value, i) => ({ value, compressed: compressed[i], frame: toHex(frames[i]) }))
  }

  expect(encodeJson(TO_PHONE[5]).length).toBe(1023)
  expect(encodeJson(TO_PHONE[6]).length).toBe(1024)
  expect(encodeJson(TO_PHONE[7]).length).toBe(1024)
  const toPhone = await messages(phoneReceive, phoneSend, TO_PHONE)
  const toDesktop = await messages(phoneSend, phoneReceive, TO_DESKTOP)
  // 1024 字节起压缩（按字节算：第 7 条全是中文，字符数不到 1024）
  expect(toPhone.flatMap((m, i) => (m.compressed ? [i] : []))).toEqual([6, 7, 8])

  // 坏帧：每组从计数 0 开始、交给一个新的手机端通道；解不开就作废，只报一次错，之后的帧都不处理
  const sealAll = (bodies: Uint8Array[]) => {
    const state = new CipherState(phoneReceive)
    return bodies.map(b => encodeFrame(FrameType.Data, state.seal(b)))
  }
  const raw = (v: unknown) => concat(Uint8Array.of(0), encodeJson(v))
  const big = deflate(encodeJson(TO_PHONE[8]))
  const [f0, f1] = sealAll([raw({ n: 1 }), raw({ n: 2 })])
  // 第三项是预期的错误：写在这里，免得生成样例的代码本身写错（例如密钥用反）时所有组都悄悄变成解密失败
  const failureCases: [string, Uint8Array[], string][] = [
    ['replayed', [f0, f0, f1], 'LINK_DECRYPT_FAILED'],
    ['out_of_order', [f1, f0], 'LINK_DECRYPT_FAILED'],
    ['tampered', [flip(f0, f0.length - 1), f0, f1], 'LINK_DECRYPT_FAILED'],
    ['truncated_frame', [f0.slice(0, 11)], 'LINK_DECRYPT_FAILED'],
    ['bad_flag_after_valid', sealAll([raw({ n: 1 }), concat(Uint8Array.of(2), encodeJson({}))]), 'LINK_BAD_FRAME'],
    ['frame_after_error_ignored', sealAll([Uint8Array.of(2), raw({ n: 2 })]), 'LINK_BAD_FRAME'],
    ['empty_plaintext', sealAll([EMPTY]), 'LINK_BAD_FRAME'],
    ['bad_json', sealAll([concat(Uint8Array.of(0), utf8('{bad'))]), 'LINK_BAD_FRAME'],
    ['bad_utf8', sealAll([Uint8Array.of(0, 0xff)]), 'LINK_BAD_FRAME'],
    ['corrupt_deflate', sealAll([Uint8Array.of(1, 0xff, 0xff, 0xff)]), 'LINK_BAD_FRAME'],
    ['truncated_deflate', sealAll([concat(Uint8Array.of(1), big.slice(0, big.length >> 1))]), 'LINK_BAD_FRAME'],
    [
      'inflate_over_limit',
      sealAll([concat(Uint8Array.of(1), deflate(new Uint8Array(16 * 1024 * 1024 + 1)))]),
      'LINK_FRAME_TOO_LARGE',
    ],
  ]
  const failures = []
  for (const [name, frames, expected] of failureCases) {
    const got = await receiveAll(keys(phoneSend, phoneReceive), frames)
    expect(got.error, name).toBe(expected)
    failures.push({ name, frames: frames.map(toHex), ...got })
  }

  return {
    phone: { send_key: toHex(phoneSend), receive_key: toHex(phoneReceive) },
    inflated_limit: [...limits],
    to_phone: toPhone,
    to_desktop: toDesktop,
    failures,
  }
}

async function sessionsFixture() {
  const stored = readStored('link_sessions.json') as StoredChannel
  return {
    generated_by: GENERATED_BY,
    x25519: x25519Cases(),
    keypairs: [fixed('phone-static'), new Uint8Array(32), new Uint8Array(32).fill(255)].map(k =>
      keypairJson(keypairFrom(k)),
    ),
    sessions: [
      // App 实际的用法：带 PROLOGUE、两条握手消息都不带内容
      session('app', PROLOGUE, '', '', [
        ['initiator', '{"id":1,"method":"hello"}'],
        ['responder', '{"id":1,"result":{}}'],
        ['initiator', ''],
        ['initiator', '第二条'],
        ['responder', '😀'],
      ]),
      session('payloads', PROLOGUE, '手机 → 电脑', '电脑 → 手机 😀', [['responder', 'x']]),
      session('empty_prologue', EMPTY, 'a', '', [['initiator', 'b']]),
    ],
    handshake_failures: handshakeFailures(),
    channel: await channelFixture(stored),
  }
}

// ---- rpc ----
const INCOMING: [string, unknown][] = [
  ['result', { id: 1, result: { sessions: [] } }],
  ['error', { id: 1, error: 'MOBILE_NOT_ALLOWED' }],
  ['empty_error_is_success', { id: 1, error: '', result: 5 }],
  ['zero_error_is_success', { id: 1, error: 0, result: 5 }],
  ['false_error_is_success', { id: 1, error: false }],
  ['null_error_is_success', { id: 1, error: null, result: 'r' }],
  ['number_error', { id: 1, error: 404 }],
  ['float_error', { id: 1, error: 1.5 }],
  ['true_error', { id: 1, error: true }],
  ['object_error', { id: 1, error: { code: 1 } }],
  ['array_error', { id: 1, error: ['a', null, 2] }],
  ['empty_array_error', { id: 1, error: [] }],
  ['missing_result', { id: 1 }],
  ['unknown_id', { id: 2, result: 1 }],
  ['negative_id', { id: -1, result: 1 }],
  ['string_id', { id: '1', result: 1 }],
  ['fractional_id', { id: 1.5, result: 1 }],
  ['unsafe_id', { id: 9007199254740992, result: 1 }],
  ['max_safe_id', { id: 9007199254740991, result: 1 }],
  ['event', { event: 'engine:event', data: { kind: 'sessions' } }],
  ['event_without_data', { event: 'away' }],
  ['event_wins_over_id', { id: 1, event: 'e', data: 1, result: 2 }],
  ['non_string_event', { event: 1, data: 1 }],
  ['null', null],
  ['array', []],
  ['string', 'text'],
  ['number', 5],
  ['call', { id: 3, method: 'engine:list', args: [1] }],
  ['call_without_args', { id: 3, method: 'x' }],
  ['call_with_object_args', { id: 3, method: 'x', args: { a: 1 } }],
  ['non_string_method_is_reply', { id: 1, method: 5, result: 'r' }],
]

async function rpcFixture() {
  // 发出去的消息：调用按顺序编号，事件不占编号
  const sent: RpcMessage[] = []
  const core = new RpcCore(m => sent.push(m))
  const outgoing: unknown[] = []
  const steps: [string, string, unknown][] = [
    ['call', 'hello', [{ client: 'app', version: '0.1.0' }]],
    ['event', 'away', true],
    ['call', 'engine:sessions', []],
    ['call', 'engine:open', ['s-1', { limit: 50 }]],
    ['event', 'engine:event', { kind: 'x', n: 1 }],
  ]
  for (const [kind, name, payload] of steps) {
    if (kind === 'call') {
      core.call(name, payload as unknown[]).catch(() => {})
      outgoing.push({ call: name, args: payload, message: sent.at(-1) })
    } else {
      core.event(name, payload)
      outgoing.push({ event: name, data: payload, message: sent.at(-1) })
    }
  }
  core.close()

  // 收到调用后回复：handler 的结果或错误；回复写不出去（超过 reply_limit 字符）改回 RPC_SIZE_LIMIT
  const REPLY_LIMIT = 100
  const handledCases: [unknown, { result?: unknown; throw?: string }][] = [
    [{ id: 7, method: 'echo', args: [1, '中文'] }, { result: [1, '中文'] }],
    [{ id: 8, method: 'deny', args: [] }, { throw: 'MOBILE_NOT_ALLOWED' }],
    [{ id: 9, method: 'nothing', args: [] }, { result: null }],
    [{ id: 10, method: 'big', args: [] }, { result: 'x'.repeat(200) }],
    [{ id: 11, method: 'nested', args: [{ a: [1] }] }, { result: { ok: true, list: [{}] } }],
  ]
  const handled = []
  for (const [request, h] of handledCases) {
    const replies: unknown[] = []
    const c = new RpcCore(
      m => {
        if (JSON.stringify(m).length > REPLY_LIMIT) throw new Error(RPC_SIZE_LIMIT)
        replies.push(m)
      },
      () => {
        if (h.throw) throw new Error(h.throw)
        return h.result
      },
    )
    c.receive(request)
    await settle()
    handled.push({ request, handler: h, replies })
  }

  // 收到的各种消息：先有一个挂着的调用（id 1），看它的结果、连接是否关闭、收到的事件和发出的回复
  const incoming = []
  for (const [name, raw] of INCOMING) {
    const replies: unknown[] = [],
      events: unknown[] = []
    let call: unknown = 'pending',
      closed: string | null = null
    const c = new RpcCore(m => replies.push(JSON.parse(JSON.stringify(m))))
    c.call('x', [], 60_000).then(
      v => (call = { resolved: v ?? null }),
      (e: Error) => (call = { rejected: e.message }),
    )
    replies.length = 0
    c.onEvent = (channel, data) => events.push([channel, data ?? null])
    c.onClose = e => (closed = e.message)
    c.receive(raw)
    await settle()
    incoming.push({ name, raw, call, closed, events, replies })
    c.close()
  }

  const closedCore = new RpcCore(() => {})
  closedCore.close()
  const timeoutCore = new RpcCore(() => {})
  return {
    generated_by: GENERATED_BY,
    constants: {
      size_limit: RPC_SIZE_LIMIT,
      closed_error: await closedCore.call('x').catch((e: Error) => e.message),
      timeout_error: await timeoutCore.call('x', [], 1).catch((e: Error) => e.message),
      reply_limit: REPLY_LIMIT,
    },
    outgoing,
    handled,
    incoming,
  }
}

describe('app fixtures (apps/app/test/fixtures)', () => {
  it('noise_vectors.json', () => {
    check('noise_vectors.json', {
      generated_by: GENERATED_BY,
      source: 'cacophony 的 Noise 官方测试向量（同 packages/link/test/noise-kk-vector.json）',
      vectors: [vector],
    })
  })
  it('link_bytes.json', () => check('link_bytes.json', bytesFixture()))
  it('link_frames.json', () => check('link_frames.json', framesFixture()))
  it('link_pairing.json', () => check('link_pairing.json', pairingFixture()))
  it('link_sessions.json', async () => check('link_sessions.json', await sessionsFixture()))
  it('link_rpc.json', async () => check('link_rpc.json', await rpcFixture()))
})
