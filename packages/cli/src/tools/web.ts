// 联网工具 web_fetch / web_search：Pi 自带工具里没有网络能力，这里补上。
// 代理：不用自己处理。Pi 的 main() 启动时会调用 configureHttpDispatcher()，装上 undici 的
// EnvHttpProxyAgent 并把全局 fetch 换成同一份 undici 实现，读 HTTP(S)_PROXY / NO_PROXY
// （还会应用 Pi 设置里的 httpProxy），所以这里只要在调用时取 globalThis.fetch 就自动走代理。
// 所有网络 I/O 走可注入的 fetch，测试用假 fetch；只用可擦除的 TS 语法。
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { assertPublicHost, defaultLookup, type LookupFn } from './ip-guard.ts'

export const WEB_FETCH_TOOL_NAME = 'web_fetch'
export const WEB_SEARCH_TOOL_NAME = 'web_search'

const MAX_REDIRECTS = 5
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_OUTPUT_BYTES = 50 * 1024
const MAX_OUTPUT_LINES = 2000
const FETCH_TIMEOUT_MS = 30_000
const SEARCH_TIMEOUT_MS = 20_000
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const USER_AGENT = 'Mozilla/5.0 (compatible; PixelSkyCLI/0.1; +https://github.com/)'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>
export type Env = Record<string, string | undefined>

export interface WebToolsOptions {
  fetch?: FetchFn
  /** 重定向目标的 DNS 解析（测试注入）；默认 dns.lookup */
  lookup?: LookupFn
  env?: Env
  fetchTimeoutMs?: number
  searchTimeoutMs?: number
  maxBodyBytes?: number
}

export interface WebFetchDetails {
  url: string
  finalUrl: string
  status: number
  contentType: string
  bytes: number
  truncated: boolean
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export type SearchBackend = 'searxng' | 'tavily' | 'brave' | 'duckduckgo'

export interface WebSearchDetails {
  backend: SearchBackend
  query: string
  results: SearchResult[]
}

// ───────────────────────── 通用小工具 ─────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  deg: '°',
  plusmn: '±',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  hearts: '♥',
  sect: '§',
}

/** 解码 HTML 实体（命名常用项 + 十进制/十六进制数字实体），未知的原样保留。 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�'
      return String.fromCodePoint(cp)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m
  })
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase()
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return attrs
}

/** 去掉标签、解码实体、折叠空白（用于搜索结果里的标题和摘要）。 */
export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 按行数和字节数截断（从头保留），在字符边界切开；返回是否发生截断。 */
export function truncateText(
  text: string,
  maxBytes = MAX_OUTPUT_BYTES,
  maxLines = MAX_OUTPUT_LINES,
): { text: string; truncated: boolean; reason?: string } {
  let out = text
  let reason: string | undefined
  const lines = out.split('\n')
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join('\n')
    reason = `${maxLines} lines`
  }
  const buf = Buffer.from(out, 'utf8')
  if (buf.length > maxBytes) {
    let end = maxBytes
    // 回退到 UTF-8 字符起始处，避免切出半个字符
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
    out = buf.subarray(0, end).toString('utf8')
    reason = formatSize(maxBytes)
  }
  if (reason === undefined) return { text, truncated: false }
  return {
    text: `${out}\n\n[truncated: output limited to ${reason}; original was ${lines.length} lines / ${formatSize(Buffer.byteLength(text))}]`,
    truncated: true,
    reason,
  }
}

/** 校验 URL：只允许 http/https，不允许内嵌账号密码。 */
export function parseHttpUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${u.protocol}" (only http and https are allowed)`)
  }
  if (u.username || u.password) throw new Error('URLs with embedded credentials are not allowed')
  return u
}

/** 把用户中止信号和超时合成一个信号；timeout 为 undefined 表示没超时。 */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(ms)
  return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, timeout }
}

/** dns.lookup 不认中止信号：和超时 / 取消赛跑，解析挂住时照样按超时结束，不拖住整个工具 */
function untilAborted<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function describeNetworkError(
  err: unknown,
  what: string,
  userSignal: AbortSignal | undefined,
  timeout: AbortSignal,
  ms: number,
): Error {
  if (userSignal?.aborted) return new Error(`${what} aborted`)
  if (timeout.aborted) return new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause
    const detail = cause?.code ?? cause?.message ?? err.message
    return new Error(`${what} failed: ${detail}`)
  }
  return new Error(`${what} failed: ${String(err)}`)
}

