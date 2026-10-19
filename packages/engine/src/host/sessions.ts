// 会话：创建、打开（懒创建运行时）、改设置、改名、置底、回退、归档、删除
import { randomUUID } from 'node:crypto'
import {
  EFFORT_PANEL_KEYS,
  emptySnapshot,
  normalizeSessionTitle,
  PROVIDER_ID,
  sourceKey,
  type EngineId,
  type OpenedSession,
  type SessionRecord,
  type SessionSettings,
  type SessionSnapshot,
  type SessionSummary,
} from '@pixelsky/protocol'
import { queueSettings } from '../queue'
import { ENGINES } from '../registry'
import type { HostContext, Runtime } from './context'
import { NEW_TITLE } from './title'

export class HostSessions {
  constructor(private readonly ctx: HostContext) {}

  sessions(): SessionSummary[] {
    const { ctx } = this
    return [...ctx.records.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(record => {
        const queue = ctx.m.queue.queueSummary(record.id)
        const snapshot = ctx.runtimes.get(record.id)?.snapshot
        const background = snapshot?.background ?? 0
        return {
          record,
          state: snapshot?.state ?? 'idle',
          ...(background ? { background } : {}),
          ...(queue ? { queue } : {}),
        }
      })
  }

  createSession(
    opts: { projectId: string } & Partial<SessionSettings> & { engine?: EngineId },
    workspacePath?: string,
  ): SessionRecord {
    const { ctx } = this
    const m = ctx.m
    const project = m.projects.find(opts.projectId)
    if (!project) throw new Error('项目不存在')
    if (m.guard.isLocked(workspacePath ?? project.path)) throw new Error('工作目录正在维护，请稍后重试')
    const engine = opts.engine ?? m.settings.file.defaults.engine
    if (opts.platform && opts.provider) throw new Error('额度来源无效')
    if (opts.provider && (typeof opts.provider.id !== 'string' || !PROVIDER_ID.test(opts.provider.id)))
      throw new Error('无效的自定义接口')
    const d = m.settings.engineDefaults(engine)
    const now = Date.now()
    const record: SessionRecord = {
      id: randomUUID(),
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
      thinkingSummaries: opts.thinkingSummaries ?? d.thinkingSummaries,
      createdAt: now,
      updatedAt: now,
      lastOutcome: null,
      archivedAt: null,
      bottomedAt: null,
      pinnedAt: null,
      titleEdited: false,
    }
    ctx.records.set(record.id, record)
    ctx.store.saveRecord(record)
    // 打开了「记住会话里的选择」：新会话界面上（发第一条消息前）改的推理强度那几项也记成默认值（GitHub #6）
    if (m.settings.remembersChoices(engine)) {
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
    let rt = ctx.runtimes.get(id)
    if (rt) return rt
    const record = ctx.records.get(id)
    if (!record) throw new Error('会话不存在')
    const snapshot = emptySnapshot(record, ctx.store.loadItems(id))
    const adapter = ctx.adapters[record.engine]
    if (adapter?.restoreItem)
      snapshot.items = snapshot.items.map(item => {
        const restored = adapter.restoreItem!(record, item)
        if (restored !== item) ctx.store.appendItem(id, restored)
        return restored
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
    rt = {
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

  openSession(id: string): OpenedSession {
    const rt = this.runtime(id)
    this.ctx.m.usage.resumeSettlements(id, rt.snapshot.items)
    return { snapshot: rt.snapshot, seq: rt.seq }
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
    if (patch.effort !== undefined) next.effort = patch.effort
    if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode
    if (patch.ultracode !== undefined) next.ultracode = patch.ultracode
    if (patch.fast !== undefined) next.fast = patch.fast
    if (patch.thinkingSummaries !== undefined) next.thinkingSummaries = patch.thinkingSummaries
    // 运行中且新来源（或新引擎）和正在用的不同（这次换的，或之前换了还没生效）：model / effort 属于新来源，
    // 不动执行设置，也不发给还在用旧来源的进程
    const inUse = rt.execution ? sourceKey(rt.execution) : rt.session ? rt.sessionSource : undefined
    const nextEngine = next.nextEngine !== undefined ? next.nextEngine : current.nextEngine
    const deferred =
      running &&
      ((inUse !== undefined && inUse !== sourceKey({ platform, provider })) ||
        (nextEngine ?? current.engine) !== (rt.execution?.engine ?? current.engine))
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
      if (!ENGINES[current.engine].caps.liveModelSwitch && rt.snapshot.state !== 'idle') {
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
      // 记在目标引擎名下（运行中选了别的引擎还没生效时，也算它的）
      const target = record.nextEngine ?? record.engine
      if (!m.settings.remembersChoices(target)) for (const k of EFFORT_PANEL_KEYS) delete remembered[k]
      // 完全放行只管这个对话，不记成新会话的默认；要默认完全放行得在设置里明确改（docs/ui/full-access-confirm.md）
      if (remembered.permissionMode === 'full') delete remembered.permissionMode
      if (Object.keys(remembered).length > 0) m.settings.setDefaults({ ...remembered, engine: target })
      const live = { ...settings }
      if (deferred) {
        delete live.model
        delete live.effort
      }
      if (Object.keys(live).length > 0) await rt.session?.update(live)
    }
    return record
  }

  renameSession(id: string, title: unknown): SessionRecord {
    if (this.ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const name = normalizeSessionTitle(title),
      rt = this.runtime(id)
    const record = this.ctx.m.events.patchRecord(id, { title: name, titleEdited: true })
    if (rt.execution) rt.execution = { ...rt.execution, title: name, titleEdited: true }
    return record
  }

  /**
   * 在会话里加一条提示（手机改了设置之类，要让电脑上的人看得见；level 用 warn 不会被折叠）。
   * 还没有任何条目的会话不加：加了它就不再算「没开始过」，之后换引擎会走接力而不是直接改（update 里的判断）
   */
  addNotice(id: string, level: 'info' | 'warn' | 'error', text: string): void {
    const rt = this.runtime(id)
    if (rt.snapshot.items.length === 0) return
    this.ctx.m.events.apply(id, { type: 'item_completed', item: { kind: 'notice', id: randomUUID(), level, text } })
  }

  setSessionBottom(id: string, bottomed: boolean): SessionRecord {
    if (this.ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const rt = this.runtime(id)
    if (Boolean(rt.snapshot.record.bottomedAt) === bottomed) return rt.snapshot.record
    const stamp = bottomed
      ? [...this.ctx.records.values()].reduce(
          (latest, record) => Math.max(latest, (record.bottomedAt ?? 0) + 1),
          Date.now(),
        )
      : null
    // 置底和置顶互斥：置底时取消置顶
    const patch = { bottomedAt: stamp, ...(bottomed ? { pinnedAt: null } : {}) }
    const record = this.ctx.m.events.patchRecord(id, patch)
    if (rt.execution) rt.execution = { ...rt.execution, ...patch }
    return record
  }

  setSessionPinned(id: string, pinned: boolean): SessionRecord {
    if (this.ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const rt = this.runtime(id)
    if (Boolean(rt.snapshot.record.pinnedAt) === pinned) return rt.snapshot.record
    // 时间戳只增不减，同一毫秒里连着置顶几个也分得出先后
    const stamp = pinned
      ? [...this.ctx.records.values()].reduce(
          (latest, record) => Math.max(latest, (record.pinnedAt ?? 0) + 1),
          Date.now(),
        )
      : null
    const patch = { pinnedAt: stamp, ...(pinned ? { bottomedAt: null } : {}) }
    const record = this.ctx.m.events.patchRecord(id, patch)
    if (rt.execution) rt.execution = { ...rt.execution, ...patch }
    return record
  }

  async archiveSession(id: string, archived: boolean, stopRunning = false): Promise<void> {
    const { ctx } = this
    const m = ctx.m
    if (ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const rt = this.runtime(id)
    if (Boolean(rt.snapshot.record.archivedAt) === archived) return
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
      const rt = ctx.runtimes.get(id)
      if (rt) {
        await m.turn.interrupt(id)
        rt.generation++
        if (rt.idleTimer) clearTimeout(rt.idleTimer)
        if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer)
        ctx.runtimes.delete(id)
        await rt.session?.close()
      }
      ctx.records.delete(id)
      m.queue.forget(id)
      ctx.store.deleteSession(id)
      m.events.broadcastSessions()
    } finally {
      ctx.changingSessions.delete(id)
    }
  }
}
