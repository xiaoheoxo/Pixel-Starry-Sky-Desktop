// 日志文件和日志服务（docs/ui/logging.md §4.2–§4.4）
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatLogLine,
  logTime,
  matchesLogQuery,
  parseLogLine,
  type LogEntry,
  type LogQuery,
  type SessionRecord,
} from '@pixelsky/protocol'
import { LogFiles, linesFromEnd, roughMatcher } from './files'
import { LogService, VERBOSE_MS } from './service'
import { logHostEvent } from './host-events'
import { setLogSink } from '@pixelsky/engine'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pixelsky-log-'))
})
afterEach(() => {
  setLogSink(null)
  rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400_000
const t0 = Date.parse('2026-10-11T12:00:00')
const day = (ts: number) => logTime(ts).slice(0, 10)

describe('日志文件', () => {
  it('按天写文件，超过上限换编号，接着已有的文件写', async () => {
    const files = new LogFiles({ dir, maxFileBytes: 30, now: () => t0 })
    files.append(t0, 'a'.repeat(20))
    files.append(t0, 'b'.repeat(20))
    files.append(t0 + DAY, 'next day')
    await files.flush()
    expect(readdirSync(dir).sort()).toEqual(
      [`main-${day(t0)}.1.log`, `main-${day(t0)}.log`, `main-${day(t0 + DAY)}.log`].sort(),
    )
    expect(readFileSync(join(dir, `main-${day(t0)}.1.log`), 'utf8')).toBe('b'.repeat(20) + '\n')
    // 重启后接着最后一个编号写
    const again = new LogFiles({ dir, maxFileBytes: 30, now: () => t0 })
    again.append(t0, 'c')
    await again.flush()
    expect(readFileSync(join(dir, `main-${day(t0)}.1.log`), 'utf8')).toBe('b'.repeat(20) + '\nc\n')
  })

  it('启动时删掉 7 天前的；总量超过上限从最旧的删起；不认识的文件不动', () => {
    const old = join(dir, `main-${day(t0 - 8 * DAY)}.log`)
    const mid = join(dir, `main-${day(t0 - 3 * DAY)}.log`)
    const recent = join(dir, `main-${day(t0 - DAY)}.log`)
    writeFileSync(old, 'x')
    writeFileSync(mid, 'y'.repeat(60))
    writeFileSync(recent, 'z'.repeat(60))
    writeFileSync(join(dir, 'settings.json'), '{}')
    utimesSync(old, new Date(t0), new Date(t0))
    new LogFiles({ dir, maxTotalBytes: 100, now: () => t0 })
    expect(readdirSync(dir).sort()).toEqual(['settings.json', `main-${day(t0 - DAY)}.log`].sort())
  })

  it('读：取符合条件的最新几条，跨文件，按时间先后', async () => {
    const svc = new LogService({ dir, now: () => t0 })
    const files = svc.files
    files.append(t0 - DAY, `${logTime(t0 - DAY)} WARN gateway 昨天 {"sessionId":"s1"}`)
    files.append(t0, `${logTime(t0)} INFO app 今天`)
    files.append(t0 + 1, `${logTime(t0 + 1)} ERROR session 出错 {"sessionId":"s1"}`)
    const all = await svc.read({})
    expect(all.map(e => e.message)).toEqual(['昨天', '今天', '出错'])
    expect((await svc.read({ limit: 2 })).map(e => e.message)).toEqual(['今天', '出错'])
    expect((await svc.read({ minLevel: 'warn', sessionId: 's1' })).map(e => e.message)).toEqual(['昨天', '出错'])
    expect((await svc.read({ since: t0 })).map(e => e.message)).toEqual(['今天', '出错'])
  })
})

describe('读日志不卡主进程（docs/ui/performance.md §4）', () => {
  it('倒着按块读：块边界切在多字节字符中间、半行跨块都能拼回来，顺序不乱', async () => {
    const path = join(dir, 'x.log')
    const lines = Array.from({ length: 200 }, (_, i) => `第${i}行 ${'像素星空'.repeat(i % 7)}`)
    writeFileSync(path, lines.join('\n') + '\n')
    for (const chunk of [7, 13, 64, 1 << 20]) {
      const got: string[] = []
      for await (const block of linesFromEnd(path, chunk)) got.unshift(...block)
      expect(got.filter(Boolean)).toEqual(lines)
    }
  })

  it('粗筛只会多放行、不会漏：和 matchesLogQuery 对一批行逐条比', () => {
    const entries: LogEntry[] = [
      { ts: t0, level: 'info', scope: 'app', message: '应用启动' },
      { ts: t0, level: 'warn', scope: 'gateway', message: 'Retry 请求', fields: { sessionId: 's1', ms: 3 } },
      { ts: t0, level: 'error', scope: 'engine.claude', message: '多行\n第二行 a\b', fields: { sessionId: 's2' } },
      { ts: t0, level: 'debug', scope: 'session', message: '细节 {不是字段' },
    ]
    const lines = [
      ...entries.map(formatLogLine),
      '格式不对的一行 WARN app',
      '2026-13-45T99:99:99.000+08:00 DEBUG app 日期不对',
      '',
    ]
    const queries: LogQuery[] = [
      {},
      { minLevel: 'info' },
      { minLevel: 'warn' },
      { minLevel: 'error' },
      { scope: 'gateway' },
      { scope: '-' },
      { text: 'retry' },
      { text: 'GATEWAY 请求' },
      { text: '第二行' },
      { text: 'a\b' },
      { text: '"ms":3' },
      { sessionId: 's1' },
      { minLevel: 'warn', scope: 'engine.claude', text: '多行' },
    ]
    for (const q of queries) {
      const rough = roughMatcher(q)
      for (const line of lines) {
        const entry = parseLogLine(line)
        if (entry && matchesLogQuery(entry, q)) expect(rough(line), `${JSON.stringify(q)} ${line}`).toBe(true)
      }
    }
    expect(roughMatcher({ minLevel: 'error' })(lines[0]!)).toBe(false)
    expect(roughMatcher({ text: '找不到' })(lines[1]!)).toBe(false)
  })

  it('读大文件：不筛选时只取最新的；筛选、搜不到时把全部文件扫完', async () => {
    const svc = new LogService({ dir, now: () => t0 })
    const big = Array.from({ length: 30_000 }, (_, i) => `${logTime(t0 + i)} INFO app 第${i}条 ${'x'.repeat(40)}`)
    big[100] = `${logTime(t0 + 100)} ERROR gateway 很早的错误`
    writeFileSync(join(dir, `main-${day(t0)}.log`), big.join('\n') + '\n')
    const latest = await svc.read({ limit: 3 })
    expect(latest.map(e => e.message.split(' ')[0])).toEqual(['第29997条', '第29998条', '第29999条'])
    expect((await svc.read({ minLevel: 'error' })).map(e => e.message)).toEqual(['很早的错误'])
    expect(await svc.read({ text: '找不到的字' })).toEqual([])
  })
})

describe('日志服务', () => {
  it('写入前脱敏；默认不记 debug，详细日志打开 24 小时，到期自动关闭，重启后保留', async () => {
    let now = t0
    const svc = new LogService({ dir, now: () => now })
    const live: LogEntry[] = []
    svc.subscribe(e => live.push(e))
    svc.write('info', 'account', '刷新失败 Bearer abc.def', { refreshToken: 'r1', status: 401 })
    svc.write('debug', 'gateway', '不记')
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({
      message: '刷新失败 [redacted]',
      fields: { refreshToken: '***', status: 401 },
    })

    expect(svc.setVerbose(true).verboseUntil).toBe(t0 + VERBOSE_MS)
    svc.write('debug', 'gateway', '记下')
    expect(live.at(-1)?.message).toBe('记下')
    expect(new LogService({ dir, now: () => now }).settings().verboseUntil).toBe(t0 + VERBOSE_MS)

    now = t0 + VERBOSE_MS + 1
    expect(svc.enabled('debug')).toBe(false)
    expect(svc.settings().verboseUntil).toBeNull()

    const text = (await svc.read({})).map(e => e.message)
    expect(text).toEqual(['刷新失败 [redacted]', '记下'])
  })

  it('会话事件：重试和失败记 warn，错误提示记 error，正常结束记 info，信息提示不记', () => {
    const svc = new LogService({ dir, now: () => t0 })
    setLogSink(svc)
    const got: LogEntry[] = []
    svc.subscribe(e => got.push(e))
    const session = (event: unknown) =>
      logHostEvent({ kind: 'session', sessionId: 's1', seq: 1, event } as Parameters<typeof logHostEvent>[0])
    session({
      type: 'request_retry',
      retry: { turnId: 't1', attempt: 3, maxRetries: 10, retryAt: null, reason: 'Connection dropped (ECONNRESET)' },
    })
    session({ type: 'request_retry', retry: null })
    session({ type: 'item_completed', item: { kind: 'notice', id: 'n', level: 'error', text: 'API Error: 499' } })
    session({ type: 'item_completed', item: { kind: 'notice', id: 'i', level: 'info', text: '压缩' } })
    session({ type: 'turn_completed', turnId: 't1', outcome: 'failed', error: 'API Error: 499' })
    session({
      type: 'turn_completed',
      turnId: 't2',
      outcome: 'completed',
      error: null,
      usage: { durationMs: 5, models: {} },
    })
    expect(got.map(e => [e.level, e.message])).toEqual([
      ['warn', '请求重试'],
      ['error', '错误提示'],
      ['warn', '一轮失败'],
      ['info', '一轮结束'],
    ])
    expect(got[0].fields).toMatchObject({
      sessionId: 's1',
      turnId: 't1',
      attempt: 3,
      reason: 'Connection dropped (ECONNRESET)',
    })
    expect(got[3].fields).toMatchObject({ outcome: 'completed', durationMs: 5 })
  })

  it('一轮结束写上额度来源和这一轮用到的模型', () => {
    const svc = new LogService({ dir, now: () => t0 })
    setLogSink(svc)
    const got: LogEntry[] = []
    svc.subscribe(e => got.push(e))
    const record = { platform: { groupId: '71', account: 'a@b.c' }, provider: null } as unknown as SessionRecord
    const done = (sessionId: string) =>
      logHostEvent(
        {
          kind: 'session',
          sessionId,
          seq: 1,
          event: {
            type: 'turn_completed',
            turnId: 't',
            outcome: 'completed',
            error: null,
            usage: { durationMs: 1, models: { 'claude-fable-5-1': {} } },
          },
        } as unknown as Parameters<typeof logHostEvent>[0],
        id => (id === 's1' ? record : null),
      )
    done('s1')
    done('gone')
    expect(got[0].fields).toMatchObject({ source: 'platform:71', models: ['claude-fable-5-1'] })
    expect(got[1].fields).not.toHaveProperty('source')
  })
})
