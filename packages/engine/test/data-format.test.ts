// 磁盘格式兼容：test/fixtures/data-v1 是按当前格式手写的最小数据目录，改格式时这里先报警。
// 夹具只读：每个用例先复制到临时目录再用（EngineHost 构造时会整理用量文件）。
import { cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EngineHost } from '../src/host'
import { eachLine, Store } from '../src/store'
import { UsageStore } from '../src/usage'
import { makeTmp, removeTmp } from './helpers/tmp'

const FIXTURE = fileURLToPath(new URL('./fixtures/data-v1', import.meta.url))
const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const NOW = 1791201600000 + 60_000 // 夹具里最后一条用量记录之后一分钟

let dir: string
let hosts: EngineHost[]
beforeEach(() => {
  dir = makeTmp('data-format')
  cpSync(FIXTURE, join(dir, 'data'), { recursive: true })
  hosts = []
})
afterEach(async () => {
  await Promise.all(hosts.map(h => h.shutdown()))
  removeTmp(dir)
})
const data = () => join(dir, 'data')
const makeHost = () => {
  const h = new EngineHost({ dataDir: data(), emit() {}, adapters: {} })
  hosts.push(h)
  return h
}

describe('Store 读取 data-v1', () => {
  it('项目与引擎设置', () => {
    const store = new Store(data())
    expect(store.loadProjects()).toEqual([
      { id: 'proj-fixture-1', name: '夹具项目', path: '/fixture/workspace', addedAt: 1791100000000 },
    ])
    expect(store.loadSettings()).toMatchObject({
      maxRetries: 3,
      defaults: { engine: 'claude', model: 'fixture-model', effort: 'medium', permissionMode: 'plan' },
      paths: { claude: '/fixture/bin/claude' },
      env: { claude: { FIXTURE_FLAG: '1' } },
      compactModels: { claude: 'fixture-small' },
      options: { claude: { autoCompactPct: 80 } },
    })
  })

  it('会话记录：新字段原样读出，旧记录缺失的字段补默认值', () => {
    const records = new Store(data()).loadRecords().sort((a, b) => a.id.localeCompare(b.id))
    expect(records.map(r => r.id)).toEqual([S1, S2])
    expect(records[0]).toMatchObject({
      title: '夹具会话',
      engineSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ultracode: true,
      titleEdited: true,
      bottomedAt: 1791150000000,
      archivedAt: null,
      lastOutcome: 'completed',
    })
    expect(records[1]).toMatchObject({
      title: '旧版记录',
      model: null,
      effort: null,
      ultracode: false,
      fast: false,
      thinkingSummaries: true,
      titleEdited: false,
      bottomedAt: null,
      archivedAt: null,
    })
  })

  it('对话条目：同 id 保留首次位置与最后内容，写坏的行跳过', () => {
    const store = new Store(data())
    const items = store.loadItems(S1)
    expect(items.map(i => i.id)).toEqual(['u1', 'a1', 'stats-t1', 'u2', 'a2'])
    expect(items.find(i => i.id === 'a2')).toMatchObject({ kind: 'assistant', text: '第二句的回复' })
    expect(items.find(i => i.id === 'stats-t1')).toMatchObject({
      kind: 'turn_stats',
      usage: { durationMs: 1200, models: { 'fixture-model': { input: 10, output: 5 } } },
    })
    expect(store.loadItems(S2)).toEqual([])
  })

  it('按行读：一块一块读，行和中文跨块也完整；空行、结尾没换行、比一块还长的行都照常', () => {
    const file = join(data(), 'lines.txt')
    const lines = ['第一行', '', 'abc对话条目xyz', '很长'.repeat(20), '最后一行没换行']
    writeFileSync(file, lines.join('\n'))
    for (const chunk of [1, 2, 3, 5, 7, 64]) {
      const got: string[] = []
      eachLine(file, l => got.push(l), chunk)
      expect(got).toEqual(lines)
    }
  })

  it('对话条目：开始时写的位置为准；没等到完成的（包括后台子智能体的）读出时标成已中断', () => {
    const store = new Store(data())
    const S3 = '33333333-3333-4333-8333-333333333333'
    const tool = (id: string, status: 'running' | 'completed', background?: boolean) =>
      ({
        kind: 'tool',
        id,
        tool: 'read',
        name: 'Read',
        title: id,
        output: '',
        status,
        ...(background ? { background } : {}),
      }) as const
    store.appendItem(S3, tool('task', 'running'))
    store.appendItem(S3, tool('sub', 'running', true))
    store.appendItem(S3, tool('quick', 'running'))
    store.appendItem(S3, tool('quick', 'completed'))
    store.appendItem(S3, tool('task', 'completed'))
    const items = store.loadItems(S3)
    expect(items.map(i => i.id)).toEqual(['task', 'sub', 'quick'])
    expect(items.map(i => (i.kind === 'tool' ? i.status : ''))).toEqual(['completed', 'interrupted', 'completed'])
  })

  it('对话条目：以前存下的 Codex 配置类警告（警告或灰色提示）读出时去掉；别的警告不变', () => {
    const store = new Store(data())
    const S4 = '44444444-4444-4444-8444-444444444444'
    const notice = (id: string, text: string) => ({ kind: 'notice', id, level: 'warn', text }) as const
    const ignoring = 'Codex is ignoring 1 unrecognized configuration setting. Check for typos.'
    store.appendItem(S4, notice('a', ignoring))
    store.appendItem(S4, notice('b', 'Under-development features enabled: x.'))
    store.appendItem(S4, notice('c', 'Model metadata not found.'))
    store.appendItem(S4, { ...notice('d', ignoring), level: 'info' })
    const items = store.loadItems(S4)
    expect(items.map(i => (i.kind === 'notice' ? [i.id, i.level] : []))).toEqual([['c', 'warn']])
  })

  it('队列：重启后一律暂停；已开始交付的项变成待核对，不自动重发', () => {
    const store = new Store(data()),
      record = store.loadRecords().find(r => r.id === S1)!
    const queue = store.loadQueue(record)
    expect(queue.paused).toBe(true)
    expect(queue.receipts).toEqual([{ queueId: 'q-old', status: 'accepted' }])
    expect(queue.items.map(i => [i.id, i.status, i.mode])).toEqual([
      ['q-running', 'uncertain', 'normal'],
      ['q-queued', 'queued', 'normal'],
      ['q-failed', 'failed', 'guidance'],
    ])
    expect(queue.items[0].error).toBe('上次退出前已开始交付，请核对后再重试')
    expect(queue.items[2]).toMatchObject({ error: 'boom', settings: { model: null, effort: null, platform: null } })
    expect(store.loadQueue(store.loadRecords().find(r => r.id === S2)!)).toEqual({
      items: [],
      paused: false,
      receipts: [],
    })
  })

  it('不打开会话时的队列概况：按文件内容计数，已开始交付的项此时还算排队', () => {
    const store = new Store(data())
    expect(store.peekQueue(S1)).toEqual({ queued: 2, failed: 1, paused: true })
    expect(store.peekQueue(S2)).toBeNull()
  })
})

