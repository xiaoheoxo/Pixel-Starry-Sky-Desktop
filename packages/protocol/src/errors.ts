// 宿主错误代码（docs/ui/files-search-terminal-pins.md §1）：主进程 / 引擎抛 codedError(code, params)，
// IPC 只传 message，所以代码和参数编码进 message（前缀 + JSON），界面按 errors.<code> 查词典翻译。
// 新代码用它；旧的中文句子错误保留，界面的反查翻译作为兜底。

export const ERROR_PREFIX = 'PIXELSKY_ERR:'

export type ErrorParams = Record<string, string | number>

export interface CodedErrorInfo {
  code: string
  params: ErrorParams
}

/** 带代码的错误；code 用点分小写（例如 files.exists），params 只放字符串和数字 */
export function codedError(code: string, params?: ErrorParams): Error {
  return new Error(ERROR_PREFIX + JSON.stringify(params ? { code, params } : { code }))
}

// 片段结束处：行尾、空白或标点
const FRAGMENT_END = /^$|^[\s,.;:，。；：）)]/

function decode(json: string): CodedErrorInfo | null {
  try {
    const value = JSON.parse(json) as { code?: unknown; params?: unknown }
    if (typeof value.code !== 'string' || !value.code) return null
    const params: ErrorParams = {}
    if (value.params && typeof value.params === 'object' && !Array.isArray(value.params))
      for (const [key, v] of Object.entries(value.params))
        if (typeof v === 'string' || typeof v === 'number') params[key] = v
    return { code: value.code, params }
  } catch {
    return null
  }
}

/** 整条消息就是一个带代码的错误时返回代码和参数，否则 null */
export function parseCodedError(message: string | null | undefined): CodedErrorInfo | null {
  const value = (message ?? '').trim()
  if (!value.startsWith(ERROR_PREFIX)) return null
  return decode(value.slice(ERROR_PREFIX.length))
}

/** 把消息里所有带代码的错误片段换成 render 的结果（例如外层又拼了「启动失败：」前缀） */
export function replaceCodedErrors(message: string, render: (info: CodedErrorInfo) => string): string {
  if (!message.includes(ERROR_PREFIX)) return message
  let result = '',
    from = 0
  for (let at = message.indexOf(ERROR_PREFIX); at >= 0; at = message.indexOf(ERROR_PREFIX, at + 1)) {
    if (at < from) continue
    const start = at + ERROR_PREFIX.length
    if (message[start] !== '{') continue
    const lineEnd = message.indexOf('\n', start)
    const stop = lineEnd < 0 ? message.length : lineEnd
    // 参数里可能有「}」紧跟空白或标点（例如 src/{id}.ts），从近到远逐个试候选结束位置，第一个能解析的就是
    for (let close = message.indexOf('}', start); close >= 0 && close < stop; close = message.indexOf('}', close + 1)) {
      if (!FRAGMENT_END.test(message.slice(close + 1, close + 2))) continue
      const info = decode(message.slice(start, close + 1))
      if (!info) continue
      result += message.slice(from, at) + render(info)
      from = close + 1
      break
    }
  }
  return result + message.slice(from)
}
