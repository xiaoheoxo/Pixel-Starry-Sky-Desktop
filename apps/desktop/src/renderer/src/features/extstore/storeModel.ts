import { compareExtVersion } from '@pixelsky/protocol'
import type {
  ExtPackContributionKind,
  ExtStoreCatalogPage,
  ExtStoreCatalogQuery,
  ExtStoreItem,
  ExtStoreProgress,
  ExtStoreSort,
  ExtStoreState,
  ExtStoreUpdate,
} from '@pixelsky/protocol'
import type { TranslationKey } from '@/i18n/core'

// 扩展商店界面的纯函数：分类和请求参数的对应、分页合并、卡片字段。不碰 window，node 测试可直接用

/** 搜索词的字数上限（和云端 MaxQueryChars 一样，多的截掉） */
export const QUERY_MAX = 100
/** 搜索框停多久才发请求（毫秒） */
export const SEARCH_DEBOUNCE_MS = 300
/** 打开扩展页时距上次查更新超过这么久才再查（毫秒） */
export const UPDATE_CHECK_INTERVAL_MS = 10 * 60_000

/** 按字（码点）截，不会把一个字截成两半 */
export function clampQuery(q: string): string {
  const chars = [...q]
  return chars.length > QUERY_MAX ? chars.slice(0, QUERY_MAX).join('') : q
}

export type StoreCategoryId =
  | 'all'
  | 'code'
  | 'ai'
  | 'grammars'
  | 'themes'
  | 'snippets'
  | 'iconThemes'
  | 'taskTemplates'
  | 'commands'
  | 'skills'
  | 'prompts'
  | 'mcp'
  | 'plugins'

export interface StoreCategory {
  id: StoreCategoryId
  label: TranslationKey
  /** 在分类栏的哪一组（all 是最上面单独一项） */
  group: 'all' | 'code' | 'ai'
  /** 第几期才有：有值就灰显、不能点 */
  phase?: 2 | 3
}

/** 分类栏，按显示顺序（方案 §2.1）；「代码模式」「AI 引擎」两个组标题本身也是可选的分类（category=code / ai） */
export const STORE_CATEGORIES: readonly StoreCategory[] = [
  { id: 'all', label: 'extensions.group.all', group: 'all' },
  { id: 'grammars', label: 'extstore.category.grammars', group: 'code' },
  { id: 'themes', label: 'extstore.category.themes', group: 'code' },
  { id: 'snippets', label: 'extstore.category.snippets', group: 'code' },
  { id: 'iconThemes', label: 'extstore.category.iconThemes', group: 'code' },
  { id: 'taskTemplates', label: 'extstore.category.taskTemplates', group: 'code' },
  { id: 'commands', label: 'extstore.category.commands', group: 'code', phase: 2 },
  { id: 'skills', label: 'extstore.category.skills', group: 'ai' },
  { id: 'prompts', label: 'extstore.category.prompts', group: 'ai' },
  { id: 'mcp', label: 'extstore.category.mcp', group: 'ai', phase: 3 },
  { id: 'plugins', label: 'extstore.category.plugins', group: 'ai', phase: 3 },
]

/** 组标题：「代码模式」「AI 引擎」 */
export const STORE_CATEGORY_GROUPS: ReadonlyArray<{ id: 'code' | 'ai'; label: TranslationKey }> = [
  { id: 'code', label: 'extensions.group.code' },
  { id: 'ai', label: 'extensions.group.ai' },
]

export const STORE_SORTS: ReadonlyArray<{ value: ExtStoreSort; label: TranslationKey }> = [
  { value: 'recommended', label: 'extstore.sort.recommended' },
  { value: 'downloads', label: 'extstore.sort.downloads' },
  { value: 'updated', label: 'extstore.sort.newest' },
]

/** 能不能选：第二期、第三期的分类只显示、不能点 */
export function isCategorySelectable(id: string): boolean {
  if (id === 'all' || id === 'code' || id === 'ai') return true
  const c = STORE_CATEGORIES.find(c => c.id === id)
  return !!c && c.phase === undefined
}

/** 发给目录接口的 category=：「全部」不传；组标题是 code / ai；其余就是贡献种类 */
export function categoryParam(id: string): string | undefined {
  return id === 'all' || !isCategorySelectable(id) ? undefined : id
}

export interface DiscoverFilter {
  q: string
  category: string
  sort: ExtStoreSort
}

/** 发现页的搜索条件 → catalog 请求参数。空搜索词、「全部」、默认排序都不传 */
export function catalogQueryOf(filter: DiscoverFilter, before?: string | null): ExtStoreCatalogQuery {
  const q = clampQuery(filter.q.trim())
  const category = categoryParam(filter.category)
  return {
    ...(q && { q }),
    ...(category && { category }),
    ...(filter.sort !== 'recommended' && { sort: filter.sort }),
    ...(before && { before }),
  }
}

/** 已取的几页合成一个列表，同 id 只留第一次出现的（翻页期间有上架 / 下架会错位） */
export function mergePages(pages: readonly ExtStoreCatalogPage[]): ExtStoreItem[] {
  const seen = new Set<string>()
  const out: ExtStoreItem[] = []
  for (const page of pages)
    for (const item of page.items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
    }
  return out
}

/** 还有下一页时返回要传的 before，没有了是 null */
export function nextBeforeOf(pages: readonly ExtStoreCatalogPage[]): string | null {
  return pages.length ? pages[pages.length - 1].nextBefore : null
}

/** 第一屏的大卡片个数 */
export const FEATURED_COUNT = 3

