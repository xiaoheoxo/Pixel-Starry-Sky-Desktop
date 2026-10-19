import { existsSync, readFileSync } from 'node:fs'
import { isExtId, isExtVersion } from '@pixelsky/protocol'

// 停用名单（docs/ui/extension-store-client.md §5）。这一片只有同步读 blocklist.json 和匹配两个纯函数，
// 启动时在第一次 commit 之前用上次存的名单；定时读网络、存盘、解除是 7.3a 的事。

export interface BlocklistItem {
  id: string
  /** '*' = 所有版本，否则是被停用的版本号列表 */
  versions: '*' | string[]
  reason: string
}

/** 一个站点的名单 */
export interface BlocklistSite {
  /** 读到这份名单的时间（ISO） */
  fetchedAt: string
  /** 云端名单自己的更新时间 */
  updatedAt: string
  items: BlocklistItem[]
}

/** <dataDir>/blocklist.json：按站点（origin）分开存 */
export interface BlocklistFile {
  version: 1
  sites: Record<string, BlocklistSite>
}

export const emptyBlocklist = (): BlocklistFile => ({ version: 1, sites: {} })

function item(raw: unknown): BlocklistItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (!isExtId(o.id)) return null
  let versions: BlocklistItem['versions']
  if (o.versions === '*') versions = '*'
  else if (Array.isArray(o.versions)) {
    // 只去掉不合法的版本号，合法的照样停用；一个合法的都没有才丢掉整条
    const valid = o.versions.filter(isExtVersion)
    if (valid.length === 0) return null
    versions = valid
  } else return null
  return { id: o.id, versions, reason: typeof o.reason === 'string' ? o.reason : '' }
}

/** 形状不对的条目丢掉，整个站点形状不对（没有读取时间）也丢掉 */
export function normalizeBlocklist(raw: unknown): BlocklistFile {
  const out = emptyBlocklist()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const data = raw as Record<string, unknown>
  if (data.version !== 1 || !data.sites || typeof data.sites !== 'object' || Array.isArray(data.sites)) return out
  for (const [origin, v] of Object.entries(data.sites as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const s = v as Record<string, unknown>
    if (typeof s.fetchedAt !== 'string' || !s.fetchedAt || !Array.isArray(s.items)) continue
    out.sites[origin] = {
      fetchedAt: s.fetchedAt,
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '',
      items: s.items.map(item).filter((i): i is BlocklistItem => i !== null),
    }
  }
  return out
}

/** 同步读；文件不存在、读不了、解析不了都当空名单，不抛错（不能因为名单坏了让软件起不来） */
export function readBlocklistFile(file: string): BlocklistFile {
  try {
    if (!existsSync(file)) return emptyBlocklist()
    return normalizeBlocklist(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyBlocklist()
  }
}

/**
 * 这个扩展这个版本在名单里吗？只看**它回执里 site** 的那份名单（换站点后别的站点的空名单不会放出它）。
 * 命中返回 { reason, at }（at 是那份名单的读取时间），没命中 null。
 */
export function matchBlocklist(
  file: BlocklistFile,
  site: string,
  id: string,
  version: string,
): { reason: string; at: string } | null {
  const list = file.sites[site]
  if (!list) return null
  const hit = list.items.find(i => i.id === id && (i.versions === '*' || i.versions.includes(version)))
  return hit ? { reason: hit.reason, at: list.fetchedAt } : null
}
