import { createHash } from 'node:crypto'
import { app } from 'electron'

// 扩展商店的签名钥匙表（docs/ui/extension-store-client.md §4.1）。
// 钥匙 id = SHA-256(32 字节公钥原文) 的前 8 个十六进制字符（云端 services/cloud/internal/extensions/sign.go KeyIDOf）。
// 钥匙按站点认：当前站点对应的那几行才是这次认的钥匙。

/**
 * active = 在用；verifyOnly = 只验以前签的包（换钥匙后长期保留，云端没有重签接口，旧钥匙签的版本会一直在商店里）；
 * revoked = 已作废（新装一律拒绝，已装的当成被平台停用）
 */
export type StoreKeyStatus = 'active' | 'verifyOnly' | 'revoked'

export interface StoreKey {
  keyId: string
  /** 公钥 32 字节原文的标准 base64 */
  publicKey: string
  /** 规范的 origin（`new URL(x).origin`） */
  sites: string[]
  status: StoreKeyStatus
}

export const STORE_KEYS: StoreKey[] = [
  {
    keyId: '8273f03a',
    publicKey: 'z+QHBZ24TLfmMDcrApDCKzSk4VYBsmYYpfDn6jInMjU=',
    sites: ['https://auth.pixelstarrysky.xyz'],
    status: 'active',
  }, // 测试站，2026-10-16 生成（extension-cloud.md §12）
  {
    keyId: '4f9edb34',
    publicKey: '89lbJp/zJJSNBbrcD7tCIhJFMfXO3mtdaQDs0/6RHzY=',
    sites: ['https://pixelstarrysky.xyz'],
    status: 'active',
  }, // 正式站，2026-10-17 生成（docs/cloud-prod-migration.md）
]

/** 开发版多认钥匙用的环境变量：`<base64>[,<base64>]`，每个是 32 字节公钥原文的 base64 */
export const DEV_KEYS_ENV = 'PIXELSKY_EXT_DEV_KEYS'

/** 开发版钥匙的来源，测试里可以替换 */
export interface DevKeySource {
  packaged: boolean
  value: string | undefined
}

function defaultDevSource(): DevKeySource {
  let packaged: boolean
  try {
    // 取不到 app 就当成打包版：宁可少认钥匙
    packaged = app.isPackaged !== false
  } catch {
    packaged = true
  }
  return { packaged, value: process.env[DEV_KEYS_ENV] }
}

/** 公钥（32 字节原文的标准 base64）算钥匙 id；不是 32 字节返回 null */
export function keyIdOf(publicKey: string): string | null {
  const raw = Buffer.from(publicKey, 'base64')
  if (raw.length !== 32 || raw.toString('base64') !== publicKey) return null
  return createHash('sha256').update(raw).digest('hex').slice(0, 8)
}

/** 地址规范成 origin；不是合法地址返回空串 */
export function siteOrigin(url: string): string {
  try {
    const u = new URL(url)
    return u.origin === 'null' ? '' : u.origin
  } catch {
    return ''
  }
}

function devKeys(origin: string, source: DevKeySource): StoreKey[] {
  if (source.packaged || !source.value) return []
  const out: StoreKey[] = []
  for (const part of source.value.split(',')) {
    const publicKey = part.trim()
    const keyId = publicKey ? keyIdOf(publicKey) : null
    if (keyId && !out.some(k => k.keyId === keyId)) out.push({ keyId, publicKey, sites: [origin], status: 'active' })
  }
  return out
}

/**
 * 这个站点认的钥匙（三种状态都在）。`site` 可以带路径，先规范成 origin。
 * 开发版（!app.isPackaged）再加上环境变量里的钥匙，只对这个站点生效；表里已有的钥匙 id 不重复加。
 */
export function keysForSite(
  site: string,
  table: StoreKey[] = STORE_KEYS,
  dev: DevKeySource = defaultDevSource(),
): StoreKey[] {
  const origin = siteOrigin(site)
  if (!origin) return []
  const rows = table.filter(k => k.sites.includes(origin))
  return [...rows, ...devKeys(origin, dev).filter(k => !rows.some(r => r.keyId === k.keyId))]
}

/** 站点上这个钥匙 id 的状态；表里没有（或者空）是 unknown */
export function keyStatus(
  keyId: string,
  site: string,
  table: StoreKey[] = STORE_KEYS,
  dev?: DevKeySource,
): StoreKeyStatus | 'unknown' {
  return keysForSite(site, table, dev).find(k => k.keyId === keyId)?.status ?? 'unknown'
}
