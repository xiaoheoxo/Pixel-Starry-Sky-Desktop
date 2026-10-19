// 接着引擎自己留下的会话（终端里的 Claude Code……）：列出、导入、加载更早的、补上终端里新聊的（docs/ui/claude-resume.md）
import { randomUUID } from 'node:crypto'
import {
  normalizeSessionTitle,
  type EngineId,
  type EngineSessionState,
  type ImportedSession,
  type Item,
  type NativeAction,
  type NativeActionResult,
  type NativeImportResult,
  type NativeSessionDetail,
  type NativeSessionSummary,
  type SessionRecord,
  type SessionSettings,
} from '@pixelsky/protocol'
import type { EngineAdapter } from '../adapter'
import type { NativeSessionList, NativeRead, NewerTurns } from '../native/types'
import { NATIVE_TEXT } from '../native/text'
import { matchCwd } from '../native/paths'
import { ENGINES } from '../registry'
import { UUID } from '../claude/transcript'
import { hasHandoffContent } from '../handoff'
import type { HostContext } from './context'
import { lastItemId } from './handoff'

/** 默认显示最近这么多轮；加载更早的、补上每次也是这么多 */
const TURNS = 50
/** 文件超过这么大才发导入进度 */
const PROGRESS_BYTES = 50 * 1024 * 1024
const ACTIONS: readonly NativeAction[] = ['earlier', 'sync', 'copy', 'check']

type NoticeItem = Extract<Item, { kind: 'notice' }>

export class HostNative {
  /** 每个项目 + 引擎最近一次的列表：第二步（尾部）共用这次的读取预算，导入时也从这里查会话开在哪个子文件夹 */
  private readonly lists = new Map<string, NativeSessionList>()
  /** 正在导入的任务，cancelNativeImport 按 token 找到它 */
  private readonly imports = new Map<string, AbortController>()

  constructor(private readonly ctx: HostContext) {}

  private adapter(
    engine: EngineId,
  ): EngineAdapter & Required<Pick<EngineAdapter, 'nativeSessions' | 'readNativeSession'>> {
    const adapter = this.ctx.adapters[engine]
    if (!adapter?.nativeSessions || !adapter.readNativeSession) throw new Error(NATIVE_TEXT.unsupported)
    return adapter as ReturnType<HostNative['adapter']>
  }

  private project(projectId: string): { id: string; path: string } {
    const project = this.ctx.m.projects.find(projectId)
    if (!project) throw new Error('项目不存在')
    return project
  }

  /**
   * 谁占着这些原生会话：把每条记录里所有可能指向原生会话的 id 收起来（任何引擎），一个 id 对应多条记录时
   * 按「当前在用 > engineSessions > 导入 > 分叉待启动」选，同级取 updatedAt 最新的，再按记录 id，结果是确定的
   */
  private owners(): Map<string, string> {
    const best = new Map<string, { rank: number; at: number; owner: string }>()
    for (const rec of this.ctx.records.values()) {
      const claims: [string | null | undefined, number][] = [
        // Claude 在 engineSessionId 为 null 时用对话自己的 id
        [rec.engineSessionId, 0],
        [rec.id, rec.engineSessionId == null && rec.engine === 'claude' ? 0 : 1],
        [rec.imported?.sessionId, 2],
        [rec.pendingFork?.from, 3],
      ]
      for (const entry of Object.values(rec.engineSessions ?? {}) as EngineSessionState[]) {
        claims.push([entry.id, 1], [entry.pendingFork?.from, 3])
      }
      for (const [id, rank] of claims) {
        if (!id) continue
        const old = best.get(id)
        if (
          !old ||
          rank < old.rank ||
          (rank === old.rank && (rec.updatedAt > old.at || (rec.updatedAt === old.at && rec.id < old.owner)))
        )
          best.set(id, { rank, at: rec.updatedAt, owner: rec.id })
      }
    }
    return new Map([...best].map(([id, b]) => [id, b.owner]))
  }

