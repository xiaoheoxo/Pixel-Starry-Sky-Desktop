// 回退（可恢复代码、可撤销）、分叉、旁聊（docs/ui/rewind-fork-sidechat.md §1–§3）
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'
import { normalizeSessionTitle } from '@pixelsky/protocol'
import type {
  EngineId,
  EngineSessionState,
  ForkOptions,
  ForkResult,
  Item,
  NoticeBranchMerge,
  PendingMerge,
  RewindCodePreview,
  RewindOptions,
  RewindPreview,
  RewindResult,
  SessionBranch,
  SessionRecord,
  SideTurn,
} from '@pixelsky/protocol'
import { CHECKPOINT_EXPIRED } from '../checkpoints'
import { ENGINES } from '../registry'
import type { HostContext } from './context'
import { lastTurnReply } from './events'
import { derivedSeen, lastItemId } from './handoff'

/** 合并回来的分支摘要带给 AI 时的说法（docs/ui/branch-merge.md §5.2） */
export function mergeContext(merge: PendingMerge): string {
  return [
    `[分支合并] 用户在分支会话「${merge.title}」里接着这段对话试了一个方案，已经合并回来。下面是那边的摘要，接着回答时以它为准：`,
    merge.summary.trim(),
    '[分支合并结束]',
  ].join('\n')
}

/** 还原代码前存一份当前内容，总共超过这个大小就不提供代码撤销 */
export const UNDO_LIMIT = 20 * 1024 * 1024

interface UndoEntry {
  /** 回退移除的条目；只恢复代码时为空 */
  removed: Item[]
  /** 回退时保留的条目数（之后回退可能加了一条提示，撤销时去掉） */
  kept: number
  before: RewindState
  /** 回退后的状态：撤销时要求没变（没发新消息、引擎没接着跑） */
  after: RewindState & {
    count: number
    lastId: string | null
  }
  /** 还原前的文件内容；null 内容表示当时文件不存在。没动代码时为 null */
  files: { path: string; data: Buffer | null }[] | null
}

type UserItem = Extract<Item, { kind: 'user' }>

/** 回退会动到的会话记录字段（撤销时整体放回） */
type RewindState = Pick<
  SessionRecord,
  'engineSessionId' | 'pendingRewind' | 'pendingFork' | 'engineSessions' | 'nextEngine' | 'lastReply'
>

const rewindState = (record: SessionRecord): RewindState => ({
  engineSessionId: record.engineSessionId,
  pendingRewind: record.pendingRewind ?? null,
  pendingFork: record.pendingFork ?? null,
  engineSessions: record.engineSessions,
  nextEngine: record.nextEngine ?? null,
  lastReply: record.lastReply ?? null,
})

export class HostBranch {
  /** 每个会话最近一次回退，只在内存里（重启后不能撤销） */
  private readonly undo = new Map<string, UndoEntry>()
  private readonly sideQuestions = new Map<string, AbortController>()

  constructor(private readonly ctx: HostContext) {}

  private userItem(id: string, userItemId: string): { index: number; target: UserItem } {
    const rt = this.ctx.m.sessions.runtime(id)
    const index = rt.snapshot.items.findIndex(item => item.id === userItemId)
    const target = rt.snapshot.items[index]
    if (!target || target.kind !== 'user' || target.mode === 'guidance') throw new Error('只能回退到自己发送的消息')
    return { index, target }
  }

  /** 放回输入框的消息：快照里截掉了图片数据（cutItem），从磁盘补回；补不回来用截过的 */
  private full(id: string, target: UserItem): UserItem {
    return (this.ctx.store.body(id, target) as UserItem | null) ?? target
  }

