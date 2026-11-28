// 用量与调用记录、平台扣费结算（docs/ui/usage.md §6.2）
import type {
  Item,
  PlatformCharge,
  PlatformRequest,
  SessionRecord,
  TurnOutcome,
  TurnUsage,
  UsagePage,
  UsageRecord,
  UsageBucket,
  UsageSummary,
} from '@pixelsky/protocol'
import { CHAT_PROJECT_ID, estimateCost, officialPrice } from '@pixelsky/protocol'
import { settleUsage } from '../billing'
import { backfillRows, clockOffset, matchCalls, type BackfillTurn } from '../backfill'
import type { UsageQuery } from '../usage'
import type { HostContext } from './context'
import { subscriptionUsageKey } from '../weekly-api'

const DAY = 24 * 60 * 60 * 1000
/** 一轮之外发的平台请求先记在这个键下（按账号分开：结算按账号查实扣） */
const lateKey = (id: string, account: string): string => `${id}:~late:${account}`

export class HostUsage {
  private readonly platformRequests = new Map<string, PlatformRequest[]>()
  /** 最近记过的平台请求 id：响应回来补报 chargeId 时那一轮已经结算了，不再当成新请求记一次 */
  private readonly seenRequests = new Set<string>()
  /** 一轮之外的请求最早什么时候记的：结算按开始时间往前一天查实扣，要从这里查起 */
  private readonly lateSince = new Map<string, number>()
  private readonly settlements = new Map<string, AbortController>()
  /** 清空用量时加一；进行中的结算不再写回已清空的记录 */
  private epoch = 0

  constructor(private readonly ctx: HostContext) {}

  /**
   * Capture the execution before the gateway awaits I/O: a request sent during a turn stays with that turn;
   * one sent between turns (a background subagent) is settled with the next turn.
   * 网关发请求前用自己的 ID 调一次；收到响应后带上 Sub2api 回传的 chargeId 再调一次，补到同一条上。
   */
  platformRequestContext(
    record: SessionRecord,
  ): ((requestId: string, model: string, chargeId?: string) => void) | undefined {
    const rt = this.ctx.runtimes.get(record.id),
      turnId = rt?.snapshot.turnId
    if (!rt || !record.platform) return
    // 一轮之外发的（这一轮结束后还在跑的子智能体）：先记着，并进下一轮结算（docs/ui/usage.md §14）
    const key = turnId ? `${record.id}:${turnId}` : lateKey(record.id, record.platform.account),
      groupId = record.platform.groupId
    return (requestId, model, chargeId) => {
      if (this.ctx.closing) return
      const charge = typeof chargeId === 'string' && /^[a-f0-9-]{36}$/.test(chargeId) ? chargeId : undefined
      // 远端每次回调都重新取上下文：补报时可能已经在下一轮或一轮之外，按 id 在这个会话待结算的请求里找
      const known = this.pendingRequest(record.id, requestId)
      if (known) {
        if (charge) known.chargeId = charge
        return
      }
      if (this.seenRequests.has(requestId) || (turnId && rt.snapshot.turnId !== turnId)) return
      this.seenRequests.add(requestId)
      if (this.seenRequests.size > 5000) this.seenRequests.delete(this.seenRequests.values().next().value!)
      const requests = this.platformRequests.get(key) ?? []
      if (!turnId && !this.lateSince.has(key)) this.lateSince.set(key, Date.now())
      requests.push({ id: requestId, ...(charge ? { chargeId: charge } : {}), model, groupId })
      this.platformRequests.set(key, requests)
    }
  }

  private pendingRequest(id: string, requestId: string): PlatformRequest | undefined {
    for (const [key, requests] of this.platformRequests)
      if (key.startsWith(`${id}:`)) {
        const found = requests.find(r => r.id === requestId)
        if (found) return found
      }
  }

  /** 这一轮经平台网关发过请求（引擎没报用量也要记一行待结算） */
  hasPlatformRequests(id: string, turnId: string): boolean {
    const rt = this.ctx.runtimes.get(id),
      account = (rt?.execution ?? rt?.snapshot.record)?.platform?.account
    return (
      this.platformRequests.has(`${id}:${turnId}`) || (!!account && this.platformRequests.has(lateKey(id, account)))
    )
  }

