import { compareExtVersion, packName } from '@pixelsky/protocol'
import type {
  ExtLocale,
  ExtPackContributionKind,
  ExtPackInfo,
  ExtPackSource,
  ExtStoreUpdate,
  ExtStoreUpdates,
} from '@pixelsky/protocol'

// 扩展中心「已安装」页签的纯函数（docs/ui/extension-store-client.md §2.4、§2.5）：
// 来源排序、行状态、更新那一行、筛选、全部更新的候选、停用名单那一行。不碰 window

export type InstalledFilter = 'all' | 'updates' | 'disabled'
export type InstalledCategory = 'all' | ExtPackContributionKind

/** 分类栏的顺序（和设置 › 扩展里「包含什么」一致） */
export const INSTALLED_KINDS: ExtPackContributionKind[] = [
  'grammars',
  'themes',
  'iconThemes',
  'snippets',
  'taskTemplates',
  'skills',
  'prompts',
]

const SOURCE_RANK: Record<ExtPackSource, number> = { builtin: 0, store: 1, folder: 2 }

/** 内置 → 商店 → 文件夹，同来源按添加时间从早到晚 */
export function compareBySource(
  a: Pick<ExtPackInfo, 'source' | 'addedAt'>,
  b: Pick<ExtPackInfo, 'source' | 'addedAt'>,
): number {
  return SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.addedAt - b.addedAt
}

export const sortInstalled = (packs: ExtPackInfo[]): ExtPackInfo[] => [...packs].sort(compareBySource)

/** 本机显示的版本：商店扩展用安装回执里的，其余用清单里的 */
export function packVersion(pack: ExtPackInfo): string | null {
  return pack.store?.version ?? pack.manifest?.version ?? null
}

const origin = (site: string): string => {
  try {
    return new URL(site).origin
  } catch {
    return site.replace(/\/+$/, '')
  }
}

/** 商店扩展装自别的站点：不检查更新。当前站点不知道时不算 */
export function isOtherSite(pack: ExtPackInfo, site: string | null): boolean {
  return !!pack.store && !!site && origin(pack.store.site) !== origin(site)
}

/** 这条更新信息比本机新 */
export function hasNewer(pack: ExtPackInfo, update: ExtStoreUpdate | undefined): update is ExtStoreUpdate {
  const local = packVersion(pack)
  return !!update && !!local && compareExtVersion(update.latest, local) > 0
}

export type UpdateLine =
  | { kind: 'available'; from: string; latest: string }
  | { kind: 'engineNeed'; need: string }
  | { kind: 'rollback'; to: string }
  | { kind: 'otherSite'; site: string }

/** 版本那一行的状态（决定「更新」「换回」按钮是否出现）；没有要说的返回 null */
export function updateLine(
  pack: ExtPackInfo,
  update: ExtStoreUpdate | undefined,
  site: string | null,
): UpdateLine | null {
  if (pack.source !== 'store' || !pack.store) return null
  if (isOtherSite(pack, site)) return { kind: 'otherSite', site: pack.store.site }
  if (pack.blocked) return update?.rollbackTo ? { kind: 'rollback', to: update.rollbackTo } : null
  if (!hasNewer(pack, update)) return null
  if (!update.engineOk) return { kind: 'engineNeed', need: update.engineNeed ?? '' }
  return { kind: 'available', from: pack.store.version, latest: update.latest }
}

export type RowTone = 'normal' | 'blocked' | 'shadowed'

export interface RowState {
  tone: RowTone
  blocked?: { reason: string; at: string }
  shadowedBy?: ExtPackSource
  line: UpdateLine | null
  canUpdate: boolean
  /** 换回的目标版本 */
  rollbackTo: string | null
  /** 开关灰掉：被平台停用，或清单读不出来 */
  switchDisabled: boolean
  /** 内置的不能卸载 */
  canUninstall: boolean
}

export function rowState(pack: ExtPackInfo, update: ExtStoreUpdate | undefined, site: string | null): RowState {
  const line = updateLine(pack, update, site)
  return {
    tone: pack.blocked ? 'blocked' : pack.shadowedBy ? 'shadowed' : 'normal',
    blocked: pack.blocked,
    shadowedBy: pack.shadowedBy,
    line,
    canUpdate: line?.kind === 'available',
    rollbackTo: line?.kind === 'rollback' ? line.to : null,
    switchDisabled: !!pack.blocked || pack.status === 'error',
    canUninstall: pack.source !== 'builtin',
  }
}

