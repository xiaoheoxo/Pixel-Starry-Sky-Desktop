// 换额度来源后接原线程（docs/codex-engine.md §15）：新版 Codex 线程绑死开它时的 model provider，
// thread/resume 不能换，thread/fork 能换。界面进程（session.ts）和切终端（index.ts tuiLaunch）共用
import type { SessionRecord } from '@pixelsky/protocol'
import { describeError, logger } from '../log'
import type { Message } from './process'

const log = logger('engine.codex')

interface Rpc {
  request(method: string, params: unknown, timeoutMs?: number): Promise<Message>
}

/**
 * 把会话的线程分叉到 params 里的来源，整条带过去（轮次 id 不变），返回 thread/fork 的回包；分叉失败照常抛错。
 * 原线程没有会话认了，留着会在「继续 Codex 对话」列表里多一份停在换来源之前的旧副本，所以归档（能取消归档）；
 * 从终端 / 官方应用导入的原线程还记在 imported 里、列表认得出，不动用户自己的。归档失败只记日志
 */
export async function forkToProvider(
  proc: Rpc,
  record: Pick<SessionRecord, 'engineSessionId' | 'imported'>,
  params: Message,
): Promise<Message> {
  const original = record.engineSessionId
  if (!original) throw new Error('Codex thread is missing')
  const forked = await proc.request('thread/fork', { ...params, threadId: original })
  if (original !== record.imported?.sessionId)
    await proc
      .request('thread/archive', { threadId: original }, 5_000)
      .catch(error => log.warn('原来的 Codex 线程没归档', { threadId: original, error: describeError(error) }))
  return forked
}
