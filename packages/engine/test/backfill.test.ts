import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteCall, UsageRecord } from '@pixelsky/protocol'
import { backfillRows, clockOffset, matchCalls, type BackfillTurn } from '../src/backfill'
import { EngineHost } from '../src/host'
import { Store } from '../src/store'
import { UsageStore } from '../src/usage'

const at = (hms: string) => new Date(`2026-10-11T${hms}+08:00`).getTime()
const row = (p: Partial<UsageRecord> & Pick<UsageRecord, 'turnId' | 'startedAt' | 'durationMs'>): UsageRecord => ({
  v: 1,
  id: `s1:${p.turnId}:${p.model ?? 'claude-opus-5-5'}`,
  sessionId: 's1',
  endedAt: p.startedAt + p.durationMs,
  sessionTitle: 't',
  project: null,
  engine: 'claude',
  model: 'claude-opus-5-5',
  route: 'pixelsky',
  requests: 1,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  costUsd: null,
  costSource: 'unavailable',
  outcome: 'completed',
  ...p,
})
const call = (p: Partial<RemoteCall> & Pick<RemoteCall, 'createdAt' | 'durationMs' | 'costUsd'>): RemoteCall => ({
  id: String(p.createdAt),
  model: 'claude-opus-5-5',
  client: 'unknown',
  device: null,
  keyName: null,
  stream: true,
  status: 'success',
  httpStatus: 200,
  input: 2,
  cacheRead: 0,
  cacheWrite: 0,
  output: 10,
  firstTokenMs: null,
  turnId: null,
  billing: 'balance',
  ...p,
})
const turnOf = (rows: UsageRecord[]): BackfillTurn => ({
  key: `${rows[0].sessionId}:${rows[0].turnId}`,
  startedAt: Math.min(...rows.map(r => r.startedAt)),
  endedAt: Math.max(...rows.map(r => r.endedAt)),
  rows,
})

// 2026-10-11 00:54 前后的真实形状：本机时钟比服务器快 35 秒；云端的时间是请求结束（服务器时钟）
const t1 = row({ turnId: 'a', startedAt: at('00:54:12'), durationMs: 29_000, output: 172, cacheWrite: 29755, input: 2 })
const t2 = row({
  turnId: 'b',
  startedAt: at('00:55:23'),
  durationMs: 16_000,
  output: 763,
  cacheRead: 29755,
  cacheWrite: 216,
  input: 2,
})
const t3 = row({ turnId: 'c', startedAt: at('00:56:56'), durationMs: 296_000, requests: 26 })
const t4 = row({ turnId: 'd', startedAt: at('21:59:19'), durationMs: 0, outcome: 'interrupted' })
const calls = [
  call({ createdAt: at('00:54:06'), durationMs: 27_299, costUsd: 0.091334, output: 172, cacheWrite: 29755 }),
  call({
    createdAt: at('00:55:03'),
    durationMs: 14_120,
    costUsd: 0.013379,
    output: 763,
    cacheRead: 29755,
    cacheWrite: 216,
  }),
  call({ createdAt: at('00:55:10'), durationMs: 6_324, costUsd: 0.007256, input: 506 }),
  call({ createdAt: at('00:56:28'), durationMs: 5_906, costUsd: 0.008541 }),
  call({ createdAt: at('01:01:21'), durationMs: 4_271, costUsd: 0.016764, billing: 'subscription' }),
  // 别的工具同时段换了模型：也归到这一轮，单独一行
  call({ createdAt: at('00:58:00'), durationMs: 2_000, costUsd: 0.001, model: 'claude-haiku-5-5' }),
  // 远离任何一轮的不算
  call({ createdAt: at('12:00:00'), durationMs: 1_000, costUsd: 1 }),
]
const turns = [t1, t2, t3, t4].map(r => turnOf([r]))

describe('旧云端记录按时间补录实扣（docs/ui/usage.md §11.2）', () => {
  it('从 token 完全一样的调用量出时钟差', () => {
    expect(clockOffset(turns, calls)).toBeGreaterThanOrEqual(35_000)
    expect(clockOffset(turns, calls)).toBeLessThan(37_000)
    expect(clockOffset(turns, [])).toBe(0)
  })

  it('每次调用归到它开始时正在进行的那一轮，一次只归一轮', () => {
    const m = matchCalls(turns, calls, clockOffset(turns, calls))
    expect(m.get('s1:a')?.get('claude-opus-5-5')).toMatchObject({ requests: 1, costUsd: 0.091334, cacheWrite: 29755 })
    // 第二轮结束时跑的那次小请求（结束后 1 秒内开始）也算这一轮
    expect(m.get('s1:b')?.get('claude-opus-5-5')?.requests).toBe(2)
    const c = m.get('s1:c')!
    expect(c.get('claude-opus-5-5')).toMatchObject({ requests: 2, billing: 'balance' })
    expect(c.get('claude-opus-5-5')!.costUsd).toBeCloseTo(0.025305)
    expect(c.get('claude-haiku-5-5')?.requests).toBe(1)
    expect(m.has('s1:d')).toBe(false)
    const all = [...m.values()].flatMap(x => [...x.values()]).reduce((s, x) => s + x.requests, 0)
    expect(all).toBe(6)
  })

  it('对上的换成实扣；没对上又没收到 token 的是 $0；其余标成不再重试', () => {
    const m = matchCalls(turns, calls, 35_000)
    const c = backfillRows(turns[2], m.get('s1:c'))
    expect(c).toHaveLength(2)
    expect(c[0]).toMatchObject({ id: 's1:c:claude-opus-5-5', costSource: 'platform', costMatch: 'time', requests: 2 })
    expect(c[1]).toMatchObject({ id: 's1:c:claude-haiku-5-5', model: 'claude-haiku-5-5', costUsd: 0.001 })
    expect(backfillRows(turns[3], undefined)).toEqual([
      { ...t4, costUsd: 0, costSource: 'platform', costMatch: 'time' },
    ])
    expect(backfillRows(turnOf([{ ...t1, turnId: 'x' }]), undefined)[0]).toMatchObject({
      costSource: 'unavailable',
      costMatch: 'none',
    })
  })
})

