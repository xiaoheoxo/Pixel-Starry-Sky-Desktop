// oh-my-pi 的旁聊（docs/omp-engine.md §11.6）：会话进程活着时直接用 omp 自带的 btw 问（和它终端里的 /btw 一样，
// 问答记进它的会话文件和 btw-history）。主轮在跑、在等确认时都能问；同时只能问一个
import type { PixelProcess, Message } from '../pixel/process'
import { object, string } from '../pixel/process'

/** 旁聊最长等多久（和 Claude、像素星空引擎一样） */
export const BTW_TIMEOUT_MS = 5 * 60_000

/** 一条 btw_record 的结果：还在跑时为 null */
export function btwOutcome(record: Message): { answer: string } | { error: string } | null {
  switch (string(record.status)) {
    case 'running':
      return null
    case 'complete': {
      const answer = string(record.answer).trim()
      return answer ? { answer } : { error: 'oh-my-pi 没有回答' }
    }
    case 'cancelled':
    case 'interrupted':
      return { error: '已停止' }
    default:
      return { error: string(object(record.error).message) || string(record.error) || 'oh-my-pi 旁聊出错了' }
  }
}

export class OmpBtw {
  private waiter: { resolve: (answer: string) => void; reject: (error: Error) => void } | null = null
  /** 这次问题在 omp 里的记录 id，以 btw 的回应为准（running 那一帧比回应先到，可能还夹着上一个的收尾帧） */
  private current: string | null = null
  /** 回应到之前就结束了的记录（按 id），回应到了再对 */
  private readonly early = new Map<string, { answer: string } | { error: string }>()
  /** 取消了、还没收尾的记录：之后到的帧不算这次的 */
  private readonly dropped = new Set<string>()

  /** 会话进程的事件先过这里：是旁聊的帧返回 true（不算主轮的动静） */
  event(raw: Message): boolean {
    const type = string(raw.type)
    if (type === 'btw_delta') return true
    if (type !== 'btw_record') return false
    const record = object(raw.record)
    const id = string(record.id)
    const result = btwOutcome(record)
    if (this.dropped.has(id)) {
      if (result) this.dropped.delete(id)
      return true
    }
    if (!this.waiter || !result) return true
    if (!this.current) this.early.set(id, result)
    else if (id === this.current) this.settle(result)
    return true
  }

  private settle(result: { answer: string } | { error: string }): void {
    const waiter = this.waiter
    this.waiter = null
    this.current = null
    this.early.clear()
    if ('answer' in result) waiter?.resolve(result.answer)
    else waiter?.reject(new Error(result.error))
  }

  /** 进程退出、换进程、会话关闭：正在问的报原因 */
  abort(reason: string): void {
    const waiter = this.waiter
    this.waiter = null
    if (this.current) this.dropped.add(this.current)
    this.current = null
    this.early.clear()
    waiter?.reject(new Error(reason))
  }

  async ask(proc: PixelProcess, question: string, signal: AbortSignal, timeoutMs = BTW_TIMEOUT_MS): Promise<string> {
    if (signal.aborted) throw new Error('已停止')
    this.abort('已停止')
    const answer = new Promise<string>((resolve, reject) => (this.waiter = { resolve, reject }))
    answer.catch(() => {})
    const cancel = (reason: string): void => {
      void proc.request('btw_cancel', {}, 2_000).catch(() => {})
      this.abort(reason)
    }
    const onAbort = (): void => cancel('已停止')
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => cancel('旁聊超时（5 分钟）'), timeoutMs)
    try {
      let reply: Message
      try {
        reply = (await proc.request('btw', { question })).data
      } catch (error) {
        // 上一个还没收尾（界面已经取消、omp 还没停）：先取消再问一次
        if (!/still running/i.test((error as Error).message)) throw error
        await proc.request('btw_cancel').catch(() => {})
        this.early.clear()
        reply = (await proc.request('btw', { question })).data
      }
      const id = string(object(reply.record).id)
      if (this.waiter && id) {
        this.current = id
        const done = this.early.get(id)
        if (done) this.settle(done)
      }
      return await answer
    } catch (error) {
      if (this.waiter) this.abort(signal.aborted ? '已停止' : (error as Error).message)
      throw signal.aborted ? new Error('已停止') : error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}