  /** 列出这个项目里引擎自己留下的会话（第一步：只读头部，马上返回）；subfolders：项目子文件夹里开的也列出来（默认 true，传 false 才只列项目主目录） */
  async nativeSessions(
    projectId: string,
    engine: EngineId,
    opts: { subfolders?: boolean } = {},
  ): Promise<NativeSessionSummary[]> {
    const project = this.project(projectId)
    const adapter = this.adapter(engine)
    const list = await adapter.nativeSessions(project.path, { subfolders: opts.subfolders !== false })
    this.lists.set(`${projectId}\n${engine}`, list)
    const live = adapter.nativeLive?.(list.sessions)
    const owners = this.owners()
    return list.sessions.map(s => ({
      id: s.id,
      title: s.title,
      firstPrompt: s.firstPrompt,
      lastPrompt: s.lastPrompt,
      branch: s.branch,
      subdir: s.subdir,
      updatedAt: s.updatedAt,
      size: s.size,
      model: s.model,
      source: s.source,
      ownerId: owners.get(s.id) ?? null,
      live: live?.get(s.id) ?? null,
    }))
  }

  /** 第二步：读这几个会话的尾部，补最后一句、标题、模型、最后活动时间；预算是这次列表共用的 */
  async nativeSessionDetails(projectId: string, engine: EngineId, ids: unknown): Promise<NativeSessionDetail[]> {
    this.project(projectId)
    this.adapter(engine)
    const list = this.lists.get(`${projectId}\n${engine}`)
    if (!list || !Array.isArray(ids)) return []
    const wanted = ids.filter((id): id is string => typeof id === 'string' && UUID.test(id)).slice(0, 200)
    const out: NativeSessionDetail[] = []
    for await (const d of list.details(wanted))
      out.push({
        id: d.id,
        lastPrompt: d.lastPrompt,
        title: d.title,
        lastActive: d.lastActive,
        model: d.model,
        branch: d.branch,
        superseded: d.superseded,
        skipped: d.skipped,
      })
    return out
  }

  cancelNativeImport(token: string): void {
    this.imports.get(token)?.abort()
    this.imports.delete(token)
  }

  /** 最上面的分隔条：来自哪个引擎、哪里、几轮、还有几轮没显示（有就带「加载更早的」按钮） */
  private divider(
    engine: EngineId,
    source: 'terminal' | 'other',
    copy: boolean,
    turns: number,
    missing: number,
    detail: string | null,
    id: string = randomUUID(),
    legacy = false,
  ): NoticeItem {
    return {
      kind: 'notice',
      id,
      level: 'info',
      text: NATIVE_TEXT.divider(source, copy, turns, missing, ENGINES[engine].name, legacy),
      detail,
      ...(missing > 0 ? { action: { kind: 'native-earlier' as const, count: missing } } : {}),
    }
  }