describe('EngineHost.backfillPlatformCosts', () => {
  let root: string
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('改写用量记录和回复下方的统计，只读一次，不动别的账号的轮次', async () => {
    root = mkdtempSync(join(tmpdir(), 'pixelsky-backfill-'))
    const dataDir = join(root, 'data')
    const first = new EngineHost({ dataDir, emit() {} })
    const record = first.createSession({
      projectId: first.addProject(root).id,
      model: 'claude-opus-5-5',
      effort: 'low',
    })
    await first.shutdown()

    const start = Date.now() - 2 * 60 * 60_000
    const mine = row({
      sessionId: record.id,
      id: `${record.id}:t1:claude-opus-5-5`,
      turnId: 't1',
      startedAt: start,
      durationMs: 60_000,
      output: 5,
    })
    const other = row({
      sessionId: record.id,
      id: `${record.id}:t2:claude-opus-5-5`,
      turnId: 't2',
      startedAt: start + 120_000,
      durationMs: 60_000,
    })
    new UsageStore(dataDir).append([mine, other])
    const store = new Store(dataDir)
    const stats = (turnId: string, account: string) => ({
      kind: 'turn_stats' as const,
      id: `stats-${turnId}`,
      turnId,
      outcome: 'completed' as const,
      usage: {
        durationMs: 60_000,
        models: {
          'claude-opus-5-5': {
            input: 0,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: null,
            costSource: 'unavailable' as const,
          },
        },
        settlement: {
          account,
          requests: [{ id: 'pixelsky-x', model: 'claude-opus-5-5', groupId: '1' }],
          startedAt: start,
          complete: false,
        },
      },
    })
    store.appendItem(record.id, stats('t1', 'alice'))
    store.appendItem(record.id, stats('t2', 'bob'))

    let reads = 0
    const host = new EngineHost({
      dataDir,
      emit() {},
      platformCalls: async q => {
        reads++
        expect(q.account).toBe('alice')
        return [call({ createdAt: start + 30_000, durationMs: 10_000, costUsd: 0.25, output: 7 })]
      },
    })
    try {
      expect(await host.backfillPlatformCosts('alice', new AbortController().signal)).toBe(1)
      const rows = host.usageList({ range: '7d', now: Date.now(), filter: {}, offset: 0, limit: 10 }).records
      expect(rows.find(r => r.turnId === 't1')).toMatchObject({
        costUsd: 0.25,
        costSource: 'platform',
        costMatch: 'time',
        output: 7,
      })
      expect(rows.find(r => r.turnId === 't2')).toMatchObject({ costSource: 'unavailable' })
      expect(host.open(record.id).items.find(i => i.id === 'stats-t1')).toMatchObject({
        usage: {
          models: { 'claude-opus-5-5': { costUsd: 0.25, costSource: 'platform' } },
          settlement: { complete: true },
        },
      })
      // 对过的不再读
      expect(await host.backfillPlatformCosts('alice', new AbortController().signal)).toBe(0)
      expect(reads).toBe(1)
    } finally {
      await host.shutdown()
    }
  })

  it('等网络期间这一轮被回退掉了：不把统计条目重新追加到磁盘', async () => {
    root = mkdtempSync(join(tmpdir(), 'pixelsky-backfill-'))
    const dataDir = join(root, 'data')
    const first = new EngineHost({ dataDir, emit() {} })
    const record = first.createSession({ projectId: first.addProject(root).id, model: 'claude-opus-5-5' })
    await first.shutdown()
    const start = Date.now() - 2 * 60 * 60_000
    new UsageStore(dataDir).append([
      row({
        sessionId: record.id,
        id: `${record.id}:t1:claude-opus-5-5`,
        turnId: 't1',
        startedAt: start,
        durationMs: 60_000,
      }),
    ])
    const model = {
      input: 0,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: null,
      costSource: 'unavailable' as const,
    }
    new Store(dataDir).appendItem(record.id, {
      kind: 'turn_stats',
      id: 'stats-t1',
      turnId: 't1',
      outcome: 'completed',
      usage: { durationMs: 60_000, models: { 'claude-opus-5-5': model } },
    })
    type Internals = { ctx: { runtimes: Map<string, { snapshot: { items: unknown[] } }> } }
    const host: EngineHost = new EngineHost({
      dataDir,
      emit() {},
      platformCalls: async () => {
        // 模拟回退：会话开着，这一轮已经不在内存里
        ;(host as unknown as Internals).ctx.runtimes.get(record.id)!.snapshot.items = []
        return [call({ createdAt: start + 30_000, durationMs: 10_000, costUsd: 0.25 })]
      },
    })
    try {
      host.open(record.id)
      expect(await host.backfillPlatformCosts('alice', new AbortController().signal)).toBe(1)
    } finally {
      await host.shutdown()
    }
    const disk = await new Store(dataDir).loadTurnStats(record.id)
    expect(disk.filter(i => i.id === 'stats-t1')).toHaveLength(1)
    expect(disk.find(i => i.id === 'stats-t1')).toMatchObject({
      usage: { models: { 'claude-opus-5-5': { costSource: 'unavailable' } } },
    })
  })
})
