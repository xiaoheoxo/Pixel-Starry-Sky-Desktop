// 云端生图（docs/ui/image-gen.md §6）：只在本机；令牌不出主进程（platformFetch）。
// 生成在后台跑，条目经引擎宿主放进对话（putItem），界面跟着会话事件刷新；完成后按请求 id 查实扣，写到卡片上
import { randomUUID } from 'node:crypto'
import type { PlatformCharge } from '@pixelsky/protocol'
import type { AppContext } from '../app/context'
import { platformFetch, signedInEmail } from '../account/account'
import { cloudImageArgs, cloudImageItem, cloudImageMeta, runCloudImage } from '../core/image/cloud-image'
import * as ipc from '../ipc/guard'
import { machineOf } from '../machines/identity'
import { platformCharges } from '../platform/billing'
import { logger } from '@pixelsky/engine'

const log = logger('image')
/** 查实扣：Sub2api 记账有延迟，隔几次再查 */
const CHARGE_WAITS = [1500, 3000, 6000, 12000]

export function initImage(ctx: AppContext): void {
  const running = new Map<string, AbortController>()

  ipc.handle('image:generate', async (_e, input: unknown): Promise<{ itemId: string }> => {
    const req = cloudImageArgs(input)
    if (machineOf(req.sessionId) !== 'local') throw new Error('远程机器上的对话暂时不能云端生图')
    const account = signedInEmail()
    if (!account) throw new Error('请先登录像素星空账号')
    const host = ctx.engine
    if (!host) throw new Error('引擎还没准备好')
    if (!host.record(req.sessionId)) throw new Error('会话不存在')
    const itemId = `cloudimg-${randomUUID()}`
    const requestId = `pixelsky-${randomUUID()}`
    const abort = new AbortController()
    running.set(itemId, abort)
    const startedAt = Date.now()
    const put = (item: Parameters<typeof host.putItem>[1]): void => {
      try {
        host.putItem(req.sessionId, item)
      } catch (error) {
        // 会话这期间被删了：不再写
        log.warn('生图条目写不进会话', { error: (error as Error).message })
      }
    }
    void runCloudImage(itemId, requestId, req, { fetch: platformFetch, put, signal: abort.signal })
      .then(async ({ chargeId, images }) => {
        log.info('云端生图完成', { group: req.groupId, n: images.length, size: req.size })
        const wanted = chargeId ?? requestId
        for (const wait of CHARGE_WAITS) {
          await new Promise(r => setTimeout(r, wait))
          let charges: PlatformCharge[]
          try {
            charges = await platformCharges(
              {
                account,
                startedAt,
                complete: true,
                requests: [{ id: requestId, chargeId: wanted, model: '', groupId: req.groupId }],
              },
              AbortSignal.timeout(20_000),
            )
          } catch {
            return
          }
          const mine = charges.filter(c => c.requestId === wanted)
          if (!mine.length) continue
          const cost = mine.reduce((sum, c) => sum + c.costUsd, 0)
          put(cloudImageItem(itemId, req, { status: 'completed', images, output: cloudImageMeta(req, cost) }))
          return
        }
      })
      .catch(error => {
        if (!abort.signal.aborted) log.warn('云端生图失败', { group: req.groupId, error: (error as Error).message })
      })
      .finally(() => running.delete(itemId))
    return { itemId }
  })

  ipc.handle('image:cancel', (_e, itemId: unknown): void => {
    if (typeof itemId === 'string') running.get(itemId)?.abort()
  })
}
