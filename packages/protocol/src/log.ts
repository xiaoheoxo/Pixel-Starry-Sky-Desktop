// 日志条目和日志行格式（docs/ui/logging.md §4.1）：纯函数，主进程写、读文件和测试共用。
// 一行一条：「时间 级别 模块 消息 {字段}」，例如
//   2026-10-11T02:01:57.123+08:00 WARN gateway 上游连接断开 {"requestId":"pixelsky-…","elapsedMs":61234}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  /** 毫秒时间戳 */
  ts: number
  level: LogLevel
  /** 模块，例如 gateway、engine.claude、session */
  scope: string
  message: string
  fields?: Record<string, unknown>
}

/** 读日志的条件（log:read） */
export interface LogQuery {
  /** 最低级别；不填为 debug（全部） */
  minLevel?: LogLevel
  scope?: string
  /** 关键字：匹配消息和字段（不分大小写） */
  text?: string
  /** 只看这个会话的条目（字段 sessionId） */
  sessionId?: string
  since?: number
  until?: number
  /** 条数上限，最多 1000；取符合条件的最新几条 */
  limit?: number
}

export interface LogSettings {
  /** 日志文件夹 */
  dir: string
  /** 详细日志到期时间；null 为关闭 */
  verboseUntil: number | null
}

export const LOG_LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const LABEL: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' }
const FROM_LABEL: Record<string, LogLevel> = { DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' }

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** 本地时间，带时区偏移：2026-10-11T02:01:57.123+08:00 */
export function logTime(ts: number): string {
  const d = new Date(ts)
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 一条日志 → 一行（不含换行符）。模块名里的空白换成 _，消息里的换行转成 \n */
export function formatLogLine(entry: LogEntry): string {
  const scope = entry.scope.replace(/\s+/g, '_') || '-'
  const message = entry.message.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/\r/g, '\\r')
  // 没有字段但消息以 } 结尾（例如「收到配置 {"sessionId":"x"}」）时补一个空的 {}，读回时不把消息结尾当字段
  const fields =
    entry.fields && Object.keys(entry.fields).length
      ? ` ${JSON.stringify(entry.fields)}`
      : message.endsWith('}')
        ? ' {}'
        : ''
  return `${logTime(entry.ts)} ${LABEL[entry.level]} ${scope} ${message}${fields}`
}

const unescape = (text: string): string =>
  text.replace(/\\(\\|n|r)/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : '\\'))

/** 一行 → 一条日志；空行返回 null。格式不对的行整行当消息，级别 info */
export function parseLogLine(line: string): LogEntry | null {
  const text = line.replace(/\r$/, '')
  if (!text.trim()) return null
  const match = /^(\S+) (DEBUG|INFO|WARN|ERROR) (\S+) ?(.*)$/.exec(text)
  const ts = match ? Date.parse(match[1]) : NaN
  if (!match || Number.isNaN(ts)) return { ts: 0, level: 'info', scope: '-', message: text }
  let message = match[4]
  let fields: Record<string, unknown> | undefined
  // 字段是行尾的 JSON 对象：从每个「 {」试起，第一个能完整解析到行尾的就是
  for (let at = message.indexOf(' {'); at >= 0; at = message.indexOf(' {', at + 1)) {
    try {
      const value: unknown = JSON.parse(message.slice(at + 1))
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        fields = value as Record<string, unknown>
        message = message.slice(0, at)
        break
      }
    } catch {
      // 不是字段，继续往后找
    }
  }
  if (!fields && message.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(message)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        fields = value as Record<string, unknown>
        message = ''
      }
    } catch {
      // 消息本身以 { 开头
    }
  }
  // 空的 {} 是写入时补的「没有字段」标记
  if (fields && !Object.keys(fields).length) fields = undefined
  return { ts, level: FROM_LABEL[match[2]], scope: match[3], message: unescape(message), ...(fields ? { fields } : {}) }
}

/** 条目是否符合条件（不管条数上限） */
export function matchesLogQuery(entry: LogEntry, query: LogQuery): boolean {
  if (query.minLevel && LOG_LEVEL_RANK[entry.level] < LOG_LEVEL_RANK[query.minLevel]) return false
  if (query.scope && entry.scope !== query.scope) return false
  if (query.since !== undefined && entry.ts < query.since) return false
  if (query.until !== undefined && entry.ts > query.until) return false
  if (query.sessionId && entry.fields?.sessionId !== query.sessionId) return false
  if (query.text) {
    const needle = query.text.toLowerCase()
    const hay = `${entry.scope} ${entry.message} ${entry.fields ? JSON.stringify(entry.fields) : ''}`.toLowerCase()
    if (!hay.includes(needle)) return false
  }
  return true
}
