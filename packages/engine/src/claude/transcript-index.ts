// Claude Code 会话记录的流式索引（docs/ui/claude-resume.md §4.1、§4.7）。
// 记录可能有几百 MB：不整份读进一个字符串，按块异步读，自己按 \n 切行，逐行解析，建「uuid → 行位置和父子关系」。
// 回退 / 分叉（transcript.ts）和导入终端会话（native.ts）共用这一份，按路径缓存：文件只是变长了就从上次读完的地方接着建。
import { createHash } from 'node:crypto'
import { open, rm, stat, type FileHandle } from 'node:fs/promises'

type Row = Record<string, unknown>
const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 每次读这么多；块之间让出事件循环，主进程最长停顿按一块算 */
export const INDEX_CHUNK = 4 * 1024 * 1024
/** 缓存最多放这么多个文件（LRU） */
const CACHE_MAX = 8
/** 判断「开头变没变」读的字节数 */
const HEAD_BYTES = 4096

/** 一行在文件里的位置：offset 是字节位置，len 不含换行，line 是从 0 起的行号（空行和写坏的行也占一个号） */
export interface RowPos {
  offset: number
  len: number
  line: number
}

export interface BoundaryInfo {
  trigger: 'manual' | 'auto' | null
  preTokens: number | null
  postTokens: number | null
  durationMs: number | null
  /** 压缩时原样保留给模型的一段：在文件里位于边界之前，摘要行（anchor）之后接的是新消息（§4.1） */
  segment: { head: string; anchor: string; tail: string } | null
}

/** user 行的种类：prompt 真正的用户输入；command 斜杠命令；summary 压缩摘要；result 只有工具结果；other 其余（meta、通知……） */
export type UserKind = 'prompt' | 'command' | 'summary' | 'result' | 'other'

export interface IndexRow extends RowPos {
  uuid: string
  /** Original item id when a relay row needs a fresh UUID. */
  pixelskyItemId?: string
  parent: string | null
  logical: string | null
  type: string
  subtype?: string
  sidechain?: true
  user?: UserKind
  /** 没有 version 的 user 行：等看到它的 assistant 子行才能确定是不是接力写入的 */
  noVersion?: true
  /** 接力写入的行（seedTranscript）：user 行没有 version 且 assistant 子行没有 message.model；assistant 行本身也标 */
  relay?: true
  boundary?: BoundaryInfo
  /** 同一个 uuid 出现不止一次时，第一次出现的位置（anchorPosition / 复制按第一次算） */
  first?: RowPos
}

export interface TranscriptIndex {
  file: string
  /** uuid → 行（同一个 uuid 出现两次时取最后一条，§4.1） */
  rows: Map<string, IndexRow>
  /** 主线上 user 行的 uuid → parentUuid（回退找截断点用） */
  userParents: Map<string, string | null>
  /** tool_use_id → 装着它的 tool_result 的那一行（并行调用的兄弟结果不在当前分支上，要靠这里找） */
  results: Map<string, RowPos & { uuid: string }>
  /** 已经读完的行数 */
  lines: number
  /** 已经索引到的字节位置（最后一行没有换行时停在这一行开头，下次重读） */
  indexed: number
  /** 最后一个主线上 compact_boundary 的行号，没有 -1 */
  boundaryLine: number
  /** 最后一条主线上的 user / assistant */
  lastMessage: IndexRow | null
  /** 最后一条 last-prompt */
  lastPrompt: { leafUuid: string; line: number } | null
  lastPromptText: string | null
  /** 第一条真正的用户输入 */
  firstPrompt: IndexRow | null
  customTitle: string | null
  aiTitle: string | null
  /** 最后一条主线 assistant 的 message.model（跳过 <synthetic>） */
  lastModel: string | null
  /** 第一次见到的 entrypoint、cwd */
  entrypoint: string | null
  cwd: string | null
}

export interface IndexOptions {
  signal?: AbortSignal
  /** 已读字节 / 总字节；每块调用一次 */
  onProgress?: (read: number, total: number) => void
  /** 块大小，测试用 */
  chunk?: number
}

