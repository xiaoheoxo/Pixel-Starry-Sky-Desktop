// 回退（可恢复代码、可撤销）、分叉、旁聊（docs/ui/rewind-fork-sidechat.md §1–§3）
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'
import { normalizeSessionTitle } from '@pixelsky/protocol'
import type {
  EngineId,
  EngineSessionState,
  ForkResult,
  Item,
  RewindCodePreview,
  RewindOptions,
  RewindPreview,
  RewindResult,
  SessionRecord,
  SideTurn,
} from '@pixelsky/protocol'
import { ENGINES } from '../registry'
import type { HostContext } from './context'
import { lastTurnReply } from './events'
import { derivedSeen, lastItemId } from './handoff'

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
    if (!ENGINES[record.engine].caps.rewind) throw new Error('当前引擎暂不支持回退')
    if (!options.conversation && !options.code) throw new Error('请选择要恢复的内容')
    const { index, target } = this.userItem(id, userItemId)
    const before = rewindState(record)
    ctx.changingSessions.add(id)
    try {
      await this.closeProcess(id)
      let files: UndoEntry['files'] = null
      let codeSkipped: string | undefined
      if (options.code)
        try {
          files = await this.restoreCode(record, userItemId)
        } catch (err) {
          // 只恢复代码时照旧报错；同时回退对话时对话照样回退，告诉界面代码没恢复（GitHub #82）
          if (!options.conversation) throw err
          codeSkipped = (await this.beforeCompaction(id, index, userItemId))
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
      return {
        text: options.conversation ? target.text : '',
        ...(options.conversation && target.attachments?.length ? { attachments: target.attachments } : {}),
        ...(options.conversation && target.files?.length ? { files: target.files } : {}),
        ...(files ? { filesRestored: files.length } : {}),
        ...(codeSkipped ? { codeSkipped } : {}),
        undoable: !options.code || files !== null || codeSkipped !== undefined,
      }
    } finally {
      ctx.changingSessions.delete(id)
    }
  }

  /** 还原文件；先存一份当前内容（太大时不存，返回空数组表示还原了但不能撤销代码） */
  private async restoreCode(record: SessionRecord, userItemId: string): Promise<UndoEntry['files']> {
    const adapter = this.ctx.adapters[record.engine]
    if (!ENGINES[record.engine].caps.rewindCode || !adapter?.rewindFiles || !record.engineSessionId)
      throw new Error('这条消息没有代码检查点，代码保持不变')
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
    if (!done.ok)
      throw new Error(
        done.reason === 'no-checkpoint' ? '这条消息没有代码检查点，代码保持不变' : done.message || '没能还原代码',
      )
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
    ctx.store.replaceItems(id, kept)
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
      this.undo.delete(id)
      throw new Error('回退之后有了新的对话，不能撤销了')
    }
    ctx.changingSessions.add(id)
    try {
      await this.closeProcess(id)
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
        if (extra) {
          ctx.store.replaceItems(id, snap.items.slice(0, entry.kept))
          m.events.apply(id, { type: 'items_truncated', fromItemId: extra.id })
        }
        for (const item of entry.removed) m.events.apply(id, { type: 'item_completed', item })
        m.cache.reset(id)
        m.events.patchRecord(id, { ...entry.before, updatedAt: Date.now() })
      }
      this.undo.delete(id)
    } finally {
      ctx.changingSessions.delete(id)
    }
  }

  /** 从某条用户消息之前分叉出新会话：带上它之前的对话，原会话不变 */
  async fork(id: string, userItemId: string, title?: string): Promise<ForkResult> {
    const { ctx } = this
    const m = ctx.m
    if (ctx.closing) throw new Error('应用正在退出')
    const rt = m.sessions.runtime(id)
    const source = rt.snapshot.record
    if (!ENGINES[source.engine].caps.fork) throw new Error('当前引擎暂不支持分叉')
    const { index, target } = this.userItem(id, userItemId)
    const items = rt.snapshot.items.slice(0, index)
    const later = rt.snapshot.items.slice(index).flatMap(item => (item.kind === 'user' ? [item.id] : []))
    const adapter = ctx.adapters[source.engine]
    // 来源是还没启动的分叉会话（Codex）时，从它要 fork 的原线程里算截断点
    const thread = source.engineSessionId ?? source.pendingFork?.from ?? null
    const anchor = thread ? await adapter?.rewindAnchor?.({ ...source, engineSessionId: thread }, later) : null
    if (ctx.closing) throw new Error('应用正在退出')
    // 还没启动的分叉会话里，被分叉的消息都没进过线程（unchanged）：沿用它原来的 pendingFork.at，不要挪到线程现在的最后一轮
    const anchorAt =
      anchor?.unchanged && !source.engineSessionId && source.pendingFork ? source.pendingFork.at : anchor?.at
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
    ctx.store.replaceItems(record.id, [...items, ...notice])
    m.events.broadcastSessions()
    return {
      record,
      text: target.text,
      ...(target.attachments?.length ? { attachments: target.attachments } : {}),
      ...(target.files?.length ? { files: target.files } : {}),
    }
  }

  /** 旁聊：带着主对话的上下文单独问一次（主任务运行中也可以） */
  async sideQuestion(id: string, question: string, history: SideTurn[]): Promise<string> {
    const { ctx } = this
    const record = ctx.m.sessions.runtime(id).snapshot.record
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

  /** 会话删掉了：放掉它的撤销记录（可能有 20 MB 的文件内容） */
  forget(id: string): void {
    this.undo.delete(id)
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
