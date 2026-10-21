// 扫码配对（docs/mobile-remote.md §4.1）。
// 二维码里有电脑的长期公钥和一次性密钥；手机用这个密钥给「自己的公钥 + 名字」算校验码，
// 电脑核对后才让用户确认。密钥只在二维码里，中转（以后是云端）拿不到，所以伪造不了配对请求。
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { concat, equalBytes, fromBase64Url, fromUtf8, toBase64Url, toHex, utf8 } from './bytes'
import { KEY_LENGTH } from './noise'

export const LINK_VERSION = 1
/** 握手前缀：协议版本绑进握手，两端版本不同时握手失败 */
export const PROLOGUE = utf8('pixelsky-mobile/1')

/** 二维码内容 */
export interface PairingOffer {
  v: typeof LINK_VERSION
  /** 中转地址（ws:// 或 wss://） */
  relay: string
  /** 电脑 ID */
  desktop: string
  /** 电脑长期公钥（base64url） */
  key: string
  /** 一次性配对密钥（base64url，16 字节） */
  secret: string
  /** 电脑名，只用来显示 */
  name: string
  /** 过期时间（毫秒时间戳） */
  expires: number
  /** 云端的一次性配对码：手机用它换设备令牌（M2）；本机测试中转没有 */
  code?: string
}

/** 手机发给电脑的配对请求 */
export interface PairRequest {
  /** 手机长期公钥（base64url） */
  key: string
  /** 手机名，只用来显示 */
  name: string
  /** HMAC-SHA256(配对密钥, 标签 | 电脑公钥 | 手机公钥 | 手机名)（base64url） */
  mac: string
}

/**
 * 配对结果帧（明文、经云端，不可信）：只能用来更新界面和决定何时重试，不能据此删掉已配好的电脑。
 * - unknown：电脑上没有这部手机（被移除或电脑重装）；真被移除时云端会以 4001 关连接
 * - unavailable：电脑暂时拿不到自己的密钥（系统加密不可用）
 * - handshake_failed：握手消息解不开，带上电脑的 LINK_VERSION 供手机判断版本不一致
 */
export type PairStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'unknown'
  | 'unavailable'
  | 'handshake_failed'

const LABEL = utf8('pixelsky-pair/1')
const NAME_LIMIT = 64

export function newPairingSecret(): string {
  return toBase64Url(randomBytes(16))
}

function mac(secret: Uint8Array, desktopKey: Uint8Array, phoneKey: Uint8Array, name: string): Uint8Array {
  return hmac(sha256, secret, concat(LABEL, desktopKey, phoneKey, utf8(name)))
}

const cleanName = (name: unknown): string =>
  typeof name === 'string'
    ? name
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, NAME_LIMIT)
    : ''

/** 手机：按二维码生成配对请求 */
export function pairRequest(offer: PairingOffer, phonePublicKey: Uint8Array, name: string): PairRequest {
  const clean = cleanName(name)
  return {
    key: toBase64Url(phonePublicKey),
    name: clean,
    mac: toBase64Url(mac(fromBase64Url(offer.secret), fromBase64Url(offer.key), phonePublicKey, clean)),
  }
}

/** 电脑：核对配对请求，通过时返回手机公钥和名字，不通过时返回 null */
export function verifyPairRequest(
  raw: unknown,
  secret: string,
  desktopPublicKey: Uint8Array,
): { publicKey: Uint8Array; name: string } | null {
  const r = (raw ?? {}) as Record<string, unknown>
  try {
    if (typeof r.key !== 'string' || typeof r.mac !== 'string') return null
    const publicKey = fromBase64Url(r.key)
    const name = cleanName(r.name)
    if (publicKey.length !== KEY_LENGTH || name !== r.name) return null
    const expected = mac(fromBase64Url(secret), desktopPublicKey, publicKey, name)
    return equalBytes(expected, fromBase64Url(r.mac)) ? { publicKey, name } : null
  } catch {
    return null
  }
}

/**
 * 二维码文本。给了 web（手机网页版的地址，例如 https://auth.example/m/）时是网页链接 web#pair=<数据>：
 * 用手机自带的相机或微信扫码就能直接打开网页版（局域网 http 下网页拿不到相机，不能在页面里扫码）；
 * 「#」后面的部分浏览器不会发给服务器。没给 web 时是 pixelsky://pair?d=<数据>（以后的 App 用）。
 */
export function encodeOffer(offer: PairingOffer, web?: string): string {
  const data = toBase64Url(utf8(JSON.stringify(offer)))
  return web ? web.replace(/#.*$/, '') + '#pair=' + data : 'pixelsky://pair?d=' + data
}

export function decodeOffer(text: string): PairingOffer {
  const m =
    /^pixelsky:\/\/pair\?d=([A-Za-z0-9_-]+)$/.exec(text.trim()) ??
    /^https?:\/\/[^#\s]*#pair=([A-Za-z0-9_-]+)$/.exec(text.trim())
  if (!m) throw new Error('LINK_BAD_OFFER')
  let parsed: unknown
  try {
    parsed = JSON.parse(fromUtf8(fromBase64Url(m[1])))
  } catch {
    throw new Error('LINK_BAD_OFFER')
  }
  // 解出来是 null、数字、数组等：不是配对数据（不能让 o.v 抛 TypeError）
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('LINK_BAD_OFFER')
  const o = parsed as Record<string, unknown>
  const ok =
    o.v === LINK_VERSION &&
    typeof o.relay === 'string' &&
    /^wss?:\/\//.test(o.relay) &&
    typeof o.desktop === 'string' &&
    typeof o.key === 'string' &&
    typeof o.secret === 'string' &&
    typeof o.name === 'string' &&
    typeof o.expires === 'number' &&
    (o.code === undefined || typeof o.code === 'string')
  if (!ok) throw new Error('LINK_BAD_OFFER')
  return o as unknown as PairingOffer
}

/** 公钥指纹：两端各显示一份，用户可以对一下（4 组 4 位十六进制） */
export function fingerprint(publicKey: Uint8Array): string {
  return toHex(sha256(publicKey).slice(0, 8)).toUpperCase().match(/.{4}/g)?.join('·') ?? ''
}

/** 中转地址对应的云端接口地址：wss://host/v1/bridge/ws → https://host（手机用配对码换设备令牌时用） */
export function bridgeApiBase(relay: string): string {
  const m = /^(wss?):\/\/([^/?#]+)/.exec(relay)
  if (!m) throw new Error('LINK_BAD_OFFER')
  return (m[1] === 'wss' ? 'https://' : 'http://') + m[2]
}

/** 连中转时带令牌的子协议：浏览器的 WebSocket 不能加请求头 */
export const BRIDGE_PROTOCOL = 'pixelsky.v1'
export const bridgeProtocols = (token: string): string[] => [BRIDGE_PROTOCOL, 'bearer.' + token]
