// Codex 的回退 / 分叉截断点（docs/ui/rewind-fork-sidechat.md、docs/codex-engine.md）：
// 像素星空发消息时把自己的消息 id 当作 clientUserMessageId 传给 Codex，轮次列表里用户消息带 clientId，据此定位。
// 截断点 at = 最后保留的那一轮的 turn id；null = 一轮都不保留。
import { FULL_PAGE } from './native'
import { array, object, string, type CodexProcess } from './process'

/** 一轮：turn id + 这一轮里用户消息的 clientId（按出现顺序） */
export interface CodexTurnInfo {
  id: string
  clientIds: string[]
}

/** 从 thread/turns/list 的一条 turn 提取 id 和用户消息的 clientId */
export function turnInfo(raw: unknown): CodexTurnInfo {
  const turn = object(raw)
  const clientIds: string[] = []
  for (const item of array(turn.items)) {
    const it = object(item)
    if (it.type === 'userMessage' && typeof it.clientId === 'string' && it.clientId) clientIds.push(it.clientId)
  }
  return { id: string(turn.id), clientIds }
}

export interface AnchorOptions {
  /**
   * 对话里的用户条目 id 是 Codex 的 turn id（从终端导入的线程，docs/ui/codex-resume.md §4.3）：
   * 每一轮都能对位，被移除的消息都不在线程里就是「保留全部」，不算「老会话找不到」
   */
  byTurnId?: boolean
}

/** 一轮里 turn/steer 追加的引导消息，导入时的条目 id 是 <turn id>-u<n> */
const steerOf = (turn: CodexTurnInfo, id: string): boolean => {
  if (!id.startsWith(`${turn.id}-u`)) return false
  const n = id.slice(turn.id.length + 2)
  return n.length > 0 && /^\d+$/.test(n)
}

/**
 * 按被移除的用户消息 id 求截断点（id 是用户消息的 clientId，或者这一轮的 turn id，或者这一轮的引导消息 <turn id>-u<n>）：
 * 1. 最早含有被移除消息的那一轮 → at = 它的前一轮（没有前一轮 → null，一轮都不保留）；
 *    但这一轮的第一条用户话还保留着（只移除了后面的引导消息，或 clientId 只移除了一部分）→ Codex 不能只回退半轮，返回 null（找不到）；
 * 2. 被移除的消息都不在记录里，但轮次带 clientId（它们没发到 Codex），或 byTurnId → at = 最后一轮，unchanged：什么都不删；
 * 3. 记录里没有任何 clientId（不是像素星空发的老会话）或读不到 → null（调用方按「找不到」处理）。
 * turn id 无条件参与匹配：像素星空的消息 id 是 UUID v4、turn id 是 v7，不会误中
 */
export function codexAnchor(
  turns: readonly CodexTurnInfo[],
  removedIds: readonly string[],
  opts: AnchorOptions = {},
): { at: string | null; unchanged?: true } | null {
  const removed = new Set(removedIds)
  const hit = (turn: CodexTurnInfo): { first: boolean; steer: boolean; client: boolean } => ({
    first: removed.has(turn.id),
    client: turn.clientIds.some(id => removed.has(id)),
    steer: removedIds.some(id => steerOf(turn, id)),
  })
  const index = turns.findIndex(turn => {
    const h = hit(turn)
    return h.first || h.client || h.steer
  })
  if (index >= 0) {
    const turn = turns[index]
    const h = hit(turn)
    // 按 turn id 匹配的（导入来的轮次）：这一轮的第一条都被移除了，后面的引导消息必然一起移除；
    // 这样的轮次可能同时带 clientId（像素星空以前发的），那些 clientId 对应的是第一条，不能当成「保留的消息」
    if (!h.first) {
      // 第一条保留着：只移除了引导消息，或 turn/steer 把引导追加进了当前轮、clientId 没全移除。整轮截不开，按「找不到」处理
      if (!h.client || turn.clientIds.some(id => !removed.has(id))) return null
    }
    return { at: index === 0 ? null : turns[index - 1].id }
  }
  if (turns.length > 0 && (opts.byTurnId || turns.some(turn => turn.clientIds.length > 0)))
    return { at: turns[turns.length - 1].id, unchanged: true }
  return null
}

/**
 * 回退时传给 thread/revert 的 beforeTurnId：at 的下一轮；at 已是最后一轮返回 null（不用动）；
 * 找不到 at 返回 'missing'
 */
export function revertTarget(turns: readonly CodexTurnInfo[], at: string): string | null | 'missing' {
  const index = turns.findIndex(turn => turn.id === at)
  if (index < 0) return 'missing'
  return turns[index + 1]?.id ?? null
}

/**
 * 翻页读完整个线程的轮次（升序）。冷读：不需要先 resume，不会把线程加载进来。
 * full 视图每页只取 FULL_PAGE 轮：不带 limit 时长线程一页能超过协议帧上限（process.ts），进程会被结束
 */
export async function readCodexTurns(proc: CodexProcess, threadId: string): Promise<CodexTurnInfo[]> {
  const turns: CodexTurnInfo[] = []
  let cursor: string | null = null
  // 页数上限只是防止异常的游标死循环
  for (let page = 0; page < 20_000; page++) {
    const reply: Record<string, unknown> = await proc.request('thread/turns/list', {
      threadId,
      sortDirection: 'asc',
      itemsView: 'full',
      limit: FULL_PAGE,
      ...(cursor ? { cursor } : {}),
    })
    for (const raw of array(reply.data)) turns.push(turnInfo(raw))
    cursor = typeof reply.nextCursor === 'string' && reply.nextCursor ? reply.nextCursor : null
    if (!cursor) return turns
  }
  throw new Error('Codex turn list did not end')
}
