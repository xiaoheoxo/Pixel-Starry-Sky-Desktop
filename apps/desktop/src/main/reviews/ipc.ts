// AI 审查结果的 IPC（docs/mobile-app.md §15.5）：窗口启动时 reviews:load（带上 localStorage 里的旧结果迁过来一次），
// 之后每次改动 reviews:set；改了就推 reviews:changed（窗口、手机网关都收）。手机网关经 ctx.reviews 读写。
import { join } from 'node:path'
import { app } from 'electron'
import type { AppContext } from '../app/context'
import { dataRoot } from '../app/data-dir'
import * as ipc from '../ipc/guard'
import { isTurnReview, ReviewStore } from './store'

const id = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v || v.length > 300) throw new Error(`${what}参数错误`)
  return v
}

/** 同步注册通道（窗口可能比读文件先来要），读文件在后台，通道里等它读完 */
export function initReviews(ctx: AppContext): void {
  const store = new ReviewStore(join(dataRoot(), 'ai-reviews.json'))
  const ready = store.load()
  store.onChange(change => ctx.events.broadcast('reviews:changed', change))
  ipc.handle('reviews:load', async (_e, legacy: unknown) => {
    await ready
    return store.importLegacy(legacy)
  })
  ipc.handle('reviews:set', async (_e, sessionId: unknown, turnKey: unknown, review: unknown) => {
    await ready
    if (review !== null && !isTurnReview(review)) throw new Error('审查结果参数错误')
    store.set(id(sessionId, '会话'), id(turnKey, '轮次'), review)
  })
  void ready.then(() => {
    ctx.reviews = store
  })
  app.on('will-quit', () => void store.flush())
}
