// 云端生图的一次生成（docs/ui/image-gen.md §6、docs/ui/channel-image-gen.md §3.1）：会话和频道共用。
// 令牌不出主进程（platformFetch）；生成在后台跑，进度经 put 交给调用方（会话写条目、频道推临时行）；完成后按请求 id 查实扣
import { randomUUID } from 'node:crypto'
import type { ImageAttachment, Item, PlatformCharge } from '@pixelsky/protocol'
import { logger } from '@pixelsky/engine'
import { platformFetch } from '../account/account'
import { runCloudImage, type CloudImageRequest } from '../core/image/cloud-image'
import { platformCharges } from '../platform/billing'
import { fitImage } from './fit'

const log = logger('image')
/** 查实扣：Sub2api 记账有延迟，隔几次再查 */
const CHARGE_WAITS = [1500, 3000, 6000, 12000]

const running = new Map<string, AbortController>()

/** 停掉一次生成（id 是 startCloudImage 的 id）；不在跑的不管 */
export function cancelCloudImage(id: string): void {
  running.get(id)?.abort()
}

export interface CloudImageDone {
  images: ImageAttachment[]
  /** 实扣（美元）：查实扣用，查到前不阻塞 */
  cost: () => Promise<number | null>
}

/** 开始生成：返回的 Promise 在图收齐时完成（失败、停止时拒绝，put 已经放过对应状态的条目） */
export function startCloudImage(
  id: string,
  account: string,
  req: CloudImageRequest,
  put: (item: Item) => void,
): Promise<CloudImageDone> {
  const requestId = `pixelsky-${randomUUID()}`
  const abort = new AbortController()
  running.set(id, abort)
  const startedAt = Date.now()
  return runCloudImage(id, requestId, req, {
    fetch: platformFetch,
    put,
    signal: abort.signal,
    fit: image => fitImage(image),
  })
    .then(({ chargeId, images }) => {
      log.info('云端生图完成', { group: req.groupId, n: images.length, size: req.size })
      return { images, cost: () => chargeOf(account, startedAt, requestId, chargeId ?? requestId, req.groupId) }
    })
    .catch(error => {
      if (!abort.signal.aborted) log.warn('云端生图失败', { group: req.groupId, error: (error as Error).message })
      throw error
    })
    .finally(() => running.delete(id))
}

/** 按请求 id 查实扣，查不到（记账延迟太久、查询失败）是 null */
async function chargeOf(
  account: string,
  startedAt: number,
  requestId: string,
  wanted: string,
  groupId: string,
): Promise<number | null> {
  for (const wait of CHARGE_WAITS) {
    await new Promise(r => setTimeout(r, wait))
    let charges: PlatformCharge[]
    try {
      charges = await platformCharges(
        { account, startedAt, complete: true, requests: [{ id: requestId, chargeId: wanted, model: '', groupId }] },
        AbortSignal.timeout(20_000),
      )
    } catch {
      return null
    }
    const mine = charges.filter(c => c.requestId === wanted)
    if (mine.length) return mine.reduce((sum, c) => sum + c.costUsd, 0)
  }
  return null
}
