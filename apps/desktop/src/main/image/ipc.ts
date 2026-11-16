// 云端生图（docs/ui/image-gen.md §6）：只在本机。生成在后台跑（job.ts），条目经引擎宿主放进对话（putItem），
// 界面跟着会话事件刷新；完成后按请求 id 查实扣，写到卡片上
import { randomUUID } from 'node:crypto'
import type { AppContext } from '../app/context'
import { signedInEmail } from '../account/account'
import { cloudImageArgs, cloudImageItem, cloudImageMeta } from '../core/image/cloud-image'
import * as ipc from '../ipc/guard'
import { machineOf } from '../machines/identity'
import { logger } from '@pixelsky/engine'
import { cancelCloudImage, startCloudImage } from './job'

const log = logger('image')

export function initImage(ctx: AppContext): void {
  ipc.handle('image:generate', async (_e, input: unknown): Promise<{ itemId: string }> => {
    const req = cloudImageArgs(input)
    if (machineOf(req.sessionId) !== 'local') throw new Error('远程机器上的对话暂时不能云端生图')
    const account = signedInEmail()
    if (!account) throw new Error('请先登录像素星空账号')
    const host = ctx.engine
    if (!host) throw new Error('引擎还没准备好')
    if (!host.record(req.sessionId)) throw new Error('会话不存在')
    const itemId = `cloudimg-${randomUUID()}`
    const put = (item: Parameters<typeof host.putItem>[1]): void => {
      try {
        host.putItem(req.sessionId, item)
      } catch (error) {
        // 会话这期间被删了：不再写
        log.warn('生图条目写不进会话', { error: (error as Error).message })
      }
    }
    void startCloudImage(itemId, account, req, put)
      .then(async ({ images, cost }) => {
        const usd = await cost()
        if (usd !== null)
          put(cloudImageItem(itemId, req, { status: 'completed', images, output: cloudImageMeta(req, usd) }))
      })
      .catch(() => {
        /* 失败、停止的条目 runCloudImage 已经放了，日志在 job.ts */
      })
    return { itemId }
  })

  ipc.handle('image:cancel', (_e, itemId: unknown): void => {
    if (typeof itemId === 'string') cancelCloudImage(itemId)
  })
}