/** 没有搜索词、分类是「全部」、排序是「推荐」时，前 3 个画成大卡片 */
export function showsFeatured(filter: DiscoverFilter): boolean {
  return filter.q.trim() === '' && filter.category === 'all' && filter.sort === 'recommended'
}

const KIND_ORDER: ExtPackContributionKind[] = [
  'grammars',
  'snippets',
  'iconThemes',
  'themes',
  'taskTemplates',
  'skills',
  'prompts',
]

export interface CardFields {
  id: string
  name: string
  publisher: string
  official: boolean
  description: string
  version: string
  /** 认识的贡献种类，按固定顺序；未知的种类（以后的命令 / MCP）不显示 */
  kinds: ExtPackContributionKind[]
  downloads: number
  iconSrc: string
}

/** 图标地址：渲染层 CSP 不放行 https 图片，由主进程取了再经 pixelsky-ext: 协议给页面（方案 §3.9） */
export function storeIconSrc(item: Pick<ExtStoreItem, 'id' | 'version' | 'iconUrl'>): string {
  // 演示目录的图标是内联 SVG（data:，CSP 放行，不用走协议）
  if (item.iconUrl.startsWith('data:image/svg+xml')) return item.iconUrl
  return `pixelsky-ext://store-icon/${encodeURIComponent(item.id)}/${encodeURIComponent(item.version)}`
}

export function cardFields(item: ExtStoreItem): CardFields {
  return {
    id: item.id,
    name: item.name,
    publisher: item.publisher.name,
    official: item.publisher.official,
    description: item.description,
    version: item.version,
    kinds: KIND_ORDER.filter(k => item.kinds.includes(k)),
    downloads: item.downloads,
    iconSrc: storeIconSrc(item),
  }
}

/** 下载量：千位用逗号隔开（示意图「↓ 2,036」） */
export function formatDownloads(n: number): string {
  return Math.max(0, Math.trunc(n)).toLocaleString('en-US')
}

export type CardAction =
  /** 能装 */
  | { kind: 'install' }
  /** 正在下载 / 校验 / 安装；percent 是 0–100，不知道总大小时是 null */
  | { kind: 'installing'; percent: number | null; phase: ExtStoreProgress['phase'] }
  | { kind: 'installed' }
  | { kind: 'update'; version: string }
  /** 有新版本，但要求更新的像素星空 */
  | { kind: 'updateBlocked'; need: string | null }

/** 卡片右边的按钮：正在装 > 有更新 > 已装 > 安装 */
export function cardAction(input: {
  installed: boolean
  /** 本机装的版本；知道时只有商店的版本比它新才算「有更新」（换回的那种条目 latest 比本机低，不是更新） */
  installedVersion?: string | null
  update?: ExtStoreUpdate
  progress?: ExtStoreProgress
}): CardAction {
  const { installed, installedVersion, update, progress } = input
  if (progress) {
    const percent =
      progress.phase === 'downloading' && progress.total
        ? Math.min(100, Math.round((progress.received / progress.total) * 100))
        : null
    return { kind: 'installing', percent, phase: progress.phase }
  }
  if (!installed) return { kind: 'install' }
  if (update && (!installedVersion || compareExtVersion(update.latest, installedVersion) > 0)) {
    // 换回（rollbackTo）不在发现页处理，只看有没有新版本
    return update.engineOk
      ? { kind: 'update', version: update.latest }
      : { kind: 'updateBlocked', need: update.engineNeed ?? null }
  }
  return { kind: 'installed' }
}

/** 还没从主进程取到状态时用的空状态 */
export const EMPTY_STORE_STATE: ExtStoreState = { site: '', updates: {}, blocklistAt: null, installing: {} }

/** 本机从商店装了的扩展 id（发现页显示「已安装」）；内置和开发中的同 id 扩展不算：装商店版会替代它们 */
export function installedIdsOf(packs: ReadonlyArray<{ id?: string | null; source: string }>): Set<string> {
  const ids = new Set<string>()
  for (const p of packs) if (p.source === 'store' && p.id) ids.add(p.id)
  return ids
}

/** 本机从商店装了的扩展的版本（id → 版本）；装好后包列表一刷新，发现页的「更新」就跟着消失 */
export function installedVersionsOf(
  packs: ReadonlyArray<{
    id?: string | null
    source: string
    store?: { version: string } | null
    manifest?: { version: string } | null
  }>,
): Map<string, string> {
  const versions = new Map<string, string>()
  for (const p of packs) {
    const v = p.store?.version ?? p.manifest?.version
    if (p.source === 'store' && p.id && v) versions.set(p.id, v)
  }
  return versions
}

/** 一次安装结束后要不要弹提示：装好弹「已安装 / 已更新 X」（silent 不弹），失败弹原因，取消不弹 */
export type InstallToast =
  | { kind: 'installed' | 'updated' | 'rolledBack'; id: string; name: string }
  | { kind: 'failed'; id: string; name: string; reason: string }

export function installToast(result: {
  id: string
  name?: string
  ok: boolean
  kind?: 'install' | 'update'
  /** 换回旧版本：提示写「已换回」 */
  rollback?: boolean
  silent?: boolean
  /** 已翻成当前语言的失败原因 */
  reason?: string
  cancelled?: boolean
}): InstallToast | null {
  const name = result.name || result.id
  if (result.ok)
    return result.silent
      ? null
      : {
          kind: result.rollback ? 'rolledBack' : result.kind === 'update' ? 'updated' : 'installed',
          id: result.id,
          name,
        }
  if (result.cancelled || !result.reason) return null
  return { kind: 'failed', id: result.id, name, reason: result.reason }
}