function emptyIndex(file: string): TranscriptIndex {
  return {
    file,
    rows: new Map(),
    userParents: new Map(),
    results: new Map(),
    lines: 0,
    indexed: 0,
    boundaryLine: -1,
    lastMessage: null,
    lastPrompt: null,
    lastPromptText: null,
    firstPrompt: null,
    customTitle: null,
    aiTitle: null,
    lastModel: null,
    entrypoint: null,
    cwd: null,
  }
}

// ---------- user 行的内容 ----------

export interface UserContent {
  /** 所有 text 块用换行接起来（content 是字符串时就是它） */
  text: string
  hasText: boolean
  images: number
  /** tool_result 块的 tool_use_id */
  results: string[]
}

export function userContent(content: unknown): UserContent {
  if (typeof content === 'string') return { text: content, hasText: content.length > 0, images: 0, results: [] }
  const texts: string[] = []
  const results: string[] = []
  let images = 0
  if (Array.isArray(content))
    for (const b of content) {
      if (!isObj(b)) continue
      if (b.type === 'text') texts.push(text(b.text))
      else if (b.type === 'image') images++
      else if (b.type === 'tool_result') results.push(text(b.tool_use_id))
    }
  return { text: texts.join('\n'), hasText: texts.length > 0, images, results }
}

const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

/** `<command-name>/x</command-name><command-args>a</command-args>` → `/x a`；不是命令行时 null */
export function commandText(raw: string): string | null {
  const name = COMMAND_NAME.exec(raw)?.[1].trim()
  if (!name) return null
  const args = COMMAND_ARGS.exec(raw)?.[1].trim()
  const slash = name.startsWith('/') ? name : `/${name}`
  return args ? `${slash} ${args}` : slash
}

/** 这一行 user 记录算哪一种（规则见 §3.2「真正的用户输入」） */
export function classifyUser(
  e: Row,
  content = userContent(isObj(e.message) ? e.message.content : undefined),
): UserKind {
  if (e.isCompactSummary === true) return 'summary'
  if (e.isMeta === true) return 'other'
  // 后台任务通知（task-notification）、别的会话发来的（peer）等不是用户自己输入的
  const origin = isObj(e.origin) ? e.origin.kind : undefined
  if (origin !== undefined && origin !== 'human') return 'other'
  if (content.results.length > 0) return 'result'
  const t = content.text.trimStart()
  if (/^<command-(?:message|name)>/.test(t)) return commandText(t) ? 'command' : 'other'
  if (t.startsWith('<command-') || t.startsWith('<local-command-') || t.startsWith('<task-notification')) return 'other'
  // 中断时 Claude Code 自己补的一行，不是用户输入
  if (t.startsWith('[Request interrupted by user')) return 'other'
  // 只发了图片（没写字）也是一轮用户输入：不然导入时这一轮被并进上一轮、补上时找不到（GitHub 报告，2026-10-17）
  return (content.hasText && t) || content.images > 0 ? 'prompt' : 'other'
}

// ---------- 建索引 ----------

export function boundaryOf(e: Row): BoundaryInfo {
  const meta = isObj(e.compactMetadata) ? e.compactMetadata : {}
  const seg = isObj(meta.preservedSegment) ? meta.preservedSegment : null
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    trigger: meta.trigger === 'manual' || meta.trigger === 'auto' ? meta.trigger : null,
    preTokens: n(meta.preTokens),
    postTokens: n(meta.postTokens),
    durationMs: n(meta.durationMs),
    segment:
      seg && text(seg.headUuid) && text(seg.anchorUuid) && text(seg.tailUuid)
        ? { head: text(seg.headUuid), anchor: text(seg.anchorUuid), tail: text(seg.tailUuid) }
        : null,
  }
}

