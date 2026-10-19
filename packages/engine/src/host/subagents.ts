import { randomUUID } from 'node:crypto'
import {
  emptySnapshot,
  reduce,
  subagentTarget,
  type AgentRun,
  type ApprovalDecision,
  type EngineEvent,
  type Item,
  type SessionRecord,
  type TurnUsage,
} from '@pixelsky/protocol'
import type { EngineSession } from '../adapter'
import type { HostContext, Runtime } from './context'

interface Entry {
  run: AgentRun
  record: SessionRecord
}
interface Active extends Entry {
  parent: string
  session: EngineSession | null
  stop(): Promise<void>
}

/** Independent agent loops share the normal adapters, gateway, approvals and usage accounting. */
export class HostSubagents {
  private readonly entries = new Map<string, Entry[]>()
  private readonly active = new Map<string, Active>()
  private readonly approvals = new Map<string, { parent: string; child: Active; original: string }>()

  constructor(private readonly ctx: HostContext) {}

  restore(id: string): void {
    if (this.entries.has(id)) return
    const entries = this.ctx.store.loadDelegated(id)
    for (const e of entries) {
      if (e.run.state === 'running') {
        e.run.state = 'stopped'
        e.run.result = '应用关闭，子任务已中断；不会自动重新请求模型。'
      }
    }
    this.entries.set(id, entries)
    if (entries.length) {
      this.publish(id)
      for (const entry of entries)
        this.ctx.m.usage.resumeSettlements(entry.record.id, this.ctx.store.loadItems(entry.record.id))
    }
  }

  merge(id: string, event: EngineEvent): EngineEvent {
    const entries = this.entries.get(id) ?? []
    if (!entries.length) return event
    if (event.type === 'runs')
      return {
        ...event,
        runs: {
          ...event.runs,
          agents: [
            ...event.runs.agents.filter(a => !a.id.startsWith('delegated-')),
            ...entries.map(e => ({ ...e.run })),
          ],
        },
      }
    if (event.type === 'subagents')
      return {
        ...event,
        subagents: [
          ...event.subagents.filter(a => !a.id.startsWith('delegated-')),
          ...entries
            .filter(e => e.run.state === 'running')
            .map(e => ({
              id: e.run.id,
              label: e.run.label,
              status: e.run.state,
              message: null,
              task: e.run.prompt,
              toolUseId: e.run.toolUseId ?? undefined,
              background: true,
            })),
        ],
      }
    return event
  }

  private publish(id: string): void {
    const rt = this.ctx.runtimes.get(id)
    if (!rt) return
    this.ctx.m.events.apply(id, { type: 'runs', runs: rt.snapshot.runs })
    this.ctx.m.events.apply(id, { type: 'subagents', subagents: rt.snapshot.subagents })
  }

  private save(id: string): void {
    const entries = this.entries.get(id) ?? []
    this.ctx.store.saveDelegated(id, entries)
    for (const entry of entries) {
      this.ctx.records.set(entry.record.id, entry.record)
      this.ctx.store.saveRecord(entry.record)
    }
  }

  transcript(parent: string, id: string): Item[] | null {
    if (!this.entries.get(parent)?.some(e => e.run.id === id)) return null
    return this.ctx.runtimes.get(id)?.snapshot.items ?? this.ctx.store.loadItems(id)
  }

  answer(parent: string, requestId: string, decision: ApprovalDecision): boolean {
    const request = this.approvals.get(requestId)
    if (!request || request.parent !== parent) return false
    if (!this.active.has(request.child.run.id)) return true
    if (decision.type === 'allow_all') return true
    request.child.session?.answer(request.original, decision)
    return true
  }

  async syncPermissions(parent: string): Promise<void> {
    const record = this.ctx.runtimes.get(parent)?.snapshot.record
    if (!record) return
    await Promise.all(
      [...this.active.values()]
        .filter(e => e.parent === parent)
        .map(async e => {
          e.record.permissionMode = record.permissionMode
          await e.session?.update({ permissionMode: record.permissionMode })
        }),
    )
  }

  async stop(parent: string, id: string): Promise<boolean> {
    const entry = this.active.get(id)
    if (!entry || entry.parent !== parent) return false
    await entry.stop()
    return true
  }

  async stopParent(parent: string): Promise<void> {
    await Promise.all([...this.active.values()].filter(e => e.parent === parent).map(e => e.stop()))
  }

  async forget(parent: string): Promise<void> {
    await this.stopParent(parent)
    for (const entry of this.entries.get(parent) ?? this.ctx.store.loadDelegated(parent)) {
      this.ctx.records.delete(entry.record.id)
      this.ctx.runtimes.delete(entry.record.id)
      this.ctx.store.deleteSession(entry.record.id)
    }
    this.entries.delete(parent)
  }