  /**
   * 导入成一个新对话。mode 'inplace'：原地接着（--resume X，往同一个文件写）；'copy'：复制一份接着聊（分叉，原会话一个字节不动）。
   * 已被占用返回 ownerId，原地导入时正开着返回 live，记录不在了抛错；token 用来取消和对应进度事件
   */
  async importNative(
    projectId: string,
    engine: EngineId,
    nativeId: string,
    opts: { mode?: 'inplace' | 'copy'; settings?: Partial<SessionSettings>; token?: string } = {},
  ): Promise<NativeImportResult> {
    const { ctx } = this
    const m = ctx.m
    const project = this.project(projectId)
    const adapter = this.adapter(engine)
    if (typeof nativeId !== 'string' || !UUID.test(nativeId)) throw new Error('会话 id 不对')
    let copy = opts.mode === 'copy'
    const owner = this.owners().get(nativeId)
    if (owner) return { ownerId: owner }
    const summary = this.lists.get(`${projectId}\n${engine}`)?.sessions.find(s => s.id === nativeId)
    const cwd = summary?.cwd ?? project.path
    const live = adapter.nativeLive?.([{ id: nativeId, mtimeMs: 0 }]).get(nativeId) ?? null
    if (!copy && (live === 'terminal' || live === 'other')) return { live }

    const abort = new AbortController()
    const token = opts.token
    if (token) this.imports.set(token, abort)
    let read: NativeRead | null
    try {
      read = await adapter.readNativeSession(cwd, nativeId, {
        turns: TURNS,
        signal: abort.signal,
        // 正开着：末尾还没结束的一轮不导入
        live: live !== null,
        onProgress: (done, total) => {
          if (token && total >= PROGRESS_BYTES) ctx.opts.emit({ kind: 'native_import', token, read: done, total })
        },
      })
    } catch (err) {
      if (abort.signal.aborted) throw new Error(NATIVE_TEXT.cancelled)
      throw err
    } finally {
      if (token && this.imports.get(token) === abort) this.imports.delete(token)
    }
    if (abort.signal.aborted) throw new Error(NATIVE_TEXT.cancelled)
    if (!read) throw new Error(NATIVE_TEXT.gone)
    // 旧格式的线程（Codex）不能原地回退：一律复制成新线程接着聊
    const legacy = !!read.copyOnly
    copy ||= legacy
    if (copy && !read.at) throw new Error(NATIVE_TEXT.nothingToCopy)
    // 读文件期间可能被别的对话占用了
    const owner2 = this.owners().get(nativeId)
    if (owner2) return { ownerId: owner2 }

    // 对话的工作目录跟着会话原来的目录（Codex 读线程时给；核对过在项目下面才用，没有列表缓存的 /resume <id> 也靠它拿到子文件夹）
    const where = read.cwd ? await matchCwd(project.path, read.cwd, true) : null
    // 和项目根目录是同一个目录（Windows 上只差大小写 / 末尾分隔符）就用项目路径，不然会被当成「同名的子文件夹」
    const home = where ? (where.subdir === null ? project.path : read.cwd!) : cwd
    const missing = Math.max(0, read.turns - read.shown)
    const items: Item[] = [
      this.divider(engine, read.source, copy, read.turns, missing, read.summary, undefined, legacy),
      // 像素星空以前用过的线程：中转写进去的聊天读不出来，说一声
      ...(read.pixelsky
        ? [{ kind: 'notice', id: randomUUID(), level: 'info', text: NATIVE_TEXT.pixelskyThread, detail: null } as const]
        : []),
      ...read.items,
    ]
    const seen = lastItemId(items)
    const record = m.sessions.createSession(
      { ...(opts.settings ?? {}), projectId, engine },
      home === project.path ? undefined : home,
    )
    ctx.store.replaceItems(record.id, items)
    const imported: ImportedSession = {
      engine,
      sessionId: nativeId,
      at: Date.now(),
      turns: read.turns,
      shown: read.shown,
      ...(copy ? { forked: true } : {}),
      source: read.source,
    }
    // seen 和每轮结束时写的是同一个意思：这个引擎上下文里最后一条对话条目
    m.events.patchRecord(record.id, {
      title: normalizeSessionTitle(read.title),
      imported,
      ...(copy
        ? {
            engineSessionId: null,
            pendingFork: { from: nativeId, at: read.at! },
            engineSessions: { [engine]: { id: null, seen } },
          }
        : { engineSessionId: nativeId, engineSessions: { [engine]: { id: nativeId, seen } } }),
    })
    m.events.broadcastSessions()
    return { sessionId: record.id, model: read.model, turns: read.turns, shown: read.shown }
  }

