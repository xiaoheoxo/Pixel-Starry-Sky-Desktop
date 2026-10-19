import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeLive, isExtId, isExtVersion } from '@pixelsky/protocol'
import type { ExtPackOptions } from '@pixelsky/protocol'
import { loadPack, packKey, type LoadedPack } from '../loader'
import { matchBlocklist, type BlocklistFile } from './blocklist'
import type { StoreKeyStatus } from './keys'
import type { StoreInstallRecord } from './types'

// 启动时把 store/<id>/install.json 记着的商店扩展加载进来（docs/ui/extension-store-client.md §3.4）。
// 不导入 service.ts：service 调它，要的东西都从参数传进来。

/** 钥匙已作废时的停用原因 */
export const REVOKED_KEY_REASON = '签名钥匙已作废'

/** 解压目录名 = sha256 前 16 位；严格检查，免得坏回执把路径指到商店目录之外 */
const DIR_RE = /^[0-9a-f]{16}$/

export interface StoreEntry {
  record: StoreInstallRecord
  /** 解压后的扩展目录：<storeDir>/<id>/<dir> */
  root: string
}

function parseRecord(raw: unknown, id: string): StoreInstallRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.id !== id || !isExtVersion(o.version)) return null
  if (typeof o.sha256 !== 'string' || typeof o.signature !== 'string') return null
  if (typeof o.keyId !== 'string' || typeof o.site !== 'string') return null
  if (typeof o.dir !== 'string' || !DIR_RE.test(o.dir)) return null
  return {
    id,
    version: o.version,
    sha256: o.sha256,
    size: typeof o.size === 'number' ? o.size : 0,
    signature: o.signature,
    keyId: o.keyId,
    site: o.site,
    dir: o.dir,
    installedAt: typeof o.installedAt === 'number' ? o.installedAt : 0,
  }
}

/** 读 store/<id>/install.json；不存在、读不了、形状不对返回 null */
export function readStoreRecord(storeDir: string, id: string): StoreInstallRecord | null {
  try {
    return parseRecord(JSON.parse(readFileSync(join(storeDir, id, 'install.json'), 'utf8')), id)
  } catch {
    return null
  }
}

/**
 * 同步扫 store 目录下每个 <id>/install.json：回执读不了、形状不对、目录不在的跳过并写一行日志，不影响别的。
 * 按 id 排序；`.tmp` 之类不是合法 id 的目录不是扩展。启动时的 preReadKey 和 loadStore 共用。
 */
export function readStoreEntries(storeDir: string, log: (message: string) => void = () => {}): StoreEntry[] {
  let names: string[]
  try {
    names = readdirSync(storeDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && isExtId(e.name))
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
  const out: StoreEntry[] = []
  for (const id of names) {
    const record = readStoreRecord(storeDir, id)
    if (!record) {
      log(`skip store/${id}: install.json is missing or invalid`)
      continue
    }
    const root = join(storeDir, id, record.dir)
    if (!existsSync(root)) {
      log(`skip store/${id}: directory ${record.dir} is missing`)
      continue
    }
    out.push({ record, root })
  }
  return out
}

/** 这份回执现在要不要停用：先看名单（只看回执里 site 的那份），再看钥匙是不是已作废；不停用返回 null */
export function storeBlock(
  record: StoreInstallRecord,
  blocklist: BlocklistFile,
  keyStatus: (keyId: string, site: string) => StoreKeyStatus | 'unknown',
  now: () => string = () => new Date().toISOString(),
): { reason: string; at: string } | null {
  const hit = matchBlocklist(blocklist, record.site, record.id, record.version)
  if (hit) return hit
  if (keyStatus(record.keyId, record.site) === 'revoked') return { reason: REVOKED_KEY_REASON, at: now() }
  return null
}

export interface LoadStoreInput {
  storeDir: string
  /** state.json 里的 store 字段（开关和选项） */
  state: Record<string, { enabled: boolean; options: ExtPackOptions }>
  blocklist: BlocklistFile
  keyStatus: (keyId: string, site: string) => StoreKeyStatus | 'unknown'
  appVersion: string
  /** 取下一个实例版本号（service 的 packRevision） */
  revision: () => number
  log?: (message: string) => void
  now?: () => string
}

/**
 * 加载一份商店扩展（启动时逐个加载、安装 / 更新换上以后也用它）。装的时候已经验过签、按上传标准检查过，
 * 所以不扫 SVG 内容（scanSvg:false），以后商店版 Material（1255 个文件）也不用每次启动都扫。
 * 名单命中或钥匙已作废的设 blocked（live 为 false）；同 id 的生效关系由调用方再跑 applyWinners。
 */
export async function loadStorePack(
  record: StoreInstallRecord,
  root: string,
  input: Omit<LoadStoreInput, 'storeDir'>,
): Promise<LoadedPack> {
  const { state, blocklist, keyStatus, appVersion, revision, now } = input
  const st = state[record.id] ?? { enabled: true, options: {} }
  const pack = await loadPack({
    key: packKey('store', record.id),
    root,
    source: 'store',
    enabled: st.enabled,
    addedAt: record.installedAt,
    options: st.options,
    revision: revision(),
    appVersion,
    scanSvg: false,
  })
  const info = pack.info
  info.store = {
    version: record.version,
    installedAt: record.installedAt,
    sha256: record.sha256,
    keyId: record.keyId,
    site: record.site,
  }
  const block = storeBlock(record, blocklist, keyStatus, now)
  if (block) info.blocked = block
  info.live = computeLive(info)
  return pack
}

/** 加载 store/ 下所有商店扩展（按 id 排序） */
export async function loadStore(input: LoadStoreInput): Promise<LoadedPack[]> {
  const packs: LoadedPack[] = []
  for (const { record, root } of readStoreEntries(input.storeDir, input.log))
    packs.push(await loadStorePack(record, root, input))
  return packs
}