  async close(): Promise<void> {
    await Promise.all([...this.active.values()].map(e => e.stop()))
  }

  async run(parent: string, task: { description: string; prompt: string }, signal?: AbortSignal): Promise<string> {
    const { ctx } = this
    const rt = ctx.runtimes.get(parent)
    if (!rt?.snapshot.turnId || rt.stopping || ctx.closing || rt.snapshot.record.subagentParentId)
      throw new Error('主会话没有正在执行的任务，无法派出子代理')
    if (ctx.m.guard.isLocked(rt.snapshot.record.cwd)) throw new Error('工作目录正在维护，无法启动子代理')
    if (signal?.aborted) throw new Error('子任务已取消')
    if (
      typeof task.description !== 'string' ||
      !task.description.trim() ||
      task.description.length > 200 ||
      typeof task.prompt !== 'string' ||
      !task.prompt.trim() ||
      task.prompt.length > 100_000
    )
      throw new Error('子任务说明无效')
    if ([...this.active.values()].filter(e => e.parent === parent).length >= 6)
      throw new Error('最多同时运行 6 个子代理，请等待已有任务结束')
    this.restore(parent)
    const source = ctx.m.sessions.record(parent)!
    const selection = rt.snapshot.record.subagent ?? null
    const id = `delegated-${randomUUID()}`
    const startedAt = Date.now()
    const record: SessionRecord = {
      ...source,
      ...subagentTarget(source, selection),
      id,
      subagentParentId: parent,
      subagent: null,
      engineSessionId: null,
      engineSessions: undefined,
      nextEngine: null,
      pendingRewind: null,
      pendingFork: null,
      imported: null,
      forkedFrom: null,
      title: task.description.trim(),
      createdAt: startedAt,
      updatedAt: startedAt,
      lastOutcome: null,
      // Each child has its own context and route; permissions follow the parent.
      ultracode: false,
      fast: false,
    }
    const run: AgentRun = {
      id,
      label: record.title,
      type: 'subagent',
      model: record.model ?? '',
      site:
        ctx.opts.subagentSite?.(record) ??
        (record.provider ? record.provider.id : record.platform ? '像素星空' : record.engine),
      state: 'running',
      startedAt,
      durationMs: 0,
      tokens: 0,
      toolCalls: 0,
      phase: null,
      prompt: task.prompt,
      result: '',
      toolUseId: `${id}-call`,
    }
    const call = (): Item => ({
      kind: 'tool',
      id: run.toolUseId!,
      tool: 'task',
      name: 'Agent',
      title: run.label,
      output: run.result,
      status:
        run.state === 'running'
          ? 'running'
          : run.state === 'completed'
            ? 'completed'
            : run.state === 'failed'
              ? 'failed'
              : 'interrupted',
    })
    let resolve!: (value: string) => void
    let reject!: (error: Error) => void
    const done = new Promise<string>((yes, no) => {
      resolve = yes
      reject = no
    })
    void done.catch(() => undefined)
    let finished = false
    let finishPromise: Promise<void> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const entry: Active = { parent, run, record, session: null, stop: () => finish('stopped', '子任务已停止') }
    const finish = (state: 'completed' | 'failed' | 'stopped', error?: string, usage?: TurnUsage): Promise<void> => {
      if (finishPromise) return finishPromise
      finished = true
      finishPromise = (async () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        record.lastOutcome = state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'interrupted'
        record.updatedAt = Date.now()
        run.state = state
        run.durationMs = Date.now() - startedAt
        if (error) run.result = error + (run.result ? `\n\n部分结果：\n${run.result}` : '')
        if (usage)
          run.tokens = Object.values(usage.models).reduce(
            (sum, m) => sum + m.input + m.output + m.cacheRead + m.cacheWrite,
            0,
          )
        if (ctx.runtimes.has(id) && (usage || ctx.m.usage.hasPlatformRequests(id, id)))
          ctx.m.usage.recordUsage(
            id,
            id,
            state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'interrupted',
            usage ?? { models: {}, durationMs: run.durationMs },
          )
        for (const [requestId, request] of this.approvals) {
          if (request.child !== entry) continue
          this.approvals.delete(requestId)
          ctx.m.events.onEngineEvent(parent, { type: 'approval_resolved', requestId })
        }
        try {
          await entry.session?.close({ quick: ctx.closing })
        } finally {
          this.active.delete(id)
          ctx.runtimes.delete(id)
          this.save(parent)
          ctx.m.events.apply(parent, { type: 'item_completed', item: call() })
          this.publish(parent)
          if (state === 'completed') resolve(run.result || '子代理已完成，没有返回文字报告。')
          else reject(new Error(run.result || '子任务失败'))
        }
      })()
      finishPromise = finishPromise.catch(error => {
        this.active.delete(id)
        ctx.runtimes.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
      return finishPromise
    }
    const abort = () => {
      void finish('stopped', '子任务已取消')
    }
    this.entries.get(parent)!.push(entry)
    this.active.set(id, entry)
    this.save(parent)
    ctx.m.events.apply(parent, { type: 'item_started', item: call() })
    this.publish(parent)
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      void finish('stopped', '子任务超过 30 分钟，已停止')
    }, 30 * 60_000)
    let extensions: Awaited<ReturnType<NonNullable<typeof ctx.opts.extensions>>> | undefined
    try {
      await ctx.opts.validateInput?.(record)
      if (finished) return await done
      const adapter = ctx.adapters[record.engine]
      if (!adapter) throw new Error('子代理执行引擎不可用')
      const info = await adapter.info()
      if (finished) return await done
      if (info.status !== 'ready' && !((record.platform || record.provider) && info.status === 'unauthenticated'))
        throw new Error(info.message ?? '子代理执行引擎不可用')
      extensions = await ctx.opts.extensions?.(record)
      if (finished) {
        extensions?.dispose?.()
        return await done
      }
      const child: Runtime = {
        snapshot: emptySnapshot(record, []),
        seq: 0,
        session: null,
        idleTimer: null,
        receipts: [],
        pumping: false,
        stopping: false,
        generation: 0,
        activeId: null,
        execution: record,
        sessionSource: null,
        sessionMaxRetries: ctx.m.settings.file.maxRetries,
        pumpFinished: null,
      }
      child.snapshot.turnId = id
      ctx.runtimes.set(id, child)
      const emit = (event: EngineEvent): void => {
        if (finished) return
        child.snapshot = reduce(child.snapshot, event)
        if (event.type === 'item_started' || event.type === 'item_completed') {
          const item = event.item
          ctx.store.appendItem(id, item)
          if (item.kind === 'assistant' && event.type === 'item_completed') run.result = item.text
          if (item.kind === 'command' || item.kind === 'file_change' || item.kind === 'tool') {
            if (event.type === 'item_started') run.toolCalls++
            ctx.m.events.apply(parent, {
              ...event,
              item: { ...item, id: `${id}-${item.id}`, subagent: run.label, subagentCall: run.toolUseId! },
            })
            this.publish(parent)
          }
        } else if (event.type === 'item_delta') {
          const item = child.snapshot.items.find(i => i.id === event.itemId)
          if (item?.kind === 'tool' || item?.kind === 'command')
            ctx.m.events.apply(parent, { ...event, itemId: `${id}-${event.itemId}` })
        } else if (event.type === 'approval_request') {
          const requestId = `${id}:${event.request.requestId}`
          this.approvals.set(requestId, { parent, child: entry, original: event.request.requestId })
          ctx.m.events.onEngineEvent(parent, {
            ...event,
            request: {
              ...event.request,
              canAllowAll: false,
              requestId,
              itemId: event.request.itemId ? `${id}-${event.request.itemId}` : run.toolUseId,
              title: `${run.label} · ${event.request.title}`,
            },
          })
        } else if (event.type === 'approval_resolved') {
          const requestId = `${id}:${event.requestId}`
          this.approvals.delete(requestId)
          ctx.m.events.onEngineEvent(parent, { ...event, requestId })
        } else if (event.type === 'turn_completed') {
          void finish(
            event.outcome === 'completed' ? 'completed' : event.outcome === 'failed' ? 'failed' : 'stopped',
            event.error ?? undefined,
            event.usage,
          )
        }
      }
      entry.session = adapter.createSession({
        extensions,
        maxRetries: child.sessionMaxRetries,
        record: () => ({
          ...record,
          permissionMode: ctx.runtimes.get(parent)?.snapshot.record.permissionMode ?? record.permissionMode,
        }),
        emit,
        setEngineSessionId: value => {
          record.engineSessionId = value
        },
        setPermissionMode: () => {},
        setUltracode: () => {},
        setFast: () => {},
      })
      child.session = entry.session
      extensions = undefined
      entry.session.send(
        `Complete this delegated task independently. Do not launch further subagents. Return a concise final report with relevant paths and findings.\n\n${task.prompt}`,
        id,
        `${id}-user`,
      )
    } catch (error) {
      extensions?.dispose?.()
      await finish('failed', error instanceof Error ? error.message : String(error))
    }
    return done
  }
}