  /** 一轮结束：按模型写用量记录，并在对话流里加一行统计（显示在这一轮回复下方） */
  recordUsage(id: string, turnId: string, outcome: TurnOutcome, usage: TurnUsage): void {
    const { ctx } = this
    const rt = ctx.runtimes.get(id)
    if (!rt) return
    const record = rt.execution ?? rt.snapshot.record
    const key = `${id}:${turnId}`
    let startedAt = Date.now() - usage.durationMs
    for (const [late, requests] of this.platformRequests) {
      if (!late.startsWith(lateKey(id, ''))) continue
      this.platformRequests.delete(late)
      const since = this.lateSince.get(late) ?? startedAt
      this.lateSince.delete(late)
      // 换过账号的不并：用这一轮的账号查不到它们的实扣，这一轮同一个模型整行都会变成「—」
      if (!record.platform || late !== lateKey(id, record.platform.account)) continue
      this.platformRequests.set(key, [...requests, ...(this.platformRequests.get(key) ?? [])])
      startedAt = Math.min(startedAt, since)
    }
    if (record.platform) {
      usage = settleUsage(
        {
          ...usage,
          settlement: {
            account: record.platform.account,
            requests: this.platformRequests.get(key) ?? [],
            startedAt,
            complete: false,
          },
        },
        [],
        false,
      )
    }
    if (record.provider && !record.platform) usage = this.customEstimate(record, usage)
    this.platformRequests.delete(key)
    const account =
      !record.platform && !record.provider && record.engine === 'codex'
        ? rt.session?.usageSubscriptionAccount?.()
        : null
    const subscriptionKey = account ? subscriptionUsageKey(account) : undefined
    const endedAt = Date.now()
    // 对话不算项目：写 null，用量页显示「未归属项目」（存的名字不随界面语言变）
    const project = record.projectId === CHAT_PROJECT_ID ? null : (ctx.m.projects.find(record.projectId)?.name ?? null)
    const rows: UsageRecord[] = Object.entries(usage.models).map(([model, m]) => ({
      v: 1,
      id: `${id}:${turnId}:${model}`,
      sessionId: id,
      turnId,
      startedAt: endedAt - usage.durationMs,
      endedAt,
      durationMs: usage.durationMs,
      sessionTitle: record.title,
      project,
      engine: record.engine,
      model,
      // 目前引擎都用命令行自己的登录；像素星空账号网关做好后是 'pixelsky'（Q5）
      route: record.platform ? 'pixelsky' : record.provider ? 'api-key' : 'cli',
      ...(subscriptionKey ? { subscriptionUsageKey: subscriptionKey } : {}),
      requests: m.requests,
      input: m.input,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      output: m.output,
      costUsd: m.costUsd,
      costSource: m.costSource ?? 'estimate',
      billing: m.billing,
      outcome,
      genMs: m.genMs,
      genOutput: m.genOutput,
      firstTokenMs: m.firstTokenMs,
    }))
    try {
      ctx.usage.append(rows)
    } catch {
      // 写不进去（磁盘满、权限）不影响对话
    }
    ctx.m.events.apply(id, {
      type: 'item_completed',
      item: { kind: 'turn_stats', id: `stats-${turnId}`, turnId, outcome, usage },
    })
    ctx.opts.emit({ kind: 'usage_recorded' })
    if (usage.settlement) this.startSettlement(id, turnId, outcome, usage)
  }

  /**
   * 自定义 API：不用引擎自己报的费用（Claude Code 只认官方模型名，Codex 不报），统一按官方价格表估算；
   * 对不上价格的只留 token（docs/ui/custom-api.md §4.3）
   */
  private customEstimate(record: SessionRecord, usage: TurnUsage): TurnUsage {
    const multiplier = this.ctx.opts.costMultiplier?.(record) ?? 1
    const models = Object.fromEntries(
      Object.entries(usage.models).map(([model, m]) => {
        const price = officialPrice(model, this.ctx.opts.priceRef?.(record, model))
        const cost = estimateCost(m, price)
        const costUsd = cost === null ? null : cost * multiplier
        return [model, { ...m, costUsd, costSource: 'estimate' as const }]
      }),
    )
    return { ...usage, models, estimate: 'official' }
  }

