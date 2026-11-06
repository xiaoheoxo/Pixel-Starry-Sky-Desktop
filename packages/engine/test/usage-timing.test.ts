// Token 速度、首字和热力图的数据（docs/ui/usage-learn.md §1.1、§2）
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyTotals, heatmapStart, outputSpeed, type ModelTurnUsage, type UsageRecord } from '@pixelsky/protocol'
import { settleUsage } from '../src/billing'
import { ClaudeTranslator } from '../src/claude/translate'
import { PixelTranslator } from '../src/pixel/translate'
import { GenTimer } from '../src/genTimer'
import { USAGE_RETENTION_DAYS, UsageStore } from '../src/usage'

const usage = (): ModelTurnUsage => ({ input: 1, cacheRead: 0, cacheWrite: 0, output: 500, costUsd: null })

describe('GenTimer', () => {
  it('同一个模型的多段累加，段之间的时间（跑工具）不算；首字从这一轮开始算', () => {
    let now = 1000
    const t = new GenTimer(() => now)
    now = 3000
    t.begin()
    now = 3500
    t.first()
    now = 5000
    t.update('m', 100)
    t.flush()
    now = 60_000 // 中间跑了将近一分钟工具
    t.begin()
    now = 61_000
    t.update('m', 50)
    t.update('m', 300) // 累计值：只认最后一次
    const models = { m: usage() }
    t.apply(models, 1000)
    expect(models.m).toMatchObject({ genMs: 3000, genOutput: 400, firstTokenMs: 2500 })
  })

  it('没报输出、短得不正常的段不算；用量里的模型名带后缀也能对上', () => {
    let now = 0
    const t = new GenTimer(() => now)
    t.begin() // 没有 update：中断了
    t.begin()
    now = 50
    t.update('m', 900) // 一次到的响应
    t.flush()
    t.begin()
    now = 1050
    t.update('m', 300)
    const models = { 'm[1m]': usage() }
    t.apply(models, 0)
    expect(models['m[1m]']).toMatchObject({ genMs: 1000, genOutput: 300 })
  })

  it('reset 之后不带上一轮的；首字记在第一段的模型上', () => {
    let now = 0
    const t = new GenTimer(() => now)
    t.begin()
    now = 500
    t.first()
    t.update('old', 10)
    t.reset()
    t.begin()
    now = 900
    t.first()
    now = 1500
    t.update('a', 200)
    t.flush()
    t.begin()
    now = 2500
    t.update('b', 200)
    const models = { a: usage(), b: usage(), old: usage() }
    t.apply(models, 0)
    expect(models.old.genMs).toBeUndefined()
    expect(models.a.firstTokenMs).toBe(900)
    expect(models.b.firstTokenMs).toBeUndefined()
  })
})

describe('各引擎量到的时间', () => {
  afterEach(() => vi.useRealTimers())

  it('Claude：跑工具不算，子智能体的请求不算，隐藏思考也从 message_start 量起', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const events: Array<{ type: string; usage?: { models: Record<string, ModelTurnUsage> } }> = []
    const t = new ClaudeTranslator('D:\\work', {
      emit: e => events.push(e as never),
      sessionId: () => {},
      permissionMode: () => {},
      turnEnded: () => {},
      fastState: () => {},
    })
    const stream = (event: Record<string, unknown>, parent?: string) =>
      t.handle({ type: 'stream_event', event, ...(parent ? { parent_tool_use_id: parent } : {}) })
    const start = (id: string, parent?: string) =>
      stream({ type: 'message_start', message: { id, model: 'm', usage: { input_tokens: 1 } } }, parent)
    t.startTurn('t1')
    vi.advanceTimersByTime(3000) // 等第一个请求回来
    start('a')
    vi.advanceTimersByTime(2000) // 隐藏思考：没有内容事件，但在输出
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } })
    vi.advanceTimersByTime(2000)
    stream({ type: 'message_delta', usage: { output_tokens: 400 } })
    stream({ type: 'message_stop' })
    vi.advanceTimersByTime(60_000) // 跑工具
    start('sub', 'tool-1')
    vi.advanceTimersByTime(9000)
    stream({ type: 'message_delta', usage: { output_tokens: 9000 } }, 'tool-1')
    stream({ type: 'message_stop' }, 'tool-1')
    start('b')
    vi.advanceTimersByTime(1000)
    stream({ type: 'message_delta', usage: { output_tokens: 100 } })
    t.handle({
      type: 'result',
      subtype: 'success',
      modelUsage: { m: { inputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 9500 } },
    })
    const done = events.filter(e => e.type === 'turn_completed').at(-1)
    expect(done?.usage?.models.m).toMatchObject({ genMs: 5000, genOutput: 500, firstTokenMs: 5000, output: 9500 })
  })

  it('像素星空：每条助手消息一段，首字从这一轮开始算；中间没消息的时间不算', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const t = new PixelTranslator(() => {}, { cwd: '/proj' })
    t.beginTurn()
    const started = Date.now()
    vi.advanceTimersByTime(1000)
    t.event({ type: 'message_start', message: { role: 'assistant' } })
    vi.advanceTimersByTime(500)
    t.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } })
    vi.advanceTimersByTime(1500)
    t.event({
      type: 'message_end',
      message: { role: 'assistant', model: 'p', content: [], usage: { input: 1, output: 300 } },
    })
    vi.advanceTimersByTime(30_000)
    expect(t.turnUsage(Date.now() - started).models.p).toMatchObject({
      genMs: 2000,
      genOutput: 300,
      firstTokenMs: 1500,
    })
  })
})