function addRow(idx: TranscriptIndex, e: Row, line: number, offset: number, len: number): void {
  const type = text(e.type)
  if (type === 'last-prompt') {
    if (typeof e.leafUuid === 'string') idx.lastPrompt = { leafUuid: e.leafUuid, line }
    if (typeof e.lastPrompt === 'string') idx.lastPromptText = e.lastPrompt.slice(0, 2000)
    return
  }
  if (type === 'ai-title' && typeof e.aiTitle === 'string') idx.aiTitle = e.aiTitle
  else if (type === 'custom-title' && typeof (e.customTitle ?? e.title) === 'string')
    idx.customTitle = (e.customTitle ?? e.title) as string
  if (idx.entrypoint === null && typeof e.entrypoint === 'string') idx.entrypoint = e.entrypoint
  if (idx.cwd === null && typeof e.cwd === 'string') idx.cwd = e.cwd
  if (typeof e.uuid !== 'string') return

  const message = isObj(e.message) ? e.message : {}
  const row: IndexRow = {
    uuid: e.uuid,
    parent: typeof e.parentUuid === 'string' ? e.parentUuid : null,
    logical: typeof e.logicalParentUuid === 'string' ? e.logicalParentUuid : null,
    type,
    offset,
    len,
    line,
  }
  if (typeof e.subtype === 'string') row.subtype = e.subtype
  const side = e.isSidechain === true
  if (side) row.sidechain = true

  const old = idx.rows.get(row.uuid)
  if (old) {
    // 重新读到同一行（上次最后一行没有换行）：还是同一条，不算重复
    const first = old.line === line ? old.first : (old.first ?? { offset: old.offset, len: old.len, line: old.line })
    if (first) row.first = first
  }
  idx.rows.set(row.uuid, row)

  if (type === 'system' && e.subtype === 'compact_boundary' && !side) {
    row.boundary = boundaryOf(e)
    idx.boundaryLine = Math.max(idx.boundaryLine, line)
  }
  if (type === 'user') {
    if (!side) {
      idx.userParents.set(row.uuid, row.parent)
      if (typeof e.pixelskyItemId === 'string' && e.pixelskyItemId) {
        row.pixelskyItemId = e.pixelskyItemId
        idx.userParents.set(e.pixelskyItemId, row.parent)
      }
    }
    const content = userContent(message.content)
    const kind = classifyUser(e, content)
    row.user = kind
    if (kind === 'prompt' && !side && typeof e.version !== 'string') row.noVersion = true
    if (kind === 'prompt' && !side && !idx.firstPrompt) idx.firstPrompt = row
    for (const id of content.results) if (id) idx.results.set(id, { uuid: row.uuid, offset, len, line })
  }
  if (type === 'assistant' && !side) {
    const model = text(message.model)
    const parent = row.parent ? idx.rows.get(row.parent) : undefined
    if (parent?.noVersion) {
      if (!model) {
        parent.relay = true
        row.relay = true
      }
      // 有 model 的是 Claude Code 自己写的：不是接力
      else delete parent.noVersion
    }
    if (model && model !== '<synthetic>') idx.lastModel = model
  }
  if ((type === 'user' || type === 'assistant') && !side) idx.lastMessage = row
}

/**
 * 按 \n 切行，读 [from, to)：onLine 收到每一行（不含换行）、它的字节位置、是不是以换行结尾（最后半行不是）。
 * 行的内容只在回调里有效（可能是读缓冲区的一段），要留着自己拷贝。afterChunk 每读完一块调用一次
 */
async function scanLines(
  fh: FileHandle,
  from: number,
  to: number,
  chunk: number,
  onLine: (line: Buffer, offset: number, terminated: boolean) => void,
  afterChunk?: (pos: number) => Promise<void>,
): Promise<void> {
  const buf = Buffer.allocUnsafe(Math.max(1, Math.min(chunk, to - from)))
  let pos = from
  let carry: Buffer | null = null
  let carryStart = from
  while (pos < to) {
    const want = Math.min(buf.length, to - pos)
    const { bytesRead } = await fh.read(buf, 0, want, pos)
    if (bytesRead === 0) break
    const view = buf.subarray(0, bytesRead)
    let start = 0
    for (;;) {
      const nl = view.indexOf(10, start)
      if (nl < 0) break
      if (carry) {
        onLine(Buffer.concat([carry, view.subarray(start, nl)]), carryStart, true)
        carry = null
      } else onLine(view.subarray(start, nl), pos + start, true)
      start = nl + 1
    }
    if (start < bytesRead) {
      if (!carry) carryStart = pos + start
      carry = carry ? Buffer.concat([carry, view.subarray(start)]) : Buffer.from(view.subarray(start))
    }
    pos += bytesRead
    await afterChunk?.(pos)
  }
  if (carry) onLine(carry, carryStart, false)
}

const yieldLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

async function extend(fh: FileHandle, idx: TranscriptIndex, to: number, opts: IndexOptions): Promise<void> {
  let line = idx.lines
  await scanLines(
    fh,
    idx.indexed,
    to,
    opts.chunk ?? INDEX_CHUNK,
    (buf, offset, terminated) => {
      if (buf.length > 0) {
        let e: unknown
        try {
          e = JSON.parse(buf.toString('utf8'))
        } catch {
          // 跳过写坏的行
        }
        if (isObj(e)) addRow(idx, e, line, offset, buf.length)
      }
      if (terminated) {
        line++
        idx.lines = line
        idx.indexed = offset + buf.length + 1
      }
    },
    async pos => {
      opts.signal?.throwIfAborted()
      opts.onProgress?.(pos, to)
      await yieldLoop()
    },
  )
}

// ---------- 缓存 ----------

interface Entry {
  index: TranscriptIndex
  /** 开头 headLen 字节的哈希：变了说明文件被换掉了 */
  head: string
  headLen: number
  size: number
  mtimeMs: number
  /** 读到文件末尾了（中途取消的不算，下次接着读） */
  complete: boolean
}

const cache = new Map<string, Entry>()
const locks = new Map<string, Promise<unknown>>()

async function headHash(fh: FileHandle, len: number): Promise<string> {
  const buf = Buffer.alloc(len)
  const { bytesRead } = await fh.read(buf, 0, len, 0)
  return createHash('sha1').update(buf.subarray(0, bytesRead)).digest('hex')
}

async function build(file: string, opts: IndexOptions): Promise<TranscriptIndex> {
  const st = await stat(file)
  let entry = cache.get(file)
  if (entry) cache.delete(file)
  if (entry?.complete && entry.size === st.size && entry.mtimeMs === st.mtimeMs) {
    cache.set(file, entry)
    return entry.index
  }
  const fh = await open(file, 'r')
  try {
    // 只是变长了、开头没变：从上次读完的行后面接着建；变短了或开头变了：整个重建
    if (entry && (st.size < entry.index.indexed || (await headHash(fh, entry.headLen)) !== entry.head))
      entry = undefined
    if (!entry) entry = { index: emptyIndex(file), head: '', headLen: 0, size: 0, mtimeMs: 0, complete: false }
    entry.complete = false
    cache.set(file, entry)
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
    await extend(fh, entry.index, st.size, opts)
    entry.headLen = Math.min(HEAD_BYTES, st.size)
    entry.head = await headHash(fh, entry.headLen)
    entry.size = st.size
    entry.mtimeMs = st.mtimeMs
    entry.complete = true
    return entry.index
  } finally {
    await fh.close()
  }
}

/**
 * 记录文件的索引。按路径缓存（带 size + mtime + 开头哈希）；同一个文件的请求排队，后一个接着前一个读完的地方继续。
 * signal 触发时抛出（已读的部分留在缓存里，下次接着读）
 */
export function transcriptIndex(file: string, opts: IndexOptions = {}): Promise<TranscriptIndex> {
  const run = (locks.get(file) ?? Promise.resolve()).then(() => build(file, opts))
  const tail = run.catch(() => undefined)
  locks.set(file, tail)
  void tail.then(() => {
    if (locks.get(file) === tail) locks.delete(file)
  })
  return run
}

/** 清掉缓存（测试用） */
export function clearTranscriptIndexCache(): void {
  cache.clear()
}

// ---------- 用索引回答问题 ----------

/** 回退截断点：按顺序找第一条出现在记录里的用户消息，取它的 parentUuid（旧 findRewindAnchor 的结果） */
export function rewindAnchorIn(idx: TranscriptIndex, userIds: readonly string[]): { at: string | null } | null {
  for (const id of userIds) if (idx.userParents.has(id)) return { at: idx.userParents.get(id) ?? null }
  return null
}

/** 截断点在最近一次压缩之前还是之后；记录里没有时 null（旧 anchorPosition 的结果） */
export function anchorPositionIn(idx: TranscriptIndex, at: string): 'loaded' | 'compacted' | null {
  const row = idx.rows.get(at)
  if (!row) return null
  return (row.first ?? row).line > idx.boundaryLine ? 'loaded' : 'compacted'
}