  /** 已保存的统计里还没结算完的，继续结算（原账号和请求 ID 都已落盘，不按当前路由推断） */
  resumeSettlements(id: string, items: readonly Item[]): void {
    for (const item of items)
      if (item.kind === 'turn_stats' && item.usage.settlement && !item.usage.settlement.complete)
        this.startSettlement(id, item.turnId, item.outcome, item.usage)
  }

  private startSettlement(id: string, turnId: string, outcome: TurnOutcome, original: TurnUsage): void {
    const { ctx } = this
    const key = `${id}:${turnId}`
    if (ctx.closing || this.settlements.has(key) || !original.settlement?.requests.length) return
    const controller = new AbortController(),
      epoch = this.epoch
    this.settlements.set(key, controller)
    const charges = new Map<string, PlatformCharge>()
    let rows: UsageRecord[] | undefined
    const delays = ctx.opts.settlementDelays ?? [1000, 3000, 10000, 30000, 60000]
    void (async () => {
      for (let attempt = 0; attempt < delays.length; attempt++) {
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', done)
            resolve()
          }
          const timer = setTimeout(done, delays[attempt])
          timer.unref()
          controller.signal.addEventListener('abort', done, { once: true })
        })
        if (controller.signal.aborted || ctx.closing || !ctx.records.has(id)) return
        try {
          const result = await ctx.opts.platformCharges?.(original.settlement!, controller.signal)
          for (const charge of result ?? []) charges.set(charge.requestId, charge)
        } catch {
          /* asynchronous billing or expired authentication: keep pending until the final attempt */
        }
        if (controller.signal.aborted || ctx.closing || !ctx.records.has(id)) return
        const usage = settleUsage(original, [...charges.values()], attempt === delays.length - 1)
        // Update only existing statistics. A rewind must not resurrect discarded messages.
        const rt = ctx.runtimes.get(id)
        if (rt?.snapshot.items.some(item => item.id === `stats-${turnId}`)) {
          ctx.m.events.apply(id, {
            type: 'item_completed',
            item: { kind: 'turn_stats', id: `stats-${turnId}`, turnId, outcome, usage },
          })
        }
        if (epoch === this.epoch) {
          // 这一轮的用量行只在第一次读（原来每次重试都整读当月的用量文件），之后用上次写下的；
          // 内容没变的行不再重复写（docs/perf-audit-2026-10-18.md D13）
          rows ??= ctx.usage
            .load(original.settlement!.startedAt)
            .filter(row => row.sessionId === id && row.turnId === turnId)
          const next = rows.map(row => {
            const model = usage.models[row.model]
            // 已经按时间补录过实扣的，按 ID 还是查不到时不改回「—」
            if (!model || (row.costMatch === 'time' && model.costSource !== 'platform')) return row
            return { ...row, ...model, costMatch: undefined }
          })
          const changed = next.filter((row, i) => JSON.stringify(row) !== JSON.stringify(rows![i]))
          rows = next
          if (changed.length) {
            ctx.usage.append(changed)
            ctx.opts.emit({ kind: 'usage_recorded' })
          }
        }
        if (usage.settlement!.complete) return
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        if (this.settlements.get(key) === controller) this.settlements.delete(key)
      })
  }

  /**
   * 旧的云端记录（没拿到 Sub2api 请求 ID，按 ID 永远查不到）按时间对账号调用补录实扣（docs/ui/usage.md §11.2）。
   * 只看 90 天内、10 分钟前结束、还没对过的；对过的（不管对没对上）都标上 costMatch，下次不再读。
   * 返回补上实扣的轮次数。
   */
  async backfillPlatformCosts(account: string, signal: AbortSignal): Promise<number> {
    const { ctx } = this
    if (!ctx.opts.platformCalls) return 0
    const now = Date.now()
    const turns = new Map<string, BackfillTurn>()
    for (const row of ctx.usage.load(now - 90 * DAY)) {
      const key = `${row.sessionId}:${row.turnId}`
      if (
        row.route !== 'pixelsky' ||
        row.costSource === 'platform' ||
        row.costMatch ||
        row.endedAt > now - 10 * 60_000 ||
        this.settlements.has(key)
      )
        continue
      const turn = turns.get(key)
      if (turn) {
        turn.rows.push(row)
        turn.startedAt = Math.min(turn.startedAt, row.startedAt)
        turn.endedAt = Math.max(turn.endedAt, row.endedAt)
      } else turns.set(key, { key, startedAt: row.startedAt, endedAt: row.endedAt, rows: [row] })
    }
    // 记着别的账号的轮次不动
    const stats = new Map<string, Extract<Item, { kind: 'turn_stats' }>>()
    const items = new Map<string, readonly Item[]>()
    for (const turn of [...turns.values()]) {
      const { sessionId, turnId } = turn.rows[0]
      // 没打开的会话只流式读统计条目，不整读整解析（docs/perf-audit-2026-10-18.md B8）
      if (!items.has(sessionId))
        items.set(sessionId, ctx.runtimes.get(sessionId)?.snapshot.items ?? (await ctx.store.loadTurnStats(sessionId)))
      if (signal.aborted || ctx.closing) return 0
      const item = items.get(sessionId)!.find(i => i.kind === 'turn_stats' && i.turnId === turnId)
      if (item?.kind === 'turn_stats') stats.set(turn.key, item)
      const owner = item?.kind === 'turn_stats' ? item.usage.settlement?.account : undefined
      if (owner && owner !== account) turns.delete(turn.key)
    }
    if (!turns.size) return 0
    const list = [...turns.values()]
    const epoch = this.epoch
    const calls = await ctx.opts.platformCalls(
      {
        account,
        from: Math.min(...list.map(t => t.startedAt)) - DAY,
        to: Math.min(now, Math.max(...list.map(t => t.endedAt)) + DAY),
      },
      signal,
    )
    if (signal.aborted || ctx.closing || epoch !== this.epoch) return 0
    const charges = matchCalls(list, calls, clockOffset(list, calls))
    const rows: UsageRecord[] = []
    let settledTurns = 0
    for (const turn of list) {
      const next = backfillRows(turn, charges.get(turn.key))
      rows.push(...next)
      if (!next.some(r => r.costMatch === 'time')) continue
      settledTurns++
      const item = stats.get(turn.key)
      if (!item) continue
      // 回复下方的统计也换成实扣；结算标成完成，打开会话时不再按 ID 重查
      const usage: TurnUsage = {
        ...item.usage,
        models: Object.fromEntries(
          next.map(r => [
            r.model,
            {
              input: r.input,
              output: r.output,
              cacheRead: r.cacheRead,
              cacheWrite: r.cacheWrite,
              requests: r.requests,
              costUsd: r.costUsd,
              costSource: r.costSource,
              ...(r.billing ? { billing: r.billing } : {}),
            },
          ]),
        ),
        ...(item.usage.settlement ? { settlement: { ...item.usage.settlement, complete: true } } : {}),
      }
      const updated = { ...item, usage }
      const id = turn.rows[0].sessionId
      const rt = ctx.runtimes.get(id)
      // 会话开着：只改内存里还在的。等网络期间这一轮被回退掉了就不管，不能再追加到磁盘（重启后会多出一张费用卡片）
      if (rt) {
        if (rt.snapshot.items.some(i => i.id === item.id))
          ctx.m.events.apply(id, { type: 'item_completed', item: updated })
      } else if (ctx.records.has(id)) ctx.store.appendItem(id, updated)
    }
    ctx.usage.append(rows)
    ctx.opts.emit({ kind: 'usage_recorded' })
    return settledTurns
  }

  /** 退出应用：停掉所有进行中的结算 */
  abortSettlements(): void {
    for (const job of this.settlements.values()) job.abort()
  }

  weeklySampleRows(from: number): UsageRecord[] {
    return this.ctx.usage.load(from)
  }

  usageSummary(q: UsageQuery): UsageSummary {
    return this.ctx.usage.summary(q)
  }

  usageList(q: UsageQuery & { offset: number; limit: number }): UsagePage {
    return this.ctx.usage.list(q)
  }

  usageDaily(q: UsageQuery): UsageBucket[] {
    return this.ctx.usage.daily(q)
  }

  usageCsv(q: UsageQuery): string {
    return this.ctx.usage.csv(q)
  }

  usageClear(): void {
    this.epoch++
    this.ctx.usage.clear()
    this.ctx.opts.emit({ kind: 'usage_recorded' })
  }
}
