// 会话：创建、打开（懒创建运行时）、改设置、改名、置底、回退、归档、删除
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CHAT_PROJECT_ID,
  cutItem,
  EFFORT_PANEL_KEYS,
  emptySnapshot,
  normalizeSessionTitle,
  PROVIDER_ID,
  sourceKey,
  type EngineId,
  type Item,
  type OpenedSession,
  type SessionRecord,
  type SessionSettings,
  type SessionSnapshot,
  type SessionSummary,
  ULTRAFAST_DROPPED,
  ultrafastEligible,
  viaGateway,
} from '@pixelsky/protocol'
import { queueSettings } from '../queue'
import { ENGINES } from '../registry'
import type { HostContext, Runtime } from './context'
import { NEW_TITLE } from './title'

export class HostSessions {
  constructor(private readonly ctx: HostContext) {}

  /** prepare 进行中的分块读 */
  private readonly preparing = new Map<string, Promise<void>>()

  sessions(): SessionSummary[] {
    const { ctx } = this
    return [...ctx.records.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(record => {
        const queue = ctx.m.queue.queueSummary(record.id)
        const snapshot = ctx.runtimes.get(record.id)?.snapshot
        const background = snapshot?.background ?? 0
        const pending = snapshot?.pending[0]
        return {
          record,
          state: snapshot?.state ?? 'idle',
          ...(background ? { background } : {}),
          ...(queue ? { queue } : {}),
          ...(pending ? { pending, pendingIds: snapshot.pending.map(p => p.requestId) } : {}),
        }
      })
  }

  createSession(
    /** rememberChoices: false：按别处存的配置开的会话（频道成员），不把这几项记成默认值 */
    opts: { projectId: string } & Partial<SessionSettings> & {
        engine?: EngineId
        rememberChoices?: false
        scheduleTaskId?: string
      },
    workspacePath?: string,
  ): SessionRecord {
    const { ctx } = this
    const m = ctx.m
    const project = m.projects.find(opts.projectId)
    if (!project) throw new Error('项目不存在')
    const id = randomUUID()
    // 不用项目的对话：在数据目录下给它开一个自己的空文件夹
    if (project.id === CHAT_PROJECT_ID) workspacePath = join(project.path, id)
    if (m.guard.isLocked(workspacePath ?? project.path)) throw new Error('工作目录正在维护，请稍后重试')
    const engine = opts.engine ?? m.settings.file.defaults.engine
    if (opts.platform && opts.provider) throw new Error('额度来源无效')
    if (opts.provider && (typeof opts.provider.id !== 'string' || !PROVIDER_ID.test(opts.provider.id)))
      throw new Error('无效的自定义接口')
    const d = m.settings.engineDefaults(engine)
    if (project.id === CHAT_PROJECT_ID) mkdirSync(workspacePath!, { recursive: true })
    const now = Date.now()
    const record: SessionRecord = {
      id,
      projectId: project.id,
      cwd: workspacePath ?? project.path,
      ...(project.folders?.length ? { extraDirs: project.folders.map(f => f.path) } : {}),
      engine,
      engineSessionId: null,
      title: NEW_TITLE,
      model: opts.model !== undefined ? opts.model : d.model,
      platform: opts.platform ?? null,
      provider: opts.provider ? { id: opts.provider.id } : null,
      effort: opts.effort !== undefined ? opts.effort : d.effort,
      permissionMode: opts.permissionMode ?? d.permissionMode,
      ultracode: opts.ultracode ?? d.ultracode,
      fast: opts.fast ?? d.fast,
      ...(opts.ultrafast ? { ultrafast: true } : {}),
      thinkingSummaries: opts.thinkingSummaries ?? d.thinkingSummaries,
      createdAt: now,
      updatedAt: now,
      lastOutcome: null,
      archivedAt: null,
      bottomedAt: null,
      pinnedAt: null,
      titleEdited: false,
      ...(typeof opts.scheduleTaskId === 'string' ? { scheduleTaskId: opts.scheduleTaskId } : {}),
    }
    ctx.records.set(record.id, record)
    ctx.store.saveRecord(record)
    // 打开了「记住会话里的选择」：新会话界面上（发第一条消息前）改的推理强度那几项也记成默认值（GitHub #6）
    if (opts.rememberChoices !== false && m.settings.remembersChoices(engine)) {
      const picked: Partial<SessionSettings> = {}
      for (const k of EFFORT_PANEL_KEYS) Object.assign(picked, { [k]: record[k] })
      m.settings.setDefaults({ ...picked, engine })
    }
    m.events.broadcastSessions()
    return record
  }

  /** 会话的运行时；第一次访问时从磁盘读条目和队列，并排期续跑未完成的结算 */
  runtime(id: string): Runtime {
    const { ctx } = this
    const rt = ctx.runtimes.get(id)
    if (rt) return rt
    const record = ctx.records.get(id)
    if (!record) throw new Error('会话不存在')
    return this.build(record, ctx.store.loadItems(id))
  }

  /**
   * 打开前先分块读条目、不卡主进程（docs/session-memory.md 第 4 期），读完建运行时；已载入的直接返回，同一会话同时只读一次。
   * 读的期间别的同步调用建了运行时就丢掉读到的；文件大小和读到的对不上（期间被追加、换掉）就同步重读
   */
  prepare(id: string): Promise<void> {
    const { ctx } = this
    if (ctx.runtimes.has(id)) return Promise.resolve()
    if (!ctx.records.has(id)) return Promise.reject(new Error('会话不存在'))
    let reading = this.preparing.get(id)
    if (!reading) {
      reading = ctx.store
        .loadItemsAsync(id)
        .then(({ items, bytes }) => {
          // 期间删掉了：交给之后的 openSession 报「会话不存在」
          const record = ctx.records.get(id)
          if (ctx.runtimes.has(id) || !record) return
          if (ctx.store.itemsSize(id) !== bytes) this.runtime(id)
          else this.build(record, items)
        })
        .finally(() => this.preparing.delete(id))
      this.preparing.set(id, reading)
    }
    return reading
  }

  /** 用读出的条目建运行时（runtime 同步读、prepare 分块读共用）：补出来的条目、平台计费、队列、追踪数据、续跑结算 */
  private build(record: SessionRecord, items: Item[]): Runtime {
    const { ctx } = this
    const id = record.id
    const snapshot = emptySnapshot(record, items)
    const adapter = ctx.adapters[record.engine]
    // 补出来的条目（Codex 旧版只存路径的看图条目）落盘完整的，内存里留截过的
    if (adapter?.restoreItem)
      snapshot.items = snapshot.items.map(item => {
        const restored = adapter.restoreItem!(record, item)
        if (restored === item) return item
        ctx.store.appendItem(id, restored)
        return cutItem(restored)
      })
    if (record.platform)
      snapshot.items = snapshot.items.map(item =>
        item.kind === 'turn_stats' && !item.usage.settlement
          ? {
              ...item,
              usage: {
                ...item.usage,
                models: Object.fromEntries(
                  Object.entries(item.usage.models).map(([name, m]) => [
                    name,
                    m.costSource ? m : { ...m, costUsd: null, costSource: 'unavailable' as const },
                  ]),
                ),
              },
            }
          : item,
      )
    const saved = ctx.store.loadQueue(record)
    snapshot.queue = saved.items
    snapshot.queuePaused = saved.paused
    try {
      const runs = ctx.adapters[record.engine]?.loadRuns?.(record)
      if (runs) snapshot.runs = runs
    } catch {
      // 读不到以前的追踪数据不影响打开会话
    }
    const rt: Runtime = {
      snapshot,
      seq: 0,
      session: null,
      idleTimer: null,
      receipts: saved.receipts,
      pumping: false,
      stopping: false,
      generation: 0,
      activeId: null,
      execution: null,
      sessionSource: undefined,
      pumpFinished: null,
      sessionMaxRetries: undefined,
    }
    ctx.runtimes.set(id, rt)
    // The original account and request IDs are persisted, never inferred from the current route.
    queueMicrotask(() => {
      ctx.m.usage.resumeSettlements(id, snapshot.items)
    })
    return rt
  }

  open(id: string): SessionSnapshot {
    return this.runtime(id).snapshot
  }

  /**
   * 按 id 取一条完整条目（截掉的图片数据、长输出从磁盘补回）：已载入的从快照里找，补不回来给截过的那条；
   * 没载入的从磁盘读，不建运行时。没有这一条为 null
   */
  item(id: string, itemId: string): Item | null {
    const { ctx } = this
    const items = ctx.runtimes.get(id)?.snapshot.items
    if (!items) {
      if (!ctx.records.has(id)) throw new Error('会话不存在')
      return ctx.store.readItem(id, itemId)
    }
    const item = items.findLast(i => i.id === itemId)
    return item ? (ctx.store.body(id, item) ?? item) : null
  }

  openSession(id: string): OpenedSession {
    const rt = this.runtime(id)
    // 重启后还标着终端模式：当作已切回（docs/ui/tui-toggle.md §3.4）；补轮次异步做，先清标记让界面显示
    if (rt.snapshot.record.tui && !rt.tuiLive) {
      this.ctx.m.events.patchRecord(id, { tui: null })
      void this.ctx.m.native.syncFromTui(id).catch(() => {})
    }
    this.ctx.m.usage.resumeSettlements(id, rt.snapshot.items)
    return { snapshot: this.runtime(id).snapshot, seq: this.runtime(id).seq }
  }

  /** 会话记录（载入时和 snapshot.record 是同一份，apply 'record' 两边一起写）；不存在时报错，不创建运行时 */
  stored(id: string): SessionRecord {
    const record = this.ctx.records.get(id)
    if (!record) throw new Error('会话不存在')
    return record
  }

  /** 正在执行的设置（含运行中改过的）；没有运行时用会话记录。不创建运行时 */
  record(id: string): SessionRecord | null {
    return this.ctx.runtimes.get(id)?.execution ?? this.ctx.records.get(id) ?? null
  }

  async update(
    id: string,
    patch: Partial<SessionSettings> & { title?: string; engine?: EngineId },
  ): Promise<SessionRecord> {
    const { ctx } = this
    const m = ctx.m
    const rt = this.runtime(id)
    if (rt.inspectingContext) throw new Error('上下文诊断正在刷新，完成后再修改会话设置')
    let current = rt.snapshot.record
    const next: Partial<SessionRecord> = {}
    let restart = false
    const running = rt.snapshot.state !== 'idle' || rt.pumping
    // 换引擎（跨引擎接力）：没开始过的会话直接改；开始过且空闲的现在就换；忙的记下来，从下一条派发的消息起生效
    if (patch.engine !== undefined) {
      if (patch.engine === current.engine) {
        if (current.nextEngine) next.nextEngine = null
      } else if (
        rt.snapshot.items.length === 0 &&
        !rt.session &&
        !rt.pumping &&
        rt.snapshot.queue.length === 0 &&
        !current.nextEngine
      )
        next.engine = patch.engine
      else if (!running && !rt.stopping && !rt.activeId && rt.snapshot.queue.length === 0) {
        if (ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
        ctx.changingSessions.add(id)
        try {
          await m.handoff.switchEngine(id, patch.engine)
        } finally {
          ctx.changingSessions.delete(id)
        }
        current = rt.snapshot.record
      } else next.nextEngine = patch.engine
    }
    // 平台和自定义 API 互斥：设了一边就清掉另一边（docs/ui/custom-api.md §4.2）
    let platform = patch.platform !== undefined ? patch.platform : (current.platform ?? null)
    let provider = patch.provider !== undefined ? patch.provider : (current.provider ?? null)
    if (patch.provider && patch.platform === undefined) platform = null
    if (patch.platform && patch.provider === undefined) provider = null
    if (platform && provider) throw new Error('额度来源无效')
    if (provider && (typeof provider.id !== 'string' || !PROVIDER_ID.test(provider.id)))
      throw new Error('无效的自定义接口')
    const changed =
      JSON.stringify(platform) !== JSON.stringify(current.platform ?? null) ||
      (provider?.id ?? null) !== (current.provider?.id ?? null)
    if (changed) {
      // 同一账号换分组、同一来源不变时不用换进程；换了账号或来源种类要换进程。
      // 运行中换来源：记录先改，当前这一轮仍用原来源（执行设置、网关路由、模型都不动），
      // 下一条消息派发时 pump 比对 sourceKey 换进程接上原对话；空闲时现在就关进程
      const sameSource = sourceKey({ platform, provider }) === sourceKey(current)
      if (!sameSource && !running && rt.session) restart = true
      next.platform = platform
      next.provider = provider ? { id: provider.id } : null
    }
    if (patch.title !== undefined) {
      next.title = normalizeSessionTitle(patch.title)
      next.titleEdited = true
    }
    if (patch.model !== undefined) next.model = patch.model
    // 自己改了来源、线路或模型：不再自动换回订阅（docs/ui/engine-accounts.md §5.2）
    if ((changed || (patch.model !== undefined && patch.model !== current.model)) && current.platformFallback)
      next.platformFallback = null
    if (patch.effort !== undefined) next.effort = patch.effort
    if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode
    if (patch.ultracode !== undefined) next.ultracode = patch.ultracode
    if (patch.fast !== undefined) next.fast = patch.fast
    if (patch.ultrafast !== undefined) next.ultrafast = patch.ultrafast
    // 关 Fast 就是连 Ultrafast 一起关（手机、频道、恢复默认只认 fast）
    if (patch.fast === false && current.ultrafast) next.ultrafast = false
    if (patch.thinkingSummaries !== undefined) next.thinkingSummaries = patch.thinkingSummaries
    // 运行中且新来源（或新引擎）和正在用的不同（这次换的，或之前换了还没生效）：model / effort 属于新来源，
    // 不动执行设置，也不发给还在用旧来源的进程
    const inUse = rt.execution ? sourceKey(rt.execution) : rt.session ? rt.sessionSource : undefined
    const nextEngine = next.nextEngine !== undefined ? next.nextEngine : current.nextEngine
    const deferred =
      running &&
      ((inUse !== undefined && inUse !== sourceKey({ platform, provider })) ||
        (nextEngine ?? current.engine) !== (rt.execution?.engine ?? current.engine))
    // 运行中换到这个进程换不过去的模型（像素星空经网关时只注册了启动时的模型）：当前这一轮照旧用原模型，
    // 执行设置不改、也不发给进程；下一条消息派发时换进程（turn.ts pump）
    const modelLater = running && patch.model !== undefined && rt.session?.restartsForModel?.(patch.model) === true
    const record = m.events.patchRecord(id, next)
    if (rt.execution) {
      const applied = { ...next }
      // 还没生效的引擎选择不进执行设置（正在执行的还是原来的引擎）
      delete applied.nextEngine
      if (deferred) {
        delete applied.platform
        delete applied.provider
        delete applied.model
        delete applied.effort
      }
      if ((!ENGINES[current.engine].caps.liveModelSwitch || modelLater) && rt.snapshot.state !== 'idle') {
        delete applied.model
        delete applied.effort
      }
      if (!ENGINES[current.engine].caps.livePermissionSwitch && rt.snapshot.state !== 'idle')
        delete applied.permissionMode
      rt.execution = { ...rt.execution, ...applied }
    }
    if (rt.execution) m.events.apply(id, { type: 'execution', settings: queueSettings(rt.execution) })
    const settings: Partial<SessionSettings> = {}
    if (patch.model !== undefined) settings.model = patch.model
    if (patch.effort !== undefined) settings.effort = patch.effort
    if (patch.permissionMode !== undefined) settings.permissionMode = patch.permissionMode
    if (patch.ultracode !== undefined) settings.ultracode = patch.ultracode
    if (patch.fast !== undefined) settings.fast = patch.fast
    if (next.ultrafast !== undefined) settings.ultrafast = next.ultrafast
    if (patch.thinkingSummaries !== undefined) settings.thinkingSummaries = patch.thinkingSummaries
    if (restart && rt.session) {
      if (rt.idleTimer) {
        clearTimeout(rt.idleTimer)
        rt.idleTimer = null
      }
      const s = rt.session
      rt.session = null
      await s.close()
    }
    if (Object.keys(settings).length > 0) {
      // 模型和权限记住用户的选择，作为以后新会话的默认值；推理强度那几项只影响这个会话，
      // 要「设为默认」才改默认值，除非这个引擎打开了「记住会话里的选择」（GitHub #6）
      const remembered: Partial<SessionSettings> = { ...settings }
      // Ultrafast 只对这个会话，什么设置都不记成默认
      delete remembered.ultrafast
      // 记在目标引擎名下（运行中选了别的引擎还没生效时，也算它的）
      const target = record.nextEngine ?? record.engine
      if (!m.settings.remembersChoices(target)) for (const k of EFFORT_PANEL_KEYS) delete remembered[k]
      // 完全放行只管这个对话，不记成新会话的默认；要默认完全放行得在设置里明确改（docs/ui/full-access-confirm.md）
      if (remembered.permissionMode === 'full') delete remembered.permissionMode
      if (Object.keys(remembered).length > 0) m.settings.setDefaults({ ...remembered, engine: target })
      const live = { ...settings }
      if (deferred || modelLater) {
        delete live.model
        delete live.effort
      }
      // 已选下一轮的引擎时，Fast 是给它选的：现在的引擎不支持的话（如第三方接口的 Claude）会写回关闭
      if (record.nextEngine && record.nextEngine !== record.engine) {
        delete live.fast
        delete live.ultrafast
      }
      if (Object.keys(live).length > 0) await rt.session?.update(live)
    }
    if (record.ultrafast && (patch.model !== undefined || changed)) return this.dropUltrafast(id)
    return record
  }

  /**
   * 换了模型或线路后用不了 Ultrafast：退回 Fast 并说一声。进程空闲关掉、这一轮还在跑时引擎自己管不到，
   * 不在这里退回的话换回来就悄悄恢复 8 倍扣费
   */
  private async dropUltrafast(id: string): Promise<SessionRecord> {
    const m = this.ctx.m
    const rt = this.runtime(id)
    const engine = rt.snapshot.record.engine
    const catalog = await this.ctx.adapters[engine]?.catalog?.().catch(() => null)
    // await 期间记录可能又变了（docs 里「反复出现的缺陷」）：按最新的判断
    const fresh = rt.snapshot.record
    // 目录还没读到时不动，进程起来后引擎会再判断
    if (!fresh.ultrafast || !catalog?.models || (!viaGateway(fresh) && ultrafastEligible(catalog, fresh.model)))
      return fresh
    const record = m.events.patchRecord(id, { ultrafast: false })
    if (rt.execution) rt.execution.ultrafast = false
    await rt.session?.update({ ultrafast: false })
    this.addNotice(id, 'warn', ULTRAFAST_DROPPED)
    return record
  }

  renameSession(id: string, title: unknown): SessionRecord {
    if (this.ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const name = normalizeSessionTitle(title)
    const record = this.ctx.m.events.patchRecord(id, { title: name, titleEdited: true })
    const rt = this.ctx.runtimes.get(id)
    if (rt?.execution) rt.execution = { ...rt.execution, title: name, titleEdited: true }
    return record
  }

  /**
   * 在会话里加一条提示（手机改了设置之类，要让电脑上的人看得见；level 用 warn 不会被折叠）。
   * 还没有任何条目的会话不加：加了它就不再算「没开始过」，之后换引擎会走接力而不是直接改（update 里的判断）
   */
  addNotice(id: string, level: 'info' | 'warn' | 'error', text: string): void {
    const { ctx } = this
    const item = { kind: 'notice', id: randomUUID(), level, text } as const
    const rt = ctx.runtimes.get(id)
    if (rt) {
      if (rt.snapshot.items.length > 0) ctx.m.events.apply(id, { type: 'item_completed', item })
      return
    }
    if (!ctx.records.has(id)) throw new Error('会话不存在')
    // 没载入的会话：只追加到磁盘（没人在看它，打开时读到），不为一条提示整份载入
    if (ctx.store.hasItems(id)) ctx.store.appendItem(id, item)
  }

  setSessionBottom(id: string, bottomed: boolean): SessionRecord {
    if (this.ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const current = this.stored(id)
    if (Boolean(current.bottomedAt) === bottomed) return current
    const stamp = bottomed
      ? [...this.ctx.records.values()].reduce(
          (latest, record) => Math.max(latest, (record.bottomedAt ?? 0) + 1),
          Date.now(),
        )
      : null
    // 置底和置顶互斥：置底时取消置顶
    const patch = { bottomedAt: stamp, ...(bottomed ? { pinnedAt: null } : {}) }
    const record = this.ctx.m.events.patchRecord(id, patch)
    const rt = this.ctx.runtimes.get(id)
    if (rt?.execution) rt.execution = { ...rt.execution, ...patch }
    return record
  }

  setSessionPinned(id: string, pinned: boolean): SessionRecord {
    if (this.ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const current = this.stored(id)
    if (Boolean(current.pinnedAt) === pinned) return current
    // 时间戳只增不减，同一毫秒里连着置顶几个也分得出先后
    const stamp = pinned
      ? [...this.ctx.records.values()].reduce(
          (latest, record) => Math.max(latest, (record.pinnedAt ?? 0) + 1),
          Date.now(),
        )
      : null
    const patch = { pinnedAt: stamp, ...(pinned ? { bottomedAt: null } : {}) }
    const record = this.ctx.m.events.patchRecord(id, patch)
    const rt = this.ctx.runtimes.get(id)
    if (rt?.execution) rt.execution = { ...rt.execution, ...patch }
    return record
  }

  async archiveSession(id: string, archived: boolean, stopRunning = false): Promise<void> {
    const { ctx } = this
    const m = ctx.m
    if (ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    if (Boolean(this.stored(id).archivedAt) === archived) return
    const rt = ctx.runtimes.get(id)
    // 没载入的会话没有进程和任务可停：只改记录
    if (!rt) {
      m.events.patchRecord(id, { archivedAt: archived ? Date.now() : null })
      return
    }
    if (archived && (rt.snapshot.state !== 'idle' || rt.pumping || rt.stopping) && !stopRunning)
      throw new Error('SESSION_RUNNING')
    ctx.changingSessions.add(id)
    try {
      if (archived) {
        // 归档会停掉当前任务：等着的 / 派发中的自动重连一起结算成发送失败，不然会话归档了还在后台重连
        m.queue.stopReconnect(id)
        await m.turn.interrupt(id)
        const old = rt.session
        rt.session = null
        await old?.close()
        if (rt.snapshot.turnId)
          m.events.onEngineEvent(id, {
            type: 'turn_completed',
            turnId: rt.snapshot.turnId,
            outcome: 'interrupted',
            error: null,
          })
      }
      m.events.patchRecord(id, { archivedAt: archived ? Date.now() : null })
    } finally {
      ctx.changingSessions.delete(id)
    }
  }

  async deleteSession(id: string): Promise<void> {
    const { ctx } = this
    const m = ctx.m
    if (ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    ctx.changingSessions.add(id)
    try {
      m.cache.forget(id)
      m.compaction.forget(id)
      m.branch.forget(id)
      const rt = ctx.runtimes.get(id)
      if (rt) {
        await m.turn.interrupt(id)
        rt.generation++
        if (rt.idleTimer) clearTimeout(rt.idleTimer)
        if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer)
        ctx.runtimes.delete(id)
        await rt.session?.close()
      }
      const record = ctx.records.get(id)
      ctx.records.delete(id)
      m.queue.forget(id)
      // 记录删掉之后：一轮结束时的快照不会再开始，等正在跑的 git 结束再删目录
      await m.checkpoints.forget(id)
      // 不用项目的对话：文件夹跟着走。分叉共用 chats/<原会话 ID>，最后一个用它的（含归档）删了才处理
      const folder =
        record?.projectId === CHAT_PROJECT_ID &&
        dirname(record.cwd) === m.projects.chatRoot() &&
        ![...ctx.records.values()].some(r => r.cwd === record.cwd)
          ? record.cwd
          : null
      let full = false
      try {
        full = !!folder && readdirSync(folder).length > 0
      } catch {
        // 已经不在了
      }
      const trash = full ? ctx.opts.trash : undefined
      try {
        // 有文件先回收：回收失败就报错、会话放回列表（对话框说的是移到回收站，不能留下找不到的文件夹）
        if (trash)
          await trash(folder!).catch(error => {
            // 原对话和分叉同时删：另一边已经把文件夹移走了，这边也算删成
            if (existsSync(folder!)) throw error
          })
        ctx.store.deleteSession(id)
      } catch (error) {
        // 目录没删掉（被别的程序占着之类）：会话放回列表，可以再删一次，不会变成「会话已不存在」
        if (record) ctx.records.set(id, record)
        throw error
      } finally {
        m.events.broadcastSessions()
      }
      if (folder && !trash)
        try {
          rmSync(folder, { recursive: true, force: true, maxRetries: 2 })
        } catch {
          // 空文件夹被占着之类：留下也无妨
        }
    } finally {
      ctx.changingSessions.delete(id)
    }
  }
}