async function readCapped(res: Response, max: number): Promise<{ bytes: Buffer; capped: boolean }> {
  if (!res.body) return { bytes: Buffer.alloc(0), capped: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let capped = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (total + value.length > max) {
      chunks.push(value.subarray(0, max - total))
      capped = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    total += value.length
  }
  return { bytes: Buffer.concat(chunks), capped }
}

// ───────────────────────── 内容类型与解码 ─────────────────────────

export interface ParsedContentType {
  mime: string
  charset?: string
}

export function parseContentType(header: string | null | undefined): ParsedContentType {
  const raw = (header ?? '').trim()
  const [mimePart, ...params] = raw.split(';')
  const out: ParsedContentType = { mime: mimePart.trim().toLowerCase() }
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(p)
    if (m) out.charset = m[1].toLowerCase()
  }
  return out
}

export type ContentKind = 'html' | 'json' | 'text' | 'binary' | 'unknown'

export function classifyMime(mime: string): ContentKind {
  if (!mime) return 'unknown'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime === 'application/json' || mime === 'text/json' || mime.endsWith('+json')) return 'json'
  if (mime.startsWith('text/')) return 'text'
  if (
    mime.endsWith('+xml') ||
    /^application\/(xml|javascript|x-javascript|ecmascript|yaml|x-yaml|toml|x-sh|x-www-form-urlencoded|rtf)$/.test(mime)
  ) {
    return 'text'
  }
  return 'binary'
}

/** 解码字节：优先用声明的 charset，HTML 再看 <meta>，未知或不支持就退回 utf-8。 */
export function decodeBody(bytes: Uint8Array, charset: string | undefined, isHtml: boolean): string {
  let label = charset
  if (!label && isHtml) {
    const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)
    if (m) label = m[1].toLowerCase()
  }
  try {
    return new TextDecoder(label ?? 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

// ───────────────────────── HTML → Markdown 风格文本 ─────────────────────────

const DROP_BLOCKS = [
  'script',
  'style',
  'noscript',
  'svg',
  'template',
  'iframe',
  'canvas',
  'object',
  'embed',
  'nav',
  'footer',
]
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'main',
  'aside',
  'blockquote',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'table',
  'figure',
  'figcaption',
  'form',
  'fieldset',
  'address',
  'details',
  'summary',
  'center',
  'body',
  'html',
])

/** 取 <title> 文本（没有则空串）。 */
export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)
  return m ? stripTags(m[1]) : ''
}

/** 去掉注释、head 和无用块，并优先取 <main>，其次所有 <article>。 */
function selectContent(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<head(?=[\s>])[\s\S]*?<\/head\s*>/gi, '')
  for (const t of DROP_BLOCKS) s = s.replace(new RegExp(`<${t}(?=[\\s>/])[\\s\\S]*?</${t}\\s*>`, 'gi'), '')
  const main = /<main(?=[\s>])[^>]*>([\s\S]*)<\/main\s*>/i.exec(s)
  if (main) return main[1]
  const articles = [...s.matchAll(/<article(?=[\s>])[^>]*>([\s\S]*?)<\/article\s*>/gi)].map(m => m[1])
  if (articles.length > 0) return articles.join('\n<hr>\n')
  return s
}

