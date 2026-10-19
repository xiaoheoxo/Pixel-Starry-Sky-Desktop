import { createHash, createPublicKey, verify } from 'node:crypto'
import { codedError } from '@pixelsky/protocol'
import type { ExtStoreErrorCode, ExtStoreVersion } from '@pixelsky/protocol'
import { keysForSite, type DevKeySource, type StoreKey, type StoreKeyStatus } from './keys'

// 下载后的验签（docs/ui/extension-store-client.md §4.2）。只吃已经下载好的字节和详情 / 响应头里的信息，不发请求。
// 签的是这一串字节（末尾没有换行），和云端 sign.go SignedText（services/cloud/internal/extensions/sign.go:22）一样：
//   pixelsky-ext/1\n{id}\n{version}\n{zip 原始字节的 sha256，小写十六进制}

/** 下载响应里的三个头（云端 extapi.go:23-25） */
export const HEADER_SHA256 = 'X-Pixelsky-Ext-Sha256'
export const HEADER_SIGNATURE = 'X-Pixelsky-Ext-Signature'
export const HEADER_KEY_ID = 'X-Pixelsky-Ext-Key-Id'

/** 下载响应的头：Fetch 的 Headers，或者普通对象（名字不分大小写） */
export type VerifyHeaders = { get(name: string): string | null } | Record<string, string | undefined>

export interface VerifyInput {
  id: string
  version: string
  /** 下载的 zip 原始字节 */
  bytes: Uint8Array
  /** 下载响应的头 */
  headers: VerifyHeaders
  /** 详情里这个版本那一项；下架后详情 404 时是 null，只靠响应头 */
  detail: Pick<ExtStoreVersion, 'sha256' | 'signature' | 'keyId'> | null
  /** 当前站点（origin 或带路径的地址） */
  site: string
  /** 测试注入：钥匙表和开发版钥匙来源 */
  table?: StoreKey[]
  dev?: DevKeySource
}

export type VerifyFailCode = Extract<
  ExtStoreErrorCode,
  'extstore.badSignature' | 'extstore.unknownKey' | 'extstore.unknownSite' | 'extstore.revokedKey'
>

export type VerifyResult =
  | { ok: true; keyId: string; sha256: string; signature: string; keyStatus: Exclude<StoreKeyStatus, 'revoked'> }
  | {
      ok: false
      code: VerifyFailCode
      /** 写日志用的原因 */
      reason: string
      /** `extstore.unknownSite` 的文案参数 */
      params?: { site: string }
    }

const SHA_RE = /^[0-9a-f]{64}$/

/** 要签的字节 */
export function signedText(id: string, version: string, sha256: string): Buffer {
  return Buffer.from(`pixelsky-ext/1\n${id}\n${version}\n${sha256}`, 'utf8')
}

function header(headers: VerifyHeaders, name: string): string {
  if (typeof (headers as { get?: unknown }).get === 'function')
    return (headers as { get(n: string): string | null }).get(name) ?? ''
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers as Record<string, string | undefined>))
    if (k.toLowerCase() === lower) return v ?? ''
  return ''
}

const bad = (reason: string): VerifyResult => ({ ok: false, code: 'extstore.badSignature', reason })

/** 标准 base64、解出来正好 64 字节才算签名；不接受宽松写法 */
function decodeSignature(text: string): Buffer | null {
  const raw = Buffer.from(text, 'base64')
  return raw.length === 64 && raw.toString('base64') === text ? raw : null
}

function publicKeyOf(base64: string): ReturnType<typeof createPublicKey> | null {
  try {
    const raw = Buffer.from(base64, 'base64')
    if (raw.length !== 32) return null
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
  } catch {
    return null
  }
}

/**
 * 按 §4.2 前四步验 sha256 和签名。任何一项不对都返回带原因的拒绝，不抛异常。
 * 第 5 步（清单里的 id / version 和签过名的一样）在解开 zip 以后由安装流程做。
 */
export function verifyPackage(input: VerifyInput): VerifyResult {
  const { id, version, bytes, headers, detail, site } = input
  if (!id || !version) return bad('id 或版本号是空的')

  const keys = keysForSite(site, input.table, input.dev)
  if (!keys.length)
    return { ok: false, code: 'extstore.unknownSite', reason: `站点没有认的钥匙：${site}`, params: { site } }

  // 1. sha256：下载的 zip 原始字节，等于响应头；有详情时也要等于详情
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const headerSha = header(headers, HEADER_SHA256)
  if (!SHA_RE.test(headerSha) || headerSha !== sha256) return bad(`sha256 和响应头不一致：${sha256} / ${headerSha}`)
  if (detail && detail.sha256 !== sha256) return bad(`sha256 和详情不一致：${sha256} / ${detail.sha256}`)

  // 2. 钥匙 id：必须是本站认的、没作废的；不认识的一律拒绝，不试别的钥匙
  const keyId = header(headers, HEADER_KEY_ID)
  if (detail && detail.keyId !== keyId) return bad(`钥匙 id 和详情不一致：${keyId} / ${detail.keyId}`)
  if (!keyId) return { ok: false, code: 'extstore.unknownKey', reason: '钥匙 id 是空的' }
  const key = keys.find(k => k.keyId === keyId)
  if (!key) return { ok: false, code: 'extstore.unknownKey', reason: `不认识的钥匙 ${keyId}` }
  if (key.status === 'revoked') return { ok: false, code: 'extstore.revokedKey', reason: `钥匙 ${keyId} 已作废` }

  // 3. 签名：标准 base64、64 字节；有详情时必须一样
  const signature = header(headers, HEADER_SIGNATURE)
  if (detail && detail.signature !== signature) return bad('签名和详情不一致')
  const sig = decodeSignature(signature)
  if (!sig) return bad('签名不是 64 字节的标准 base64')

  // 4. 验签
  const publicKey = publicKeyOf(key.publicKey)
  if (!publicKey) return bad(`钥匙 ${keyId} 的公钥读不出来`)
  let ok: boolean
  try {
    ok = verify(null, signedText(id, version, sha256), publicKey, sig)
  } catch {
    ok = false
  }
  if (!ok) return bad('签名对不上')
  return { ok: true, keyId, sha256, signature, keyStatus: key.status }
}

/** 拒绝结果转成给渲染层的带代码错误 */
export function verifyError(result: Extract<VerifyResult, { ok: false }>): Error {
  return codedError(result.code, result.params)
}