const updateOf = (p: ExtPackInfo, updates: ExtStoreUpdates): ExtStoreUpdate | undefined =>
  p.id ? updates[p.id] : undefined

/** 全部更新：有新版本的商店扩展，包括自己关掉的和被替代的；跳过被平台停用的、别的站点装的、新版本要更高像素星空的 */
export function updateCandidates(packs: ExtPackInfo[], updates: ExtStoreUpdates, site: string | null): ExtPackInfo[] {
  return packs.filter(p => rowState(p, updateOf(p, updates), site).canUpdate)
}

/** 逐个装，一个失败不影响后面的；返回成功和失败的个数 */
export async function runUpdateAll(
  packs: ExtPackInfo[],
  updates: ExtStoreUpdates,
  install: (id: string, version: string) => Promise<unknown>,
): Promise<{ updated: number; failed: number }> {
  let updated = 0
  let failed = 0
  for (const p of packs) {
    const u = updateOf(p, updates)
    if (!p.id || !u) continue
    try {
      await install(p.id, u.latest)
      updated++
    } catch {
      failed++
    }
  }
  return { updated, failed }
}

export interface InstalledQuery {
  query: string
  filter: InstalledFilter
  category: InstalledCategory
  updates: ExtStoreUpdates
  site: string | null
  locale: ExtLocale
}

const titleOf = (p: ExtPackInfo, locale: ExtLocale): string =>
  p.manifest ? packName(p.manifest, locale) : (p.id ?? (p.path.split(/[\\/]/).filter(Boolean).pop() || p.key))

const kindCount = (p: ExtPackInfo, kind: ExtPackContributionKind): number => p.manifest?.contributes[kind]?.length ?? 0

/** 「已停用」包括自己关掉的和被平台停用的 */
export const isDisabled = (p: ExtPackInfo): boolean => !p.enabled || !!p.blocked

/** 搜索只匹配名称、id、发布者 */
export function matchesQuery(p: ExtPackInfo, query: string, locale: ExtLocale): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [titleOf(p, locale), p.id ?? '', p.manifest?.publisher ?? ''].join('\n').toLowerCase().includes(q)
}

export function filterInstalled(packs: ExtPackInfo[], q: InstalledQuery): ExtPackInfo[] {
  return packs.filter(p => {
    if (!matchesQuery(p, q.query, q.locale)) return false
    if (q.category !== 'all' && kindCount(p, q.category) === 0) return false
    if (q.filter === 'disabled') return isDisabled(p)
    if (q.filter === 'updates') return rowState(p, updateOf(p, q.updates), q.site).canUpdate
    return true
  })
}

export interface InstalledCounts {
  all: number
  updates: number
  disabled: number
  /** 分类栏数量：含这个种类的扩展个数（按搜索和筛选算，不按已选分类算） */
  kinds: Record<ExtPackContributionKind, number>
}

export function installedCounts(packs: ExtPackInfo[], q: InstalledQuery): InstalledCounts {
  const searched = packs.filter(p => matchesQuery(p, q.query, q.locale))
  const filtered = filterInstalled(packs, { ...q, category: 'all' })
  const kinds = Object.fromEntries(
    INSTALLED_KINDS.map(k => [k, filtered.filter(p => kindCount(p, k) > 0).length]),
  ) as Record<ExtPackContributionKind, number>
  return {
    all: searched.length,
    updates: searched.filter(p => rowState(p, updateOf(p, q.updates), q.site).canUpdate).length,
    disabled: searched.filter(isDisabled).length,
    kinds,
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 本地时间 MM-DD HH:mm；读不出返回空串 */
export function formatMonthDayTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const formatMonthDay = (iso: string): string => formatMonthDayTime(iso).slice(0, 5)

export const BLOCKLIST_STALE_MS = 3 * 24 * 60 * 60 * 1000

export type BlocklistLine = { kind: 'at'; at: string } | { kind: 'stale' }

/** 顶上「停用名单：MM-DD HH:mm 更新」；超过 3 天没读到是 stale；没读到过返回 null */
export function blocklistLine(blocklistAt: string | null, now: number): BlocklistLine | null {
  if (!blocklistAt) return null
  const t = Date.parse(blocklistAt)
  if (Number.isNaN(t)) return null
  if (now - t > BLOCKLIST_STALE_MS) return { kind: 'stale' }
  return { kind: 'at', at: formatMonthDayTime(blocklistAt) }
}