  private assertIdle(id: string): void {
    const { ctx } = this
    if (ctx.closing) throw new Error('应用正在退出')
    if (ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const rt = ctx.m.sessions.runtime(id)
    // 等着的 / 派发中的自动重连会按对话里的原消息发「继续」，回退会把它删掉：先停止再回退
    if (rt.snapshot.queue.some(q => q.reconnect && !q.held && (q.status === 'queued' || q.status === 'dispatching')))
      throw new Error('正在自动重连，请先停止再回退')
    if (rt.snapshot.state !== 'idle' || rt.pumping || rt.stopping || rt.activeId || rt.inspectingContext)
      throw new Error('请先停止当前任务再回退')
  }

  /** 关掉会话进程：它的上下文和文件检查点状态都要重新读 */
  private async closeProcess(id: string): Promise<void> {
    const rt = this.ctx.m.sessions.runtime(id)
    const old = rt.session
    rt.session = null
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer)
      rt.idleTimer = null
    }
    await old?.close()
  }

  /** 回退前检查代码：要还原哪些文件 */
  async rewindPreview(id: string, userItemId: string): Promise<RewindPreview> {
    const snapshot = this.ctx.m.sessions.runtime(id).snapshot
    const { index } = this.userItem(id, userItemId)
    const code = await this.codePreview(snapshot.record, userItemId)
    // 没有检查点、而且这条在压缩之前：说清楚是压缩的缘故（GitHub #82）
    if (!code.ok && code.reason === 'no-checkpoint' && (await this.beforeCompaction(id, index, userItemId)))
      return { code: { ...code, reason: 'compacted' } }
    return { code }
  }

  /**
   * 这条用户消息在上下文压缩之前：对话里它后面有压缩，或者引擎记录里它排在最近一次压缩之前
   * （回退把对话里的压缩条目截掉以后，只能看记录）
   */
  private async beforeCompaction(id: string, index: number, userItemId: string): Promise<boolean> {
    const snapshot = this.ctx.m.sessions.runtime(id).snapshot
    if (compactedAfter(snapshot.items, index)) return true
    try {
      return (await this.ctx.adapters[snapshot.record.engine]?.beforeCompaction?.(snapshot.record, userItemId)) ?? false
    } catch {
      return false
    }
  }

  private async codePreview(record: SessionRecord, userItemId: string): Promise<RewindCodePreview> {
    const checkpoints = this.ctx.m.checkpoints
    // 有对话检查点（docs/ui/undo-changes.md）先用它：任何引擎都行，能只还原其中几个文件
    if (checkpoints.has(record.id, userItemId)) {
      const own = await checkpoints.preview(record.id, userItemId)
      if (own.ok || own.reason !== 'expired') return own
    }
    // 对话检查点失效了：试引擎自己的检查点，也没有就说快照失效
    const engine = await this.engineCodePreview(record, userItemId)
    if (!engine.ok && checkpoints.expired(record.id, userItemId))
      return { ok: false, reason: 'expired', message: CHECKPOINT_EXPIRED }
    return engine
  }

  private async engineCodePreview(record: SessionRecord, userItemId: string): Promise<RewindCodePreview> {
    const adapter = this.ctx.adapters[record.engine]
    if (!ENGINES[record.engine].caps.rewindCode || !adapter?.rewindFiles) return { ok: false, reason: 'unsupported' }
    if (!record.engineSessionId) return { ok: false, reason: 'no-checkpoint' }
    let reply
    try {
      reply = await adapter.rewindFiles(record, userItemId, true)
    } catch (err) {
      return { ok: false, reason: 'no-checkpoint', message: (err as Error).message }
    }
    if (!reply.ok) return { ok: false, reason: reply.reason, message: reply.message }
    let size = 0
    for (const file of reply.files) {
      try {
        size += statSync(file).size
      } catch {
        // 文件现在不存在：撤销时删掉还原出来的文件即可
      }
    }
    return {
      ok: true,
      files: reply.files.map(file => displayPath(record.cwd, file)),
      insertions: reply.insertions,
      deletions: reply.deletions,
      undoable: size <= UNDO_LIMIT,
    }
  }

  /**
   * 回退到某条用户消息之前：对话（移除它及之后的全部对话，引擎下次从它之前接上）和 / 或代码（文件改回它之前）。
   * 只在空闲时可用；回退对话时返回被移除消息的原文和图片，界面放回输入框。
   */
  async rewind(
    id: string,
    userItemId: string,
    options: RewindOptions = { conversation: true, code: false },
  ): Promise<RewindResult> {
    const { ctx } = this
    const m = ctx.m
    this.assertIdle(id)
    const rt = m.sessions.runtime(id)
    const record = rt.snapshot.record
    if (!options.conversation && !options.code) throw new Error('请选择要恢复的内容')
    // 引擎不能回退对话时，有对话检查点的消息仍能只恢复代码（docs/ui/undo-changes.md §4）
    const codeOnly =
      !options.conversation && (m.checkpoints.has(id, userItemId) || m.checkpoints.expired(id, userItemId))
    if (!ENGINES[record.engine].caps.rewind && !codeOnly) throw new Error('当前引擎暂不支持回退')
    const { index, target } = this.userItem(id, userItemId)
    const before = rewindState(record)
    ctx.changingSessions.add(id)
    try {
      await this.closeProcess(id)
      let files: UndoEntry['files'] = null
      let codeSkipped: string | undefined
      if (options.code)
        try {
          files = await this.restoreCode(record, userItemId, options.paths)
        } catch (err) {
          // 只恢复代码时照旧报错；同时回退对话时对话照样回退，告诉界面代码没恢复（GitHub #82）
          if (!options.conversation) throw err
          codeSkipped =
            !m.checkpoints.expired(id, userItemId) && (await this.beforeCompaction(id, index, userItemId))
              ? '这条消息在上下文压缩之前，Claude Code 只保留压缩之后的代码检查点，代码保持不变'
              : (err as Error).message
        }
      const removed = options.conversation ? rt.snapshot.items.slice(index) : []
      if (options.conversation) await this.truncate(id, index, userItemId)
      const now = m.sessions.runtime(id).snapshot
      this.undo.set(id, {
        removed,
        kept: options.conversation ? index : now.items.length,
        before,
        after: {
          ...rewindState(now.record),
          count: now.items.length,
          lastId: now.items.at(-1)?.id ?? null,
        },
        files,
      })
      m.events.patchRecord(id, { updatedAt: Date.now() })
      // 截断后它在回退前的条目文件里（keepOld），图片数据从那里补回
      const images = options.conversation ? this.full(id, target).attachments : undefined
      return {
        text: options.conversation ? target.text : '',
        ...(images?.length ? { attachments: images } : {}),
        ...(options.conversation && target.files?.length ? { files: target.files } : {}),
        ...(files ? { filesRestored: files.length } : {}),
        ...(codeSkipped ? { codeSkipped } : {}),
        undoable: !options.code || files !== null || codeSkipped !== undefined,
      }
    } finally {
      ctx.changingSessions.delete(id)
    }
  }

  /** 还原文件；先存一份当前内容（太大时不存，返回 null 表示还原了但不能撤销代码）。paths 只对对话检查点有效 */
  private async restoreCode(record: SessionRecord, userItemId: string, paths?: string[]): Promise<UndoEntry['files']> {
    const checkpoints = this.ctx.m.checkpoints
    if (checkpoints.has(record.id, userItemId)) {
      const restored = await checkpoints.restore(record.id, userItemId, paths)
      if (restored) return restored.saved
    }
    // 对话检查点失效了（restore 返回 null 或之前预览时查出来的）：改用引擎自己的检查点
    const none = checkpoints.expired(record.id, userItemId)
      ? CHECKPOINT_EXPIRED
      : '这条消息没有代码检查点，代码保持不变'
    // 只勾了其中几个文件：引擎的检查点只能整轮还原，会把没勾的（可能是手改的）也改回去，宁可不还原
    if (paths) throw new Error(none)
    const adapter = this.ctx.adapters[record.engine]
    if (!ENGINES[record.engine].caps.rewindCode || !adapter?.rewindFiles || !record.engineSessionId)
      throw new Error(none)
    // 一个辅助进程里先预览、存一份当前内容、再还原（GitHub #35：原来预览和还原各起一次进程）
    let size = 0
    const saved: { path: string; data: Buffer | null }[] = []
    const done = await adapter.rewindFiles(record, userItemId, false, files => {
      for (const path of files) {
        const data = existsSync(path) ? readFileSync(path) : null
        size += data?.length ?? 0
        saved.push({ path, data })
      }
    })
    if (!done.ok) throw new Error(done.reason === 'no-checkpoint' ? none : done.message || '没能还原代码')
    return size <= UNDO_LIMIT ? saved : null
  }

  /** 截断对话（原来的回退逻辑，docs/ui/chat-fixes-queue-actions-cost.md §2.3） */
  private async truncate(id: string, index: number, userItemId: string): Promise<void> {
    const { ctx } = this
    const m = ctx.m
    const rt = m.sessions.runtime(id)
    const record = rt.snapshot.record
    const adapter = ctx.adapters[record.engine]
    const users = rt.snapshot.items.slice(index).filter(item => item.kind === 'user')
    // 只算当前引擎处理过的用户消息：其他引擎处理的不在它的上下文里，不用在它的记录里回退
    const own = users.filter(item => (item.engine ?? record.engine) === record.engine).map(item => item.id)
    // Claude 的原生记录里带着接力写进去的其他引擎轮次（uuid 就是我们的条目 id）：截断点之后所有用户消息都要交给适配器找，
    // 否则落在下一条 Claude 消息的 parent 上，被回退的接力轮次还留在上下文里。Codex 自己挑会话 id、不写这种行，保持原样
    const seeded = !!adapter?.seedsHistory && !adapter.enginePicksSessionId
    const dropped = seeded ? users.map(item => item.id) : own
    // Codex 要起临时进程读轮次，所以可能是异步的
    // 分叉出来还没启动的会话（Codex）没有自己的线程：截断点要回到来源线程里重新算
    const forkOnly = !record.engineSessionId && record.pendingFork ? record.pendingFork : null
    const thread = record.engineSessionId ?? forkOnly?.from ?? null
    const found =
      thread && dropped.length > 0
        ? await adapter?.rewindAnchor?.({ ...record, engineSessionId: thread }, dropped)
        : null
    // 被回退的消息都不是当前引擎处理的、也没有写进它的记录：它的原生会话原样保留
    const untouched = !!thread && own.length === 0 && (!seeded || !found)
    const anchor = untouched ? null : found
    // 引擎自己分配会话 id（Codex）时写 null，启动时新建；其他引擎我们预先给一个
    const freshId = (): string | null => (adapter?.enginePicksSessionId ? null : randomUUID())
    const kept = rt.snapshot.items.slice(0, index)
    // 回退前当前引擎读到哪里：旧记录（没有 engineSessions）读到了全部对话
    const old = record.engineSessions
    const oldEntry = old?.[record.engine]
    const oldSeen = oldEntry ? oldEntry.seen : old ? null : lastItemId(rt.snapshot.items)
    // 留着回退前的条目文件：撤销时放回的条目从它补回截掉的大字段
    ctx.store.replaceItems(id, kept, { keepOld: true })
    m.events.apply(id, { type: 'items_truncated', fromItemId: userItemId })
    m.cache.reset(id)
    // Missing native records must never silently preserve the discarded context.
    let patch: Partial<SessionRecord>
    // 引擎原生记录里的截断点找到了：它的上下文保留到那里
    let worked = untouched
    if (untouched) patch = {}
    else if (anchor?.unchanged) {
      // 被回退的消息都没进过引擎的记录（启动失败、还没发出去）：线程里什么都不用动，待执行的回退 / 分叉原样保留
      // （改成线程「现在」的最后一轮会把终端里之后新聊的轮次也带进来，还会盖掉更早的待回退）
      worked = true
      patch = {}
    } else if (anchor && forkOnly) {
      worked = !!anchor.at
      patch = anchor.at
        ? { pendingFork: { from: forkOnly.from, at: anchor.at } }
        : { engineSessionId: freshId(), pendingRewind: null, pendingFork: null }
    } else if (anchor) {
      worked = !!anchor.at
      patch = anchor.at ? { pendingRewind: anchor.at } : { engineSessionId: freshId(), pendingRewind: null }
    } else
      patch = {
        engineSessionId: freshId(),
        pendingRewind: null,
        ...(forkOnly ? { pendingFork: null } : {}),
      }
    // 跨引擎游标：当前引擎没接上就是新会话，什么都没看到，下一条消息带完整交接；
    // 接上了：原来读到的位置还在保留的对话里就不变，否则退回到它最后处理的那一轮的末尾
    const keptIds = new Set(kept.map(item => item.id))
    const engineSessions: Partial<Record<EngineId, EngineSessionState>> = { ...old }
    engineSessions[record.engine] = {
      id: patch.engineSessionId !== undefined ? patch.engineSessionId : record.engineSessionId,
      seen: !worked
        ? null
        : oldSeen !== null && keptIds.has(oldSeen)
          ? oldSeen
          : derivedSeen(kept, record.engine, record.engine),
    }
    // 其他引擎的原生会话里带着被回退掉的内容（它读到的位置不在保留的对话里）：作废，下次用它新开一个
    for (const key of Object.keys(engineSessions) as EngineId[]) {
      const other = engineSessions[key]
      if (key !== record.engine && other && !(other.seen !== null && keptIds.has(other.seen)))
        engineSessions[key] = { id: null, seen: null }
    }
    // 列表里的「最后一句回复」跟着退回到保留的最后一轮（被回退掉的那条不再显示）
    m.events.patchRecord(id, { ...patch, engineSessions, lastReply: lastTurnReply(kept) ?? null })
    if (!worked && thread && kept.length > 0)
      m.events.apply(id, {
        type: 'item_completed',
        item: {
          kind: 'notice',
          id: randomUUID(),
          level: 'info',
          text: `无法在 ${ENGINES[record.engine].name} 记录中回退到这条消息，已开始新的引擎会话，下一条消息会带上之前对话的交接`,
        },
      })
    if (rt.snapshot.context)
      m.events.apply(id, { type: 'context', context: { ...rt.snapshot.context, stale: true, diagnosticStale: true } })
    if (rt.snapshot.suggestion) m.events.apply(id, { type: 'suggestion', text: null })
  }

  /** 撤销最近一次回退：发了新消息、引擎已经接着跑过、或者重启过就不行 */
  async undoRewind(id: string): Promise<void> {
    const { ctx } = this
    const m = ctx.m
    this.assertIdle(id)
    const entry = this.undo.get(id)
    const snap = m.sessions.runtime(id).snapshot
    if (
      !entry ||
      snap.items.length !== entry.after.count ||
      (snap.items.at(-1)?.id ?? null) !== entry.after.lastId ||
      snap.record.engineSessionId !== entry.after.engineSessionId ||
      (snap.record.pendingRewind ?? null) !== entry.after.pendingRewind ||
      JSON.stringify(snap.record.pendingFork ?? null) !== JSON.stringify(entry.after.pendingFork) ||
      JSON.stringify(snap.record.engineSessions ?? null) !== JSON.stringify(entry.after.engineSessions ?? null) ||
      (snap.record.nextEngine ?? null) !== entry.after.nextEngine
    ) {
      this.forget(id)
      throw new Error('回退之后有了新的对话，不能撤销了')
    }
    ctx.changingSessions.add(id)
    try {
      await this.closeProcess(id)
      // 放回的条目要从回退前的条目文件补回图片数据：先核对每条都补得回来，免得中途失败只放回一部分
      if (entry.removed.some(item => !ctx.store.body(id, item))) {
        this.forget(id)
        throw new Error('回退前的内容读不回来了，不能撤销')
      }
      for (const file of entry.files ?? []) {
        if (file.data === null) rmSync(file.path, { force: true })
        else {
          mkdirSync(dirname(file.path), { recursive: true })
          writeFileSync(file.path, file.data)
        }
      }
      if (entry.removed.length > 0) {
        // 去掉回退时加的提示，再把移除的条目原样放回
        const extra = snap.items[entry.kept]
        // 不带 keepOld：放回的条目要从回退前的条目文件补回图片数据，它得留到放完
        if (extra) {
          ctx.store.replaceItems(id, snap.items.slice(0, entry.kept))
          m.events.apply(id, { type: 'items_truncated', fromItemId: extra.id })
        }
        for (const item of entry.removed) m.events.apply(id, { type: 'item_completed', item })
        m.cache.reset(id)
        m.events.patchRecord(id, { ...entry.before, updatedAt: Date.now() })
      }
      this.forget(id)
    } finally {
      ctx.changingSessions.delete(id)
    }
  }

  /**
   * 从某条用户消息之前分叉出新会话：带上它之前的对话，原会话不变。
   * userItemId 为 null 时带上整个会话（开分支，docs/ui/branch-merge.md §3.2），要求会话空闲；
   * opts 给了工作目录和 branch 时就是「开分支」开出的会话
   */
  async fork(id: string, userItemId: string | null, title?: string, opts: ForkOptions = {}): Promise<ForkResult> {
    const { ctx } = this
    const m = ctx.m
    if (ctx.closing) throw new Error('应用正在退出')
    const rt = m.sessions.runtime(id)
    const source = rt.snapshot.record
    if (!ENGINES[source.engine].caps.fork) throw new Error('当前引擎暂不支持分叉')
    if (userItemId === null) this.assertIdle(id)
    const { index, target } =
      userItemId === null ? { index: rt.snapshot.items.length, target: null } : this.userItem(id, userItemId)
    const all = rt.snapshot.items
    const items = all.slice(0, index)
    const later = all.slice(index).flatMap(item => (item.kind === 'user' ? [item.id] : []))
    const adapter = ctx.adapters[source.engine]
    // 来源是还没启动的分叉会话（Codex）时，从它要 fork 的原线程里算截断点
    const thread = source.engineSessionId ?? source.pendingFork?.from ?? null
    // 来源回退了还没发消息：原生记录要等下次启动才截到 pendingRewind，现在的末端还是刚回退掉的轮次
    const rewound = source.engineSessionId ? (source.pendingRewind ?? null) : null
    // 带上整个会话：截断点就是回退点，不用再到记录里找（找到的末端是没截断的）
    const anchor =
      thread && !(userItemId === null && rewound)
        ? await adapter?.rewindAnchor?.({ ...source, engineSessionId: thread }, later)
        : null
    if (ctx.closing) throw new Error('应用正在退出')
    // 被分叉的消息都没进过线程（unchanged）：不要挪到线程现在的最后一轮——
    // 还没启动的分叉会话沿用它原来的 pendingFork.at，回退了还没发的沿用回退点
    const anchorAt =
      rewound && (userItemId === null || anchor?.unchanged)
        ? rewound
        : anchor?.unchanged && !source.engineSessionId && source.pendingFork
          ? source.pendingFork.at
          : anchor?.at
    const now = Date.now()
    // 分叉出的会话只带当前引擎的原生会话：截断点找到了，它读到的位置不变或退到最后处理的那一轮末尾；
    // 没找到就是新会话什么都没看到，第一条消息带完整交接
    const forked = !!(anchorAt && thread)
    const keptIds = new Set(items.map(item => item.id))
    const oldEntry = source.engineSessions?.[source.engine]
    const oldSeen = oldEntry ? oldEntry.seen : source.engineSessions ? null : lastItemId(rt.snapshot.items)
    const engineSessionId = adapter?.enginePicksSessionId ? null : randomUUID()
    const record: SessionRecord = {
      ...source,
      id: randomUUID(),
      ultrafast: false,
      engineSessionId,
      engineSessions: {
        [source.engine]: {
          id: engineSessionId,
          seen: !forked
            ? null
            : oldSeen !== null && keptIds.has(oldSeen)
              ? oldSeen
              : derivedSeen(items, source.engine, source.engine),
        },
      },
      nextEngine: null,
      title: title ? normalizeSessionTitle(title) : `${source.title}（分支）`,
      titleEdited: true,
      createdAt: now,
      updatedAt: now,
      lastOutcome: null,
      lastError: null,
      // 分叉只带到截断点：预览用截断点之前最后一轮的回复，不沿用来源会话的
      lastReply: lastTurnReply(items) ?? null,
      archivedAt: null,
      bottomedAt: null,
      pinnedAt: null,
      pendingRewind: null,
      pendingFork: anchorAt && thread ? { from: thread, at: anchorAt } : null,
      forkedFrom: { sessionId: source.id, title: source.title },
      // 导入来的标记只属于原对话，不然同一个终端会话被两条记录认领
      imported: null,
      cwd: opts.cwd ?? source.cwd,
      branch: opts.branch ? { ...opts.branch, startAfter: items.at(-1)?.id ?? null, mergedAt: null } : null,
      // 上级等着带的合并摘要不跟过来
      pendingMerge: null,
    }
    const notice: Item[] =
      !anchorAt && thread && items.length > 0
        ? [
            {
              kind: 'notice',
              id: randomUUID(),
              level: 'warn',
              text: `无法在 ${ENGINES[source.engine].name} 记录中找到这条消息，分叉出的会话是新的引擎会话，第一条消息会带上之前对话的交接`,
            },
          ]
        : []
    ctx.records.set(record.id, record)
    ctx.store.saveRecord(record)
    // 带上整个会话、上面等的期间来源的条目没变（还是同一份）：空闲时磁盘上的文件就是这些条目，直接复制，
    // 几百 MB 的对话不用重新序列化；变了（又发了消息）就按取条目时的那份写
    const copied =
      userItemId === null &&
      ctx.runtimes.get(id) === rt &&
      rt.snapshot.items === all &&
      ctx.store.copyItems(id, record.id)
    if (copied) for (const item of notice) ctx.store.appendItem(record.id, item)
    // 截过的条目从来源会话的条目文件补全
    else ctx.store.replaceItems(record.id, [...items, ...notice], { from: id })
    m.events.broadcastSessions()
    if (!target) return { record, text: '' }
    const images = this.full(id, target).attachments
    return {
      record,
      text: target.text,
      ...(images?.length ? { attachments: images } : {}),
      ...(target.files?.length ? { files: target.files } : {}),
    }
  }

  /** 分支会话自己的条目（带过来的部分之后）：写合并摘要用 */
  branchItems(id: string): Item[] {
    const snap = this.ctx.m.sessions.runtime(id).snapshot
    const after = snap.record.branch?.startAfter ?? null
    const index = after ? snap.items.findIndex(item => item.id === after) : -1
    return snap.items.slice(index + 1)
  }

  /**
   * 合并回上级之后（docs/ui/branch-merge.md §5.2）：上级会话里加一张「分支合并」卡片，摘要等着下一条消息带给 AI；
   * 分支会话记下合并时间（和新的代码起点、副本是否删掉）
   */
  recordMerge(id: string, merge: NoticeBranchMerge, branchPatch: Partial<SessionBranch>): void {
    const { ctx } = this
    const m = ctx.m
    const record = m.sessions.stored(id)
    const parentId = record.forkedFrom?.sessionId
    if (!record.branch || !parentId) throw new Error('这个会话不是开分支开出来的')
    const parent = m.sessions.stored(parentId)
    const verb = merge.code === 'committed' || merge.code === 'applied' ? '代码和结论' : '结论'
    const item: Item = {
      kind: 'notice',
      id: randomUUID(),
      level: 'info',
      text: `合并了分支「${record.title}」的${verb}`,
      merge,
    }
    // 上级没载入：卡片只写进磁盘（打开时读到），不为它整份载入上级
    if (ctx.runtimes.has(parentId)) m.events.apply(parentId, { type: 'item_completed', item })
    else ctx.store.appendItem(parentId, item)
    // 上一个合并回来的摘要还没带给 AI：两份接在一起，不覆盖
    const before = parent.pendingMerge ?? null
    m.events.patchRecord(parentId, {
      pendingMerge: !merge.summary
        ? before
        : before
          ? {
              sessionId: id,
              title: `${before.title}」「${record.title}`,
              summary: `${before.summary.trim()}\n\n（分支「${record.title}」）\n${merge.summary}`,
            }
          : { sessionId: id, title: record.title, summary: merge.summary },
    })
    m.events.patchRecord(id, { branch: { ...record.branch, ...branchPatch, mergedAt: Date.now() } })
  }

  /** 这次不带合并摘要 */
  dropPendingMerge(id: string): void {
    const m = this.ctx.m
    if (m.sessions.stored(id).pendingMerge) m.events.patchRecord(id, { pendingMerge: null })
  }

  /** 旁聊：带着主对话的上下文单独问一次（主任务运行中也可以） */
  async sideQuestion(id: string, question: string, history: SideTurn[]): Promise<string> {
    const { ctx } = this
    const record = ctx.m.sessions.stored(id)
    const adapter = ctx.adapters[record.engine]
    if (!ENGINES[record.engine].caps.sideChat || !adapter?.sideQuestion) throw new Error('当前引擎暂不支持旁聊')
    if (!record.engineSessionId) throw new Error('先在主对话里发一条消息')
    const text = question.trim()
    if (!text) throw new Error('请输入问题')
    this.sideQuestions.get(id)?.abort()
    const controller = new AbortController()
    this.sideQuestions.set(id, controller)
    try {
      return await adapter.sideQuestion(record, sidePrompt(text, history), controller.signal)
    } finally {
      if (this.sideQuestions.get(id) === controller) this.sideQuestions.delete(id)
    }
  }

  cancelSideQuestion(id: string): void {
    this.sideQuestions.get(id)?.abort()
    this.sideQuestions.delete(id)
  }

  /** 撤销用完、不能再撤销（新的一轮开始、会话删掉）：放掉撤销记录（可能有 20 MB 的文件内容）和回退前的条目文件 */
  forget(id: string): void {
    this.undo.delete(id)
    this.ctx.store.dropUndo(id)
  }
}

/** 第 index 条之后压缩过上下文（Claude Code 只保留最近一次压缩之后的代码检查点，GitHub #82） */
export function compactedAfter(items: readonly Item[], index: number): boolean {
  return items.slice(index + 1).some(item => item.kind === 'compaction' && item.status === 'completed')
}

function displayPath(cwd: string, file: string): string {
  const rel = relative(cwd, file)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : file
}

/** 旁聊的问题：说明规则，带上前几问，最后是这次的问题 */
export function sidePrompt(question: string, history: SideTurn[]): string {
  const lines = [
    '（旁聊：用户就上面的对话顺便问一个问题。这段问答不会进入主对话。你不能使用任何工具，请直接、简短地回答，用用户提问的语言。）',
  ]
  for (const turn of history.slice(-10)) lines.push('', `问：${turn.question}`, `答：${turn.answer}`)
  lines.push('', `问：${question}`)
  return lines.join('\n')
}