/**
 * 当前分支的末端：last-prompt 写在最后那条 user / assistant 之后时用它的 leafUuid（它可能指向 system、attachment 等行），
 * 否则用最后那条 user / assistant（和 currentLeaf / pointLastPrompt 同一个道理）
 */
export function leafOf(idx: TranscriptIndex): string | null {
  const last = idx.lastMessage
  const lp = idx.lastPrompt
  if (lp && idx.rows.has(lp.leafUuid) && (!last || lp.line > last.line)) return lp.leafUuid
  return last?.uuid ?? null
}

/** 从 leaf 沿父链往回走得到的所有 uuid（越过压缩边界沿 logicalParentUuid，同 branchRows）；遇到环就停 */
export function branchUuids(idx: TranscriptIndex, leaf: string): Set<string> {
  const out = new Set<string>()
  let cur = idx.rows.get(leaf)
  while (cur && !out.has(cur.uuid)) {
    out.add(cur.uuid)
    const next: string | null = cur.boundary ? (cur.logical ?? cur.parent) : cur.parent
    cur = next ? idx.rows.get(next) : undefined
  }
  return out
}

/** 按位置读出一批行，解析成对象（读不出来或写坏的行不在结果里）。key 是 offset */
export async function readRowsAt(file: string, positions: Iterable<RowPos>): Promise<Map<number, Row>> {
  const sorted = [...new Map([...positions].map(p => [p.offset, p])).values()].sort((a, b) => a.offset - b.offset)
  const out = new Map<number, Row>()
  if (sorted.length === 0) return out
  const fh = await open(file, 'r')
  try {
    for (const p of sorted) {
      const buf = Buffer.allocUnsafe(p.len)
      const { bytesRead } = await fh.read(buf, 0, p.len, p.offset)
      if (bytesRead !== p.len) continue
      try {
        const e: unknown = JSON.parse(buf.toString('utf8'))
        if (isObj(e)) out.set(p.offset, e)
      } catch {
        // 跳过写坏的行
      }
    }
  } finally {
    await fh.close()
  }
  return out
}

/**
 * 把记录的前 end 个字节（到截断点那一行的结尾）逐行复制到新文件 target（wx：已有同名文件时抛错），
 * 每行的 sessionId 换成新的；写坏的行丢掉。分块读写，不把整份记录拼成字符串
 */
export async function copyRowsTo(
  file: string,
  end: number,
  target: string,
  sessionId: string,
  chunk = INDEX_CHUNK,
): Promise<void> {
  const out = await open(target, 'wx')
  let ok = false
  try {
    const src = await open(file, 'r')
    try {
      let pending: string[] = []
      let size = 0
      const flush = async (): Promise<void> => {
        if (pending.length === 0) return
        await out.write(pending.join(''))
        pending = []
        size = 0
      }
      const lines: Buffer[] = []
      await scanLines(
        src,
        0,
        end,
        chunk,
        buf => lines.push(Buffer.from(buf)),
        async () => {
          for (const buf of lines.splice(0)) {
            if (buf.length === 0) continue
            let e: unknown
            try {
              e = JSON.parse(buf.toString('utf8'))
            } catch {
              continue
            }
            if (!isObj(e)) continue
            if (typeof e.sessionId === 'string') e.sessionId = sessionId
            const s = JSON.stringify(e) + '\n'
            pending.push(s)
            size += s.length
            if (size >= 1024 * 1024) await flush()
          }
          await yieldLoop()
        },
      )
      for (const buf of lines.splice(0)) {
        // 最后半行（没有换行）：和整份读时一样，能解析就算
        if (buf.length === 0) continue
        try {
          const e: unknown = JSON.parse(buf.toString('utf8'))
          if (!isObj(e)) continue
          if (typeof e.sessionId === 'string') e.sessionId = sessionId
          pending.push(JSON.stringify(e) + '\n')
        } catch {
          // 跳过写坏的行
        }
      }
      await flush()
    } finally {
      await src.close()
    }
    ok = true
  } finally {
    await out.close()
    if (!ok) await rm(target, { force: true })
  }
}