describe('平台结算不丢量到的时间', () => {
  it('账单换掉 token，输出时间和首字留着', () => {
    const settled = settleUsage(
      {
        durationMs: 1000,
        models: { m: { ...usage(), genMs: 800, genOutput: 400, firstTokenMs: 120 } },
        settlement: {
          account: 'a',
          startedAt: 0,
          complete: false,
          requests: [{ id: 'r', model: 'm', groupId: 'g' }],
        },
      },
      [
        {
          requestId: 'r',
          model: 'm',
          rateMultiplier: 1,
          groupId: 'g',
          input: 2,
          output: 450,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: 0.1,
          billing: 'balance',
        },
      ],
      true,
    )
    expect(settled.models.m).toMatchObject({ output: 450, costUsd: 0.1, genMs: 800, genOutput: 400, firstTokenMs: 120 })
  })
})

describe('平台结算的模型名不带 [1m]', () => {
  const original = (): Parameters<typeof settleUsage>[0] => ({
    durationMs: 10000,
    models: {
      'claude-opus-5-5[1m]': {
        input: 7,
        output: 500,
        cacheRead: 3,
        cacheWrite: 2,
        costUsd: null,
        genMs: 5000,
        genOutput: 500,
        firstTokenMs: 900,
      },
    },
    settlement: {
      account: 'a',
      requests: [{ id: 'r', model: 'claude-opus-5-5', groupId: 'g' }],
      startedAt: 0,
      complete: false,
    },
  })

  it('等结算时 Token 用引擎报的，量到的时间还在', () => {
    expect(settleUsage(original(), [], false).models['claude-opus-5-5']).toMatchObject({
      input: 7,
      output: 500,
      cacheRead: 3,
      cacheWrite: 2,
      costSource: 'pending',
      genMs: 5000,
      genOutput: 500,
      firstTokenMs: 900,
    })
  })

  it('最后也没结算成：Token 不是 0', () => {
    expect(settleUsage(original(), [], true).models['claude-opus-5-5']).toMatchObject({
      output: 500,
      costSource: 'unavailable',
    })
  })
})

describe('UsageStore 按天合计', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const store = () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-'))
    dirs.push(dir)
    return new UsageStore(dir)
  }
  const now = new Date(2026, 10, 6, 15).getTime()
  const record = (over: Partial<UsageRecord>): UsageRecord => ({
    v: 1,
    id: 's:t:m',
    sessionId: 's',
    turnId: 't',
    startedAt: now - 1000,
    endedAt: now - 500,
    durationMs: 500,
    sessionTitle: '',
    project: null,
    engine: 'claude',
    model: 'm',
    route: 'cli',
    input: 10,
    cacheRead: 0,
    cacheWrite: 0,
    output: 200,
    costUsd: null,
    outcome: 'completed',
    ...over,
  })

  it('保留期够一年热力图', () => {
    expect(USAGE_RETENTION_DAYS).toBeGreaterThan(53 * 7)
  })

  it('一列 7 格从周一开始，今天是最后一格；筛选生效；同一轮多个模型算一轮', () => {
    const s = store()
    s.append([
      record({ id: 'a' }),
      record({ id: 'b', model: 'n', genMs: 1000, genOutput: 200, outcome: 'failed' }),
      record({ id: 'c', turnId: 't2', endedAt: new Date(2026, 3, 1, 12).getTime() }),
    ])
    const days = s.daily({ filter: {}, now })
    expect(new Date(days[0].start).getDay()).toBe(1)
    expect(days[0].start).toBe(heatmapStart(now))
    expect(days.at(-1)).toMatchObject({ records: 2, turns: 1, failed: 1, genMs: 1000 })
    expect(outputSpeed(days.at(-1)!)).toBe(200)
    expect(days.filter(d => d.records > 0)).toHaveLength(2)
    expect(s.daily({ filter: { model: 'n' }, now }).at(-1)).toMatchObject({ records: 1 })
  })

  it('文件没变不重读，追加之后读到新的，清空之后没有', () => {
    const s = store()
    s.append([record({ id: 'a' })])
    const before = s.daily({ filter: {}, now }).at(-1)!
    // 同一个文件再读一次，结果不能叠加
    expect(s.daily({ filter: {}, now }).at(-1)).toEqual(before)
    s.append([record({ id: 'b' })])
    expect(s.daily({ filter: {}, now }).at(-1)).toMatchObject({ records: 2 })
    // 同 id 的修正行：只算最后一条
    s.append([record({ id: 'b', input: 99 })])
    expect(s.daily({ filter: {}, now }).at(-1)).toMatchObject({ records: 2, input: 109 })
    s.clear()
    expect(s.daily({ filter: {}, now }).at(-1)).toMatchObject({ records: 0 })
  })

  it('写坏的行不影响；一年前的文件不读', () => {
    const s = store()
    writeFileSync(join(s.dir, 'usage-2026-11.jsonl'), `{broken\n${JSON.stringify(record({ id: 'a' }))}\n`)
    writeFileSync(
      join(s.dir, 'usage-2024-01.jsonl'),
      `${JSON.stringify(record({ id: 'old', endedAt: new Date(2024, 0, 5).getTime() }))}\n`,
    )
    const days = s.daily({ filter: {}, now })
    const sum = days.reduce((n, d) => n + d.records, emptyTotals().records)
    expect(sum).toBe(1)
  })

  it('旧记录没有时间：合计里不算，速度是 null，不是偏低的数', () => {
    const s = store()
    s.append([record({ id: 'old', output: 5000 }), record({ id: 'new', output: 300, genMs: 3000, genOutput: 300 })])
    const today = s.daily({ filter: {}, now }).at(-1)!
    expect(outputSpeed(today)).toBe(100)
    const onlyOld = store()
    onlyOld.append([record({ id: 'old', output: 5000 })])
    expect(outputSpeed(onlyOld.daily({ filter: {}, now }).at(-1)!)).toBeNull()
  })
})
