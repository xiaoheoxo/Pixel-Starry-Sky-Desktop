import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { emptyBlocklist, normalizeBlocklist, readBlocklistFile, type BlocklistFile } from './blocklist'

// 停用名单的定时读取、存盘和节流（docs/ui/extension-store-client.md §5，计划第 ⑤ 条）。
// 不导入 service.ts：名单读到后通过 deps.apply 交给 service（market/ipc.ts 接线）。

/** 启动后多久读第一次 */
export const FIRST_READ_MS = 15_000
/** 之后每隔多久读一次 */
export const READ_INTERVAL_MS = 6 * 3600_000
/** 打开扩展页触发的读取，距上次尝试不足这么久就不真读 */
export const REFRESH_MIN_MS = 5 * 60_000
/** 名单这么久没读到就算过期（写日志、状态里 stale 为 true，界面提示） */
export const STALE_MS = 3 * 24 * 3600_000

export interface BlocklistSyncDeps {
  /** <dataDir>/blocklist.json */
  file: string
  /** 当前站点的 origin（每次读取时取，换站点后按新站点存） */
  site: () => string
  api: { blocklist(): Promise<{ updatedAt: string | null; items: unknown[] }> }
  /** 名单变了：让 service 重算 blocked 并 commit（service.applyBlocklist） */
  apply: (list: BlocklistFile) => Promise<unknown>
  now?: () => number
  log?: (message: string) => void
}

export interface BlocklistStatus {
  /** 当前站点上次读到名单的时间（ISO）；没读到过是 null */
  blocklistAt: string | null
  /** 3 天（从读到的时间，没读到过就从启动算）没读到名单 */
  stale: boolean
}

export interface BlocklistSync {
  start(): void
  stop(): void
  /** force：定时器用，不看节流；否则距上次尝试不足 5 分钟就不真读。失败不抛，保留旧名单 */
  refresh(force?: boolean): Promise<BlocklistStatus>
  status(): BlocklistStatus
}

export function createBlocklistSync(deps: BlocklistSyncDeps): BlocklistSync {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((m: string) => console.warn('[extension-packs]', m))
  let list: BlocklistFile = emptyBlocklist()
  let loaded = false
  let startedAt = now()
  let lastTry: number | null = null
  let inflight: Promise<void> | null = null
  let first: ReturnType<typeof setTimeout> | null = null
  let every: ReturnType<typeof setInterval> | null = null

  const load = (): void => {
    if (loaded) return
    loaded = true
    list = readBlocklistFile(deps.file)
  }

  const status = (): BlocklistStatus => {
    load()
    const at = list.sites[deps.site()]?.fetchedAt ?? null
    const ref = at ? Date.parse(at) : startedAt
    return { blocklistAt: at, stale: now() - (Number.isNaN(ref) ? startedAt : ref) > STALE_MS }
  }

  const persist = (next: BlocklistFile): void => {
    try {
      mkdirSync(dirname(deps.file), { recursive: true })
      const tmp = `${deps.file}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
      renameSync(tmp, deps.file)
    } catch (e) {
      log(`blocklist: could not save blocklist.json: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const read = async (): Promise<void> => {
    const site = deps.site()
    try {
      const res = await deps.api.blocklist()
      // 条目形状再检查一遍（和读文件用同一套规则），别的站点的名单原样保留
      const fetchedAt = new Date(now()).toISOString()
      const entry = normalizeBlocklist({
        version: 1,
        sites: { [site]: { fetchedAt, updatedAt: res.updatedAt ?? '', items: res.items } },
      }).sites[site]
      if (!entry) throw new Error('bad blocklist')
      list = { version: 1, sites: { ...list.sites, [site]: entry } }
      persist(list)
      await deps.apply(list)
    } catch (e) {
      // 读失败：保留上一份名单，已经停用的扩展不会被放出来
      const s = status()
      log(
        `blocklist: read failed (${e instanceof Error ? e.message : String(e)})` +
          (s.stale ? '; the list has not been read for over 3 days' : ''),
      )
    }
  }

  const refresh = async (force = false): Promise<BlocklistStatus> => {
    load()
    if (inflight) {
      await inflight
      return status()
    }
    if (!force && lastTry !== null && now() - lastTry < REFRESH_MIN_MS) return status()
    lastTry = now()
    inflight = read().finally(() => {
      inflight = null
    })
    await inflight
    return status()
  }

  return {
    start() {
      if (first || every) return
      load()
      startedAt = now()
      first = setTimeout(() => {
        first = null
        void refresh(true)
        every = setInterval(() => void refresh(true), READ_INTERVAL_MS)
        every.unref()
      }, FIRST_READ_MS)
      first.unref()
    },
    stop() {
      if (first) clearTimeout(first)
      if (every) clearInterval(every)
      first = every = null
    },
    refresh,
    status,
  }
}