/** 把 HTML 转成可读文本：标题 #、列表 -、链接绝对化、pre 围栏、表格竖线行。 */
export function htmlToText(html: string, baseUrl: string): string {
  const src = selectContent(html)
  let out = ''
  const codeBlocks: string[] = []
  const links: { href: string; start: number }[] = []
  const lists: { ordered: boolean; n: number }[] = []
  let pre: { buf: string; lang: string } | null = null
  let cellStart = -1
  let row: string[] | null = null
  let rowHasTh = false
  let tableRows = 0

  const atLineStart = () => out === '' || out.endsWith('\n')
  // 保证末尾至少有 n 个换行；开头不加换行
  const nl = (n: number) => {
    if (out === '') return
    out = out.replace(/ +$/, '')
    let have = 0
    while (have < n && out[out.length - 1 - have] === '\n') have++
    out += '\n'.repeat(n - have)
  }
  const addText = (raw: string) => {
    let t = decodeEntities(raw).replace(/\s+/g, ' ')
    if (atLineStart() || out.endsWith(' ')) t = t.trimStart()
    out += t
  }
  const absolutize = (href: string): string | null => {
    if (!href || href.startsWith('#')) return null
    try {
      const u = new URL(href, baseUrl)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
    } catch {
      return null
    }
  }

  const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+|<)/g
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(src))) {
    if (m[4] !== undefined) {
      if (pre) pre.buf += decodeEntities(m[4])
      else addText(m[4])
      continue
    }
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    const attrRaw = m[3]

    if (pre) {
      if (tag === 'pre' && closing) {
        const text = pre.buf.replace(/^\n+/, '').replace(/\s+$/, '')
        const fence = text.includes('```') ? '````' : '```'
        codeBlocks.push(`${fence}${pre.lang}\n${text}\n${fence}`)
        out += `${PH_OPEN}${codeBlocks.length - 1}${PH_CLOSE}`
        pre = null
        nl(2)
      } else if (tag === 'br') pre.buf += '\n'
      else if (tag === 'code' && !closing) {
        const cls = parseAttrs(attrRaw).class ?? ''
        const lm = /(?:language|lang)-([\w+#-]+)/.exec(cls)
        if (lm && !pre.lang) pre.lang = lm[1]
      }
      continue
    }

    if (/^h[1-6]$/.test(tag)) {
      nl(2)
      if (!closing) out += `${'#'.repeat(Number(tag[1]))} `
    } else if (tag === 'pre') {
      if (!closing) {
        nl(2)
        pre = { buf: '', lang: '' }
      }
    } else if (tag === 'br') {
      out = out.replace(/ +$/, '') + '\n'
    } else if (tag === 'hr') {
      nl(2)
      out += '---'
      nl(2)
    } else if (tag === 'ul' || tag === 'ol') {
      if (!closing) {
        nl(lists.length === 0 ? 2 : 1)
        lists.push({ ordered: tag === 'ol', n: 0 })
      } else {
        lists.pop()
        nl(lists.length === 0 ? 2 : 1)
      }
    } else if (tag === 'li') {
      if (!closing) {
        nl(1)
        const top = lists[lists.length - 1]
        const indent = '  '.repeat(Math.max(0, lists.length - 1))
        if (top?.ordered) out += `${indent}${++top.n}. `
        else out += `${indent}- `
      }
    } else if (tag === 'a') {
      if (!closing) {
        const href = absolutize(parseAttrs(attrRaw).href ?? '')
        links.push({ href: href ?? '', start: out.length })
      } else {
        const link = links.pop()
        if (link?.href) {
          const start = Math.min(link.start, out.length)
          const text = out.slice(start).replace(/\s+/g, ' ').trim()
          if (text) out = `${out.slice(0, start)}[${text}](${link.href})`
        }
      }
    } else if (tag === 'code') {
      out += '`'
    } else if (tag === 'table') {
      nl(2)
      if (closing) tableRows = 0
    } else if (tag === 'tr') {
      if (!closing) {
        row = []
        rowHasTh = false
      } else if (row) {
        nl(1)
        out += `| ${row.join(' | ')} |`
        nl(1)
        if (tableRows === 0 && rowHasTh) out += `| ${row.map(() => '---').join(' | ')} |\n`
        tableRows++
        row = null
      }
    } else if (tag === 'td' || tag === 'th') {
      if (!closing) {
        cellStart = out.length
        if (tag === 'th') rowHasTh = true
      } else if (cellStart >= 0 && row) {
        const start = Math.min(cellStart, out.length)
        row.push(out.slice(start).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'))
        out = out.slice(0, start)
        cellStart = -1
      }
    } else if (BLOCK_TAGS.has(tag)) {
      nl(2)
    }
  }

  out = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return out.replace(new RegExp(`${PH_OPEN}([0-9]+)${PH_CLOSE}`, 'g'), (_, i: string) => codeBlocks[Number(i)])
}

// ───────────────────────── web_fetch ─────────────────────────

// pre 代码块先换成占位符（私有区字符，不会和正文冲突），整理完空白后再填回
const PH_OPEN = String.fromCharCode(0xe000)
const PH_CLOSE = String.fromCharCode(0xe001)

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface WebFetchParams {
  url: string
  prompt?: string
}

export interface ToolOutput<D> {
  text: string
  details: D
}

// 重定向的地址检查（SSRF 防护）：第一跳是用户审批时看到的那个网址，不检查（所以批准过的
// http://localhost:3000 开发服务器、内网主机照常能抓）；之后每一跳只要 host（主机名:端口）和第一跳不同，
// 就要求目标只指向公网地址，否则批准一个公网站点后，它一个 302 就能把请求引到 127.0.0.1、
// 169.254.169.254（云元数据）或内网，内容还会直接交给模型。同 host 的跳转（/ → /login、http → https）不检查。
// 残余限制：这里的解析和 Pi 实际建立连接之间有 DNS 重绑定的窗口；走 HTTP 代理时是代理在远端解析域名，
// 我们的检查只是参考。不去包 Pi 的 dispatcher（范围之外），第一跳靠用户审批兜底。
// 解析失败的跳转一律拦截（见 assertPublicHost）。
export async function runWebFetch(
  params: WebFetchParams,
  signal: AbortSignal | undefined,
  deps: { fetch: FetchFn; timeoutMs: number; maxBodyBytes: number; lookup?: LookupFn },
): Promise<ToolOutput<WebFetchDetails>> {
  const start = parseHttpUrl(String(params.url ?? '').trim())
  const combined = withTimeout(signal, deps.timeoutMs)
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
  }

  let current = start.href
  let hops = 0
  let res: Response
  let bytes: Buffer = Buffer.alloc(0)
  let capped = false
  let kind: ContentKind
  let ct: ParsedContentType
  let declaredLength: number
  try {
    for (;;) {
      res = await deps.fetch(current, { method: 'GET', redirect: 'manual', headers, signal: combined.signal })
      const loc = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null
      if (!loc) break
      await res.body?.cancel().catch(() => {})
      if (hops >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`)
      hops++
      let next: string
      try {
        next = new URL(loc, current).href
      } catch {
        throw new Error(`Invalid redirect location: ${loc}`)
      }
      const nextUrl = parseHttpUrl(next) // 每一跳都重新检查协议和账号密码
      if (nextUrl.host !== start.host) {
        const check = await untilAborted(
          assertPublicHost(nextUrl.hostname, deps.lookup ?? defaultLookup),
          combined.signal,
        )
        if (!check.ok) {
          const why = check.address
            ? `it resolves to a private or local address (${check.address})`
            : `its address could not be verified (${check.error ?? 'lookup failed'})`
          throw new Error(
            `Blocked redirect to ${nextUrl.host}: ${why}. web_fetch only follows redirects to public addresses; ask the user to fetch that URL directly if it is intended.`,
          )
        }
      }
      current = nextUrl.href
    }
    ct = parseContentType(res.headers.get('content-type'))
    kind = classifyMime(ct.mime)
    declaredLength = Number(res.headers.get('content-length') ?? 0) || 0
    if (kind === 'binary') {
      await res.body?.cancel().catch(() => {})
    } else {
      const r = await readCapped(res, deps.maxBodyBytes)
      bytes = r.bytes
      capped = r.capped
    }
  } catch (err) {
    if (
      err instanceof Error &&
      /^(Too many redirects|Invalid redirect|Blocked redirect|Unsupported URL|URLs with embedded|Invalid URL)/.test(
        err.message,
      )
    )
      throw err
    throw describeNetworkError(err, `Fetching ${new URL(current).host}`, signal, combined.timeout, deps.timeoutMs)
  }

  const contentType = res.headers.get('content-type') ?? ''
  const statusLine = `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
  const head: string[] = [`URL: ${current}`, `Status: ${statusLine}`, `Content-Type: ${contentType || '(none)'}`]
  if (params.prompt?.trim()) head.push(`Looking for: ${params.prompt.trim()}`)

  const details: WebFetchDetails = {
    url: start.href,
    finalUrl: current,
    status: res.status,
    contentType,
    bytes: kind === 'binary' ? declaredLength : bytes.length,
    truncated: false,
  }

  if (kind === 'binary') {
    head.push(
      '',
      `[Binary content not shown: ${ct.mime || 'unknown type'}, ${declaredLength ? formatSize(declaredLength) : 'size unknown'}]`,
    )
    return { text: head.join('\n'), details }
  }

  // 没声明类型时嗅探：含 NUL 视为二进制，像 HTML 的按 HTML 处理
  if (kind === 'unknown') {
    if (bytes.subarray(0, 1024).includes(0)) {
      head.push('', `[Binary content not shown: unknown type, ${formatSize(bytes.length)}]`)
      return { text: head.join('\n'), details }
    }
    const sniff = bytes.subarray(0, 512).toString('latin1').trimStart().toLowerCase()
    kind = sniff.startsWith('<!doctype html') || sniff.startsWith('<html') ? 'html' : 'text'
  }

  const decoded = decodeBody(bytes, ct.charset, kind === 'html')
  let body: string
  if (kind === 'html') {
    const title = extractTitle(decoded)
    if (title) head.push(`Title: ${title}`)
    body = htmlToText(decoded, current)
  } else if (kind === 'json') {
    try {
      body = JSON.stringify(JSON.parse(decoded), null, 2)
    } catch {
      body = decoded
    }
  } else {
    body = decoded
  }

  const t = truncateText(body)
  details.truncated = t.truncated || capped
  let text = `${head.join('\n')}\n\n${t.text}`
  if (capped)
    text += `\n\n[truncated: response body exceeded ${formatSize(deps.maxBodyBytes)}; only the first part was read]`
  return { text, details }
}

// ───────────────────────── web_search ─────────────────────────

export function clampLimit(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)))
}

/** 选后端：显式 PIXELSKY_SEARCH_URL（SearXNG）> Tavily > Brave > DuckDuckGo。 */
export function pickBackend(env: Env): SearchBackend {
  if (env.PIXELSKY_SEARCH_URL?.trim()) return 'searxng'
  if (env.TAVILY_API_KEY?.trim()) return 'tavily'
  if (env.BRAVE_API_KEY?.trim()) return 'brave'
  return 'duckduckgo'
}

/** DDG 的跳转链接 //duckduckgo.com/l/?uddg=<编码后的真实地址> 还原成真实地址。 */
export function unwrapDdgUrl(href: string): string {
  let h = decodeEntities(href).trim()
  if (h.startsWith('//')) h = `https:${h}`
  try {
    const u = new URL(h)
    if (/(^|\.)duckduckgo\.com$/.test(u.hostname) && u.pathname.startsWith('/l/')) {
      const target = u.searchParams.get('uddg')
      if (target) return target
    }
  } catch {
    // 不是合法 URL，原样返回
  }
  return h
}

/** 解析 DuckDuckGo HTML 结果页：a.result__a 是标题和链接，.result__snippet 是摘要，广告跳过。 */
export function parseDdgHtml(html: string): SearchResult[] {
  type Hit = { index: number; kind: 'title' | 'snippet'; attrs: Record<string, string>; inner: string }
  const hits: Hit[] = []
  const reTitle = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi
  let m: RegExpExecArray | null
  while ((m = reTitle.exec(html))) {
    const attrs = parseAttrs(m[1])
    const cls = ` ${attrs.class ?? ''} `
    if (cls.includes(' result__a ')) hits.push({ index: m.index, kind: 'title', attrs, inner: m[2] })
    else if (cls.includes(' result__snippet ')) hits.push({ index: m.index, kind: 'snippet', attrs, inner: m[2] })
  }
  // 只匹配 class 含 result__snippet 的开标签，免得外层 div 把内层吞掉
  const reSnip =
    /<(div|td|span)\b([^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*)>([\s\S]*?)<\/\1\s*>/gi
  while ((m = reSnip.exec(html))) {
    const attrs = parseAttrs(m[2])
    if (` ${attrs.class ?? ''} `.includes(' result__snippet '))
      hits.push({ index: m.index, kind: 'snippet', attrs, inner: m[3] })
  }
  hits.sort((a, b) => a.index - b.index)

  const results: SearchResult[] = []
  let last: SearchResult | null = null
  for (const h of hits) {
    if (h.kind === 'title') {
      const href = h.attrs.href ?? ''
      const url = unwrapDdgUrl(href)
      last = null
      if (/duckduckgo\.com\/y\.js/.test(url) || !/^https?:\/\//i.test(url)) continue // 广告或非 http 链接
      last = { title: stripTags(h.inner), url, snippet: '' }
      results.push(last)
    } else if (last && !last.snippet) {
      last.snippet = stripTags(h.inner)
    }
  }
  return results
}

function asResult(title: unknown, url: unknown, snippet: unknown): SearchResult | null {
  if (typeof url !== 'string' || !url) return null
  return {
    title: typeof title === 'string' ? stripTags(title) : '',
    url,
    snippet: typeof snippet === 'string' ? stripTags(snippet) : '',
  }
}

function compact(list: (SearchResult | null)[], limit: number): SearchResult[] {
  return list.filter((r): r is SearchResult => r !== null).slice(0, limit)
}

export function parseTavily(json: unknown, limit: number): SearchResult[] {
  const rows = (json as { results?: unknown }).results
  if (!Array.isArray(rows)) return []
  return compact(
    rows.map((r: Record<string, unknown>) => asResult(r.title, r.url, r.content)),
    limit,
  )
}

export function parseBrave(json: unknown, limit: number): SearchResult[] {
  const rows = (json as { web?: { results?: unknown } }).web?.results
  if (!Array.isArray(rows)) return []
  return compact(
    rows.map((r: Record<string, unknown>) => asResult(r.title, r.url, r.description)),
    limit,
  )
}

export function parseSearxng(json: unknown, limit: number): SearchResult[] {
  const rows = (json as { results?: unknown }).results
  if (!Array.isArray(rows)) return []
  return compact(
    rows.map((r: Record<string, unknown>) => asResult(r.title, r.url, r.content)),
    limit,
  )
}

export function formatSearchResults(query: string, backend: SearchBackend, results: readonly SearchResult[]): string {
  if (results.length === 0) return `No results found for "${query}" (backend: ${backend}).`
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title || r.url}`, `   ${r.url}`]
      if (r.snippet) lines.push(`   ${r.snippet}`)
      return lines.join('\n')
    })
    .join('\n')
}

export async function runWebSearch(
  params: { query: string; limit?: number },
  signal: AbortSignal | undefined,
  deps: { fetch: FetchFn; env: Env; timeoutMs: number },
): Promise<ToolOutput<WebSearchDetails>> {
  const query = String(params.query ?? '').trim()
  if (!query) throw new Error('query must be a non-empty string')
  const limit = clampLimit(params.limit)
  const backend = pickBackend(deps.env)
  const combined = withTimeout(signal, deps.timeoutMs)
  const label = `Search (${backend})`

  const request = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      const res = await deps.fetch(url, { ...init, signal: combined.signal })
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw new Error(`${label} failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
      }
      return res
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(label)) throw err
      throw describeNetworkError(err, label, signal, combined.timeout, deps.timeoutMs)
    }
  }
  const readText = async (res: Response): Promise<string> => {
    try {
      return await res.text()
    } catch (err) {
      throw describeNetworkError(err, label, signal, combined.timeout, deps.timeoutMs)
    }
  }
  const readJson = async (res: Response): Promise<unknown> => {
    const text = await readText(res)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${label} returned invalid JSON`)
    }
  }

  let results: SearchResult[]
  if (backend === 'searxng') {
    const base = (deps.env.PIXELSKY_SEARCH_URL ?? '').trim().replace(/\/+$/, '')
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`
    results = parseSearxng(
      await readJson(await request(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } })),
      limit,
    )
  } else if (backend === 'tavily') {
    const key = (deps.env.TAVILY_API_KEY ?? '').trim()
    const res = await request('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ api_key: key, query, max_results: limit }),
    })
    results = parseTavily(await readJson(res), limit)
  } else if (backend === 'brave') {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
    const res = await request(url, {
      headers: { accept: 'application/json', 'x-subscription-token': (deps.env.BRAVE_API_KEY ?? '').trim() },
    })
    results = parseBrave(await readJson(res), limit)
  } else {
    const res = await request('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': BROWSER_UA, accept: 'text/html' },
      body: new URLSearchParams({ q: query }).toString(),
    })
    const html = await readText(res)
    results = parseDdgHtml(html).slice(0, limit)
    if (results.length === 0 && /anomaly|captcha|unusual traffic/i.test(html)) {
      throw new Error(
        'DuckDuckGo blocked the request (bot check). Set TAVILY_API_KEY, BRAVE_API_KEY or PIXELSKY_SEARCH_URL to use another backend.',
      )
    }
  }

  return { text: formatSearchResults(query, backend, results), details: { backend, query, results } }
}