  /**
   * 对导入的对话做一件事：earlier 加载更早的、sync 补上终端里新聊的、check 只看有没有新聊的（有就在末尾加提示）、
   * copy 把原地导入的对话改成复制的（启动时发现终端里正开着）
   */
  async nativeAction(id: string, kind: unknown): Promise<NativeActionResult> {
    const { ctx } = this
    if (typeof kind !== 'string' || !ACTIONS.includes(kind as NativeAction)) throw new Error('操作不对')
    const action = kind as NativeAction
    const rt = ctx.m.sessions.runtime(id)
    const imp = rt.snapshot.record.imported
    if (!imp) throw new Error('这个对话不是接着本机会话来的')
    const adapter = this.adapter(imp.engine)
    const idle = rt.snapshot.state === 'idle' && !rt.pumping && !rt.stopping
    if (ctx.changingSessions.has(id) || !idle) {
      if (action === 'check') return { added: 0 }
      throw new Error(ctx.changingSessions.has(id) ? '正在处理这个会话，请稍后重试' : '任务运行中，结束后再试')
    }
    if (action !== 'earlier' && imp.forked) return { added: 0 }
    // 按导入的那个引擎看：换了引擎的话，当前引擎的会话 id 和待执行的回退都不是原会话的，原引擎的存在 engineSessions 里
    const mine = this.followed(rt.snapshot.record, imp)
    // 回退了还没发消息：原生记录要等下次启动才截到 pendingRewind，截断点之后读到的都是刚回退掉的轮次，不是终端里新聊的
    // 对话已经不接着原会话了（回退找不到截断点、旧格式回退失败、回退到第一条：换了新的引擎会话），原会话里截断点之后的轮次也不是新聊的
    if ((action === 'check' || action === 'sync') && (mine.pendingRewind || mine.sessionId !== imp.sessionId))
      return { added: 0 }
    // 复制一份只对「现在还接着原会话」的对话有意义：执行者是导入的那个引擎，且它记的线程 id 还是原会话的。
    // 否则（换了引擎、回退换了新线程）会从原会话分叉出一份和对话内容对不上的上下文
    if (action === 'copy' && (!mine.executor || mine.sessionId !== imp.sessionId))
      throw new Error(NATIVE_TEXT.notFollowing)
    ctx.changingSessions.add(id)
    try {
      if (action === 'earlier') return await this.earlier(id, imp, adapter)
      if (action === 'copy') return await this.toCopy(id, imp, adapter)
      return await this.newer(id, imp, adapter, action === 'sync')
    } finally {
      ctx.changingSessions.delete(id)
    }
  }

  /**
   * 导入的那个引擎现在的状态：执行者是它时看记录本身的 engineSessionId / pendingRewind，
   * 换了引擎时它们属于别的引擎，这个引擎的存在 engineSessions 里
   */
  private followed(
    record: SessionRecord,
    imp: ImportedSession,
  ): { executor: boolean; sessionId: string | null | undefined; pendingRewind: string | null | undefined } {
    if (record.engine === imp.engine)
      return { executor: true, sessionId: record.engineSessionId, pendingRewind: record.pendingRewind }
    const entry = record.engineSessions?.[imp.engine]
    return { executor: false, sessionId: entry?.id, pendingRewind: entry?.pendingRewind }
  }

  /** 加载更早的：从最早一条用户条目往前再取 50 轮，插在分隔条和原来的第一条之间 */
  private async earlier(id: string, imp: ImportedSession, adapter: ReturnType<HostNative['adapter']>) {
    const { ctx } = this
    const rt = ctx.m.sessions.runtime(id)
    const items = rt.snapshot.items
    const first = items.find(item => item.kind === 'user')
    if (!first) throw new Error(NATIVE_TEXT.earlierGone)
    const older = await adapter.readNativeSession(rt.snapshot.record.cwd, imp.sessionId, {
      turns: TURNS,
      before: first.id,
    })
    if (!older) throw new Error(NATIVE_TEXT.earlierGone)
    const head = items[0]?.kind === 'notice' ? items[0] : null
    const rest = head ? items.slice(1) : items
    const shown = imp.shown + older.shown
    const missing = older.hasEarlier ? Math.max(1, imp.turns - shown) : 0
    // 越过压缩边界：压缩条目上面说一句，这些轮次模型只看到压缩摘要
    const loaded = older.items.flatMap<Item>(item =>
      item.kind === 'compaction'
        ? [{ kind: 'notice', id: randomUUID(), level: 'info', text: NATIVE_TEXT.summaryOnly, detail: null }, item]
        : [item],
    )
    const next = [
      this.divider(
        imp.engine,
        older.source,
        !!imp.forked,
        imp.turns,
        missing,
        head?.detail ?? null,
        head?.id,
        imp.forked && !!older.copyOnly,
      ),
      ...loaded,
      ...rest,
    ]
    this.replace(id, next)
    ctx.m.events.patchRecord(id, { imported: { ...imp, shown } })
    return { added: older.shown }
  }

  /** 整个条目列表换掉：先落盘再广播 */
  private replace(id: string, items: Item[]): void {
    this.ctx.store.replaceItems(id, items)
    this.ctx.m.events.apply(id, { type: 'items_reset', items })
  }

