// 日志行格式（docs/ui/logging.md §4.1）
import { describe, expect, it } from 'vitest'
import { formatLogLine, logTime, matchesLogQuery, parseLogLine, type LogEntry } from '../src/log'

const ts = Date.parse('2026-10-11T02:01:57.123Z')

describe('日志行', () => {
  it('时间带本地时区偏移，解析回来是同一时刻', () => {
    const time = logTime(ts)
    expect(time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.123[+-]\d\d:\d\d$/)
    expect(Date.parse(time)).toBe(ts)
  })

  it('写出再读回：消息里的换行、反斜杠、空格和花括号都能还原；字段在行尾', () => {
    const entry: LogEntry = {
      ts,
      level: 'warn',
      scope: 'gateway',
      message: '上游连接断开 {not json} C:\\temp\nsecond',
      fields: { requestId: 'pixelsky-1', elapsedMs: 61234, nested: { a: [1, 2] } },
    }
    const line = formatLogLine(entry)
    expect(line).not.toContain('\n')
    expect(line).toMatch(/ WARN gateway 上游连接断开 \{not json\} C:\\\\temp\\nsecond \{"requestId"/)
    expect(parseLogLine(line)).toEqual(entry)
  })

  it('没有字段时不写 {}；模块名里的空白换成 _', () => {
    const line = formatLogLine({ ts, level: 'info', scope: 'a b', message: 'hi', fields: {} })
    expect(line.endsWith(' INFO a_b hi')).toBe(true)
    expect(parseLogLine(line)).toEqual({ ts, level: 'info', scope: 'a_b', message: 'hi' })
  })

  it('没有字段、消息结尾是 JSON 时读回不截断、不多出字段', () => {
    for (const message of ['收到配置 {"sessionId":"x"}', '{"a":1}', 'config {}', '{}', 'a } b {c}']) {
      const entry: LogEntry = { ts, level: 'info', scope: 'engine', message }
      expect(parseLogLine(formatLogLine(entry))).toEqual(entry)
      // 有字段时照旧
      const withFields: LogEntry = { ...entry, fields: { sessionId: 's1' } }
      expect(parseLogLine(formatLogLine(withFields))).toEqual(withFields)
    }
  })

  it('旧格式的行照旧解析：行尾 JSON 是字段', () => {
    expect(parseLogLine(`${logTime(ts)} INFO engine 收到 {"sessionId":"x"}`)).toEqual({
      ts,
      level: 'info',
      scope: 'engine',
      message: '收到',
      fields: { sessionId: 'x' },
    })
  })

  it('空行为 null；格式不对的行整行当消息', () => {
    expect(parseLogLine('  ')).toBeNull()
    expect(parseLogLine('garbage line')).toEqual({ ts: 0, level: 'info', scope: '-', message: 'garbage line' })
  })
})

describe('筛选', () => {
  const entry: LogEntry = { ts, level: 'warn', scope: 'session', message: '请求重试', fields: { sessionId: 's1' } }
  it('级别、模块、会话、时间、关键字', () => {
    expect(matchesLogQuery(entry, { minLevel: 'warn' })).toBe(true)
    expect(matchesLogQuery(entry, { minLevel: 'error' })).toBe(false)
    expect(matchesLogQuery(entry, { scope: 'gateway' })).toBe(false)
    expect(matchesLogQuery(entry, { sessionId: 's1' })).toBe(true)
    expect(matchesLogQuery(entry, { sessionId: 's2' })).toBe(false)
    expect(matchesLogQuery(entry, { since: ts + 1 })).toBe(false)
    expect(matchesLogQuery(entry, { until: ts })).toBe(true)
    expect(matchesLogQuery(entry, { text: 'S1' })).toBe(true)
    expect(matchesLogQuery(entry, { text: '重试' })).toBe(true)
    expect(matchesLogQuery(entry, { text: 'nope' })).toBe(false)
  })
})
