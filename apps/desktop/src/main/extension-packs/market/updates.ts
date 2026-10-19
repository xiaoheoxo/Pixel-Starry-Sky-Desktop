import { compareExtVersion, satisfiesEngine } from '@pixelsky/protocol'
import type { ExtPackInfo, ExtStoreDetail, ExtStoreUpdate, ExtStoreUpdates } from '@pixelsky/protocol'
import type { StoreApi } from './api'
import { engineNeed } from './engine'
import { keyStatus, type DevKeySource, type StoreKey } from './keys'

// 检查更新（docs/ui/extension-store-client.md §2.5）：只查「当前站点装的商店扩展」，每个取一次详情（绕过缓存），
// 最多同时 4 个。不导入 service.ts，扩展列表由 market/ipc.ts 传进来。

const CONCURRENCY = 4
/** 打开扩展页时的自动检查：距上次查完不到这么久就直接回上次的结果 */
export const AUTO_CHECK_INTERVAL_MS = 10 * 60_000

export interface UpdatesDeps {
  api: Pick<StoreApi, 'detail'>
  site: () => string
  packs: () => ExtPackInfo[]
  appVersion: string
  /** 停用名单里有没有这个站点的这个版本（换回只退到没被停用的版本） */
  blocked: (site: string, id: string, version: string) => unknown
  /** 钥匙表和开发版钥匙来源（测试注入；不传用 market/keys.ts 的） */
  keys?: { table?: StoreKey[]; dev?: DevKeySource }
  now?: () => number
  /** 结果有变化（要推 extstore:changed） */
  onChange?: () => void
  log?: (message: string) => void
}

export interface Updates {
  /**
   * 查一遍。同时在飞的只发一轮（后来的拿同一个 Promise）；
   * maxAgeMs：上次查完不到这么久就直接回上次的结果（打开扩展页的自动检查用 10 分钟；点「检查更新」不传，立刻查）。
   */
  check(opts?: { maxAgeMs?: number }): Promise<ExtStoreUpdates>
  /** 上次的结果（给 extstore:state），没查过是空对象 */
  last(): ExtStoreUpdates
}

/** 详情里最新版本的清单要求的像素星空版本；写法不认识或没有要求时按满足算 */
function engineOf(detail: ExtStoreDetail, appVersion: string): { ok: boolean; need?: string } {
  const range = detail.manifest?.engines?.pixelsky
  if (typeof range !== 'string') return { ok: true }
  return satisfiesEngine(range, appVersion) === false ? { ok: false, need: engineNeed(range) } : { ok: true }
}

export function createUpdates(deps: UpdatesDeps): Updates {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((message: string) => console.warn('[extension-store]', message))
  let result: ExtStoreUpdates = {}
  let checkedAt = Number.NEGATIVE_INFINITY
  let inflight: Promise<ExtStoreUpdates> | null = null

  /** 详情里这个版本是用已作废的钥匙签的吗；详情里找不到这个版本的钥匙 id 时按没作废算（真装的时候 verify 会拦） */
  function revokedKey(detail: ExtStoreDetail, version: string, site: string): boolean {
    const entry =
      detail.versions?.find(v => v.version === version) ?? (detail.latest?.version === version ? detail.latest : null)
    if (!entry?.keyId) return false
    return keyStatus(entry.keyId, site, deps.keys?.table, deps.keys?.dev) === 'revoked'
  }

  async function one(info: ExtPackInfo, site: string): Promise<[string, ExtStoreUpdate] | null> {
    const local = info.store
    if (!local || !info.id) return null
    let detail: ExtStoreDetail
    try {
      detail = await deps.api.detail(info.id, { fresh: true })
    } catch (e) {
      // 404：已下架或停用，不算更新；别的错误这次跳过这个扩展
      if ((e as { status?: unknown })?.status !== 404) log(`check update ${info.id} failed: ${(e as Error).message}`)
      return null
    }
    const latest = detail.extension.version
    const cmp = compareExtVersion(latest, local.version)
    const engine = engineOf(detail, deps.appVersion)
    const need = engine.need ? { engineNeed: engine.need } : {}
    if (cmp > 0) return [info.id, { latest, engineOk: engine.ok, ...need }]
    // 本机这版被停用、商店里「最新」退回到了更早的可用版本：给换回
    // 签那个版本的钥匙已作废的不换回（装的时候会被拒）
    if (cmp < 0 && info.blocked && !deps.blocked(site, info.id, latest) && !revokedKey(detail, latest, site))
      return [info.id, { latest, engineOk: engine.ok, ...need, rollbackTo: latest }]
    return null
  }

  async function run(): Promise<ExtStoreUpdates> {
    const site = deps.site()
    const targets = deps.packs().filter(p => p.source === 'store' && p.store?.site === site)
    const out: ExtStoreUpdates = {}
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const info = targets[next++]
        if (!info) return
        const hit = await one(info, site)
        if (hit) out[hit[0]] = hit[1]
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker))
    return out
  }

  return {
    check(opts = {}) {
      if (opts.maxAgeMs !== undefined && now() - checkedAt < opts.maxAgeMs) return Promise.resolve(result)
      if (inflight) return inflight
      const p = run()
        .then(out => {
          const changed = JSON.stringify(out) !== JSON.stringify(result)
          result = out
          checkedAt = now()
          if (changed) deps.onChange?.()
          return out
        })
        .finally(() => {
          inflight = null
        })
      inflight = p
      return p
    },
    last: () => result,
  }
}