describe('UsageStore 读取 data-v1', () => {
  it('读出全部记录；平台线路没有费用来源的旧记录标成不可用', () => {
    const rows = new UsageStore(data()).load(0)
    expect(rows.map(r => r.id).sort()).toEqual(['t1', 't2', 't3'].map(t => `${S1}:${t}:fixture-model`))
    expect(rows.find(r => r.turnId === 't1')).toMatchObject({
      route: 'cli',
      costUsd: 0.01,
      costSource: 'estimate',
      input: 10,
      outcome: 'completed',
    })
    expect(rows.find(r => r.turnId === 't3')).toMatchObject({
      route: 'pixelsky',
      costUsd: null,
      costSource: 'unavailable',
      outcome: 'failed',
    })
  })

  it('汇总与分页', () => {
    const usage = new UsageStore(data())
    const sum = usage.summary({ range: '7d', filter: {}, now: NOW })
    expect(sum.totals).toMatchObject({
      input: 31,
      cacheRead: 272,
      cacheWrite: 3,
      output: 19,
      records: 3,
      turns: 3,
      requests: 4,
    })
    expect(sum.groups.route.map(g => g.key).sort()).toEqual(['cli', 'pixelsky'])
    const page = usage.list({ range: '7d', filter: {}, now: NOW, offset: 0, limit: 2 })
    expect(page).toMatchObject({ total: 3, offset: 0 })
    expect(page.records).toHaveLength(2)
    expect(usage.csv({ range: '7d', filter: {}, now: NOW }).split(/\r?\n/).filter(Boolean)).toHaveLength(4)
  })
})

describe('EngineHost 打开 data-v1', () => {
  it('项目与会话列表：按更新时间倒序，未打开的会话带队列概况', () => {
    const host = makeHost()
    expect(host.projects().map(p => p.name)).toEqual(['夹具项目'])
    expect(host.defaults()).toMatchObject({ model: 'fixture-model', permissionMode: 'plan' })
    expect(host.sessions().map(s => [s.record.id, s.state])).toEqual([
      [S1, 'idle'],
      [S2, 'idle'],
    ])
    expect(host.sessions()[0].queue).toEqual({ queued: 2, failed: 1, paused: true })
    expect(host.sessions()[1].queue).toBeUndefined()
  })

  it('打开会话：条目、暂停的队列与回执', () => {
    const host = makeHost(),
      snap = host.open(S1)
    expect(snap.items.map(i => i.id)).toEqual(['u1', 'a1', 'stats-t1', 'u2', 'a2'])
    expect(snap.queuePaused).toBe(true)
    expect(snap.queue.map(q => [q.id, q.status])).toEqual([
      ['q-running', 'uncertain'],
      ['q-queued', 'queued'],
      ['q-failed', 'failed'],
    ])
    expect(host.sessions()[0].queue).toEqual({ queued: 1, failed: 2, paused: true })
    expect(host.open(S2).items).toEqual([])
  })

  it('撤回夹具里的排队项：返回原文，不需要启动引擎', () => {
    const host = makeHost()
    expect(host.cancelQueued(S1, 'q-queued')).toBe('排队中')
    expect(host.open(S1).queue.map(q => q.id)).toEqual(['q-running', 'q-failed'])
  })
})