// ───────────────────────── 工具定义 ─────────────────────────

const FETCH_DESCRIPTION = `Fetch a web page or API endpoint over HTTP(S) and return its content as readable text.

- url must be a full http:// or https:// URL without embedded credentials. Redirects are followed (up to ${MAX_REDIRECTS}) and the final URL is reported.
- HTML is converted to Markdown-like text (headings, lists, links with absolute URLs, code blocks, tables); JSON is pretty-printed; other text is returned as is. Images, PDFs and other binary types are only described, not returned.
- prompt is optional: say what you are looking for. It is echoed in the result header; no extra model reads the page for you.
- Output is truncated to about 50 KB / 2000 lines. HTTP errors (4xx/5xx) return the status and the start of the body instead of failing.`

const SEARCH_DESCRIPTION = `Search the web and return a numbered list of results (title, URL, snippet).

- limit is 1-10 (default ${DEFAULT_LIMIT}).
- Use web_fetch on a result URL to read the full page.
- The backend is picked from the environment: PIXELSKY_SEARCH_URL (SearXNG), TAVILY_API_KEY, BRAVE_API_KEY, otherwise DuckDuckGo.`

/** 创建两个工具；fetch/env 可注入，默认取调用时的 globalThis.fetch（Pi 装好代理后的版本）和 process.env。 */
export function createWebTools(opts: WebToolsOptions = {}) {
  const doFetch: FetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const getEnv = (): Env => opts.env ?? process.env

  const fetchTool = {
    name: WEB_FETCH_TOOL_NAME,
    label: 'Web Fetch',
    description: FETCH_DESCRIPTION,
    promptSnippet: 'Fetch a URL and read it as text (web_fetch)',
    parameters: Type.Object({
      url: Type.String({ description: 'Full http(s) URL to fetch' }),
      prompt: Type.Optional(
        Type.String({ description: 'What you are looking for on the page (echoed in the result header)' }),
      ),
    }),
    executionMode: 'parallel' as const,
    async execute(_toolCallId: string, params: WebFetchParams, signal?: AbortSignal) {
      const r = await runWebFetch(params, signal, {
        fetch: doFetch,
        lookup: opts.lookup,
        timeoutMs: opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
        maxBodyBytes: opts.maxBodyBytes ?? MAX_BODY_BYTES,
      })
      return { content: [{ type: 'text' as const, text: r.text }], details: r.details }
    },
  }

  const searchTool = {
    name: WEB_SEARCH_TOOL_NAME,
    label: 'Web Search',
    description: SEARCH_DESCRIPTION,
    promptSnippet: 'Search the web (web_search)',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: 'Search query' }),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Max results, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT})`,
        }),
      ),
    }),
    executionMode: 'parallel' as const,
    async execute(_toolCallId: string, params: { query: string; limit?: number }, signal?: AbortSignal) {
      const r = await runWebSearch(params, signal, {
        fetch: doFetch,
        env: getEnv(),
        timeoutMs: opts.searchTimeoutMs ?? SEARCH_TIMEOUT_MS,
      })
      return { content: [{ type: 'text' as const, text: r.text }], details: r.details }
    },
  }

  return { fetchTool, searchTool }
}

export const webExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const { fetchTool, searchTool } = createWebTools()
  pi.registerTool(fetchTool)
  pi.registerTool(searchTool)
}