  /**
   * 对话里认识的、记录里终端之后新加的轮次：从最近几条用户条目（id 是记录里的 uuid）往前找，
   * 第一个在当前分支上的就是像素星空认识的最后位置
   */
  private async findNewer(id: string, imp: ImportedSession, adapter: ReturnType<HostNative['adapter']>) {
    const rt = this.ctx.m.sessions.runtime(id)
    if (!adapter.newerNativeTurns) throw new Error(NATIVE_TEXT.unsupported)
    const users = rt.snapshot.items
      .filter(item => item.kind === 'user' && UUID.test(item.id))
      .slice(-8)
      .reverse()
    for (const user of users) {
      const found: NewerTurns | null = await adapter.newerNativeTurns(rt.snapshot.record.cwd, imp.sessionId, user.id, {
        turns: TURNS,
        afterTurn: true,
      })
      if (found) return found
    }
    return null
  }

  private async newer(
    id: string,
    imp: ImportedSession,
    adapter: ReturnType<HostNative['adapter']>,
    apply: boolean,
  ): Promise<NativeActionResult> {
    const { ctx } = this
    const m = ctx.m
    const rt = m.sessions.runtime(id)
    const found = await this.findNewer(id, imp, adapter)
    const old = rt.snapshot.items
    const stale = old.findIndex(item => item.kind === 'notice' && item.action?.kind === 'native-sync')
    if (!found || found.turns === 0) return { added: 0 }
    const without = stale >= 0 ? old.filter((_, i) => i !== stale) : old
    if (!apply) {
      const notice: NoticeItem = {
        kind: 'notice',
        id: randomUUID(),
        level: 'info',
        text: NATIVE_TEXT.newer(found.turns),
        detail: null,
        action: { kind: 'native-sync', count: found.turns },
      }
      if (stale >= 0) this.replace(id, [...without, notice])
      else m.events.apply(id, { type: 'item_completed', item: notice })
      return { added: found.turns }
    }
    const done: NoticeItem = {
      kind: 'notice',
      id: randomUUID(),
      level: 'info',
      text: NATIVE_TEXT.synced(found.shown),
      detail: null,
    }
    const next = [...without, done, ...found.items]
    // 这些轮次本来就在 Claude 的上下文里：它读到的位置跟着挪到最后。前提是它原来已经看完了现有的全部对话
    const record = rt.snapshot.record
    const entry = record.engineSessions?.[imp.engine]
    const at = entry?.seen ? old.findIndex(item => item.id === entry.seen) : -1
    const caughtUp = at >= 0 && !hasHandoffContent(old.slice(at + 1))
    this.replace(id, next)
    m.events.patchRecord(id, {
      imported: { ...imp, turns: imp.turns + found.turns, shown: imp.shown + found.shown },
      ...(entry && caughtUp
        ? { engineSessions: { ...record.engineSessions, [imp.engine]: { ...entry, seen: lastItemId(next) } } }
        : {}),
    })
    return { added: found.shown }
  }

  /** 原地导入的对话改成「复制一份接着聊」：启动时发现终端里正开着。从像素星空认识的最后位置分叉，然后界面重发那条消息 */
  private async toCopy(
    id: string,
    imp: ImportedSession,
    adapter: ReturnType<HostNative['adapter']>,
  ): Promise<NativeActionResult> {
    const { ctx } = this
    const m = ctx.m
    const rt = m.sessions.runtime(id)
    const record = rt.snapshot.record
    let at = record.pendingRewind ?? null
    if (!at) {
      const found = await this.findNewer(id, imp, adapter)
      at = found?.base ?? (await adapter.readNativeSession(record.cwd, imp.sessionId, { turns: 1 }))?.at ?? null
    }
    if (!at) throw new Error(NATIVE_TEXT.gone)
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer)
      rt.idleTimer = null
    }
    // 启动失败留下的会话对象不再用：下一条消息按新的记录重新启动
    const old = rt.session
    rt.session = null
    await old?.close()
    const entry = record.engineSessions?.[imp.engine]
    m.events.patchRecord(id, {
      engineSessionId: null,
      pendingRewind: null,
      pendingFork: { from: imp.sessionId, at },
      // 启动失败的那条消息会重发，不用再作为交接带一次
      engineSessions: {
        ...record.engineSessions,
        [imp.engine]: { ...entry, id: null, seen: lastItemId(rt.snapshot.items) },
      },
      imported: { ...imp, forked: true },
    })
    return { added: 0 }
  }
}
