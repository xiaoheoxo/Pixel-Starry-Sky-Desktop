// 接着 Claude Code 自己留下的会话（docs/ui/claude-resume.md）：列出会话、判断是不是还开着、把旧历史导入成条目。
// 记录文件可能有几百 MB，全部用流式索引（transcript-index.ts）加定位读，不把整份记录读进内存。
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Item } from '@pixelsky/protocol'
import { NO_REPLY } from '../chat-log'
import { NEW_TITLE, titleFrom } from '../host/title'
import { transcriptItems } from './runs'
import { obj, str } from './shape'
import { UUID, encodeCwd, findClaudeTranscript } from './transcript'
import {
  boundaryOf,
  classifyUser,
  commandText,
  leafOf,
  readRowsAt,
  transcriptIndex,
  userContent,
  type IndexRow,
  type RowPos,
  type TranscriptIndex,
} from './transcript-index'

import { countUsers, fit } from '../native/items'
import { matchCwd } from '../native/paths'
import { splitPrompt } from '../native/prompt'
import { NATIVE_TEXT } from '../native/text'
import type {
  ListOptions,
  LiveState,
  NativeListedDetail,
  NativeListedSession,
  NativeRead,
  NativeSessionList,
  NewerTurns,
  ReadOptions,
  TailBudget,
} from '../native/types'

// 旧名字保留，Claude 侧代码的 import 不用改
export type {
  ListOptions,
  LiveState,
  NativeRead,
  NewerTurns,
  ReadOptions,
  TailBudget,
  NativeListedDetail as ClaudeSessionDetail,
  NativeListedSession as ClaudeSessionSummary,
} from '../native/types'
/** Claude 的列表一定带尾部预算 */
export type ClaudeSessionList = NativeSessionList & { budget: TailBudget }
export { NATIVE_TEXT } from '../native/text'
export { splitPrompt, type PromptParts } from '../native/prompt'

type Row = Record<string, unknown>

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// ---------- 列表：第一步（stat + 头 64 KB） ----------

const HEAD_BYTES = 64 * 1024
/** 头 64 KB 里认不出 cwd 时最多往下读到这里（第一句话里贴了截图、长日志） */
const HEAD_MAX = 16 * 1024 * 1024
const HEAD_CHUNK_MAX = 4 * 1024 * 1024
/** 列表里最多给这么多个（按修改时间从新到旧） */
export const LIST_LIMIT = 200
/** 每次打开选择框读尾部的总字节数、单个文件的上限（§3.2） */
export const TAIL_BUDGET = 64 * 1024 * 1024
export const TAIL_CAP = 4 * 1024 * 1024

interface HeadInfo {
  cwd: string | null
  entrypoint: string | null
  branch: string | null
  /** 第一句真正的用户输入（去掉像素星空加的前缀）；只发图片的不算，标题接着往后找有字的 */
  first: string
  /** 头部有过真正的用户输入（包括只发了图片的） */
  prompted: boolean
  customTitle: string | null
  aiTitle: string | null
  lastPrompt: string | null
  /** 头部读到了文件末尾（整个文件都读过了） */
  whole: boolean
}

const headCache = new Map<string, HeadInfo>()
const HEAD_CACHE_MAX = 500

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > HEAD_CACHE_MAX) cache.delete(cache.keys().next().value!)
  return value
}

/** 清掉列表的头尾缓存（测试用） */
export function clearNativeCaches(): void {
  headCache.clear()
  tailCache.clear()
}

function parseLine(line: string): Row | null {
  if (!line.trim()) return null
  try {
    const e: unknown = JSON.parse(line)
    return e && typeof e === 'object' && !Array.isArray(e) ? (e as Row) : null
  } catch {
    return null
  }
}

async function readHead(file: string, size: number, mtimeMs: number): Promise<HeadInfo> {
  const key = `${file}|${size}|${mtimeMs}`
  const hit = headCache.get(key)
  if (hit) return remember(headCache, key, hit)
  const info: HeadInfo = {
    cwd: null,
    entrypoint: null,
    branch: null,
    first: '',
    prompted: false,
    customTitle: null,
    aiTitle: null,
    lastPrompt: null,
    whole: false,
  }
  const fh = await open(file, 'r')
  try {
    // 先读头 64 KB。第一句话贴了截图 / 长日志时那一行就超过 64 KB，被截掉的半行里才有 cwd：
    // 还没认出 cwd 就接着往下读（最多 HEAD_MAX）；认出了 cwd、还没有用户输入、又有一行被截在边界上，只把这一行读完
    let pos = 0
    let carry = Buffer.alloc(0)
    for (let chunk = HEAD_BYTES; ; chunk = Math.min(chunk * 2, HEAD_CHUNK_MAX)) {
      const buf = Buffer.alloc(Math.max(0, Math.min(chunk, size - pos)))
      const { bytesRead } = buf.length ? await fh.read(buf, 0, buf.length, pos) : { bytesRead: 0 }
      const extra = pos > 0
      pos += bytesRead
      const end = pos >= size || bytesRead === 0
      const data = Buffer.concat([carry, buf.subarray(0, bytesRead)])
      // 只读完被截的那一行时到第一个换行为止，后面读进来的不算（whole 只在真的看完了整个文件时为 true）
      const finishing = extra && info.cwd !== null
      const nl = finishing ? data.indexOf(0x0a) : data.lastIndexOf(0x0a)
      const cut = finishing && nl >= 0 ? nl + 1 : end ? data.length : nl + 1
      for (const line of data.subarray(0, cut).toString('utf8').split('\n')) takeHead(info, line)
      carry = data.subarray(cut)
      info.whole = end && carry.length === 0
      if (end || pos >= HEAD_MAX) break
      if (info.cwd !== null && (info.prompted || (extra ? cut > 0 : carry.length === 0))) break
    }
  } finally {
    await fh.close()
  }
  return remember(headCache, key, info)
}

/** 头部的一行：认 cwd、来源、分支、标题和第一句用户输入 */
function takeHead(info: HeadInfo, line: string): void {
  const e = parseLine(line)
  if (!e) return
  if (info.cwd === null && typeof e.cwd === 'string') info.cwd = e.cwd
  if (info.entrypoint === null && typeof e.entrypoint === 'string') info.entrypoint = e.entrypoint
  if (typeof e.gitBranch === 'string' && e.gitBranch) info.branch = e.gitBranch
  if (e.type === 'ai-title' && typeof e.aiTitle === 'string') info.aiTitle = e.aiTitle
  else if (e.type === 'custom-title' && typeof (e.customTitle ?? e.title) === 'string')
    info.customTitle = (e.customTitle ?? e.title) as string
  else if (e.type === 'last-prompt' && typeof e.lastPrompt === 'string') info.lastPrompt = e.lastPrompt
  else if (e.type === 'user' && !info.first && e.isSidechain !== true) {
    const content = userContent(obj(e.message).content)
    if (classifyUser(e, content) === 'prompt') {
      info.prompted = true
      info.first = splitPrompt(content.text).text
    }
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 标题优先级（§3.2）：custom-title → 最后一条 ai-title → 第一句用户输入 → lastPrompt → 「Claude Code 会话 MM-DD HH:mm」 */
function chooseTitle(
  parts: { custom: string | null; ai: string | null; first: string; last: string | null },
  mtimeMs: number,
): string {
  const custom = parts.custom?.trim()
  if (custom) return custom
  const ai = parts.ai?.trim()
  if (ai) return ai
  for (const text of [parts.first, parts.last ? splitPrompt(parts.last).text : '']) {
    if (!text.trim()) continue
    const title = titleFrom(text)
    if (title !== NEW_TITLE) return title
  }
  const d = new Date(mtimeMs)
  return `Claude Code 会话 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const promptLine = (raw: string | null): string | null => {
  if (!raw) return null
  const text = oneLine(splitPrompt(raw).text)
  return text ? clip(text, 200) : null
}

/** 候选目录：精确的 <projects>/<编码路径>；子文件夹和长路径（目录名被截断加哈希）靠前缀扫描，之后用记录里的 cwd 核对 */
async function candidateDirs(projectsDir: string, cwd: string, subfolders: boolean): Promise<string[]> {
  const encoded = encodeCwd(cwd)
  const direct = join(projectsDir, encoded)
  const found: string[] = []
  const hasDirect = await stat(direct).then(
    s => s.isDirectory(),
    () => false,
  )
  if (hasDirect) found.push(direct)
  if (hasDirect && !subfolders && encoded.length < 150) return found
  let names: Dirent[]
  try {
    names = await readdir(projectsDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return found
    throw err
  }
  const prefix = encoded.slice(0, 200)
  for (const d of names) {
    if (!d.isDirectory()) continue
    const dir = join(projectsDir, d.name)
    if (dir !== direct && d.name.startsWith(`${prefix}-`)) found.push(dir)
  }
  return found
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

/**
 * 列出项目文件夹里的 Claude Code 会话（第一步）：只做 stat 和读头 64 KB。
 * 跳过文件名不是 uuid 的、0 字节的、记录里的工作目录对不上的、只有元数据的。读不到目录时抛错，目录不存在算空
 */
export async function listClaudeSessions(
  projectsDir: string,
  cwd: string,
  opts: ListOptions = {},
): Promise<ClaudeSessionList> {
  const subfolders = opts.subfolders === true
  const files: { id: string; file: string; size: number; mtimeMs: number; direct: boolean }[] = []
  const directDir = join(projectsDir, encodeCwd(cwd))
  for (const dir of await candidateDirs(projectsDir, cwd, subfolders)) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    const stats = await mapLimit(
      names.filter(n => n.endsWith('.jsonl') && UUID.test(n.slice(0, -'.jsonl'.length))),
      32,
      async name => {
        const file = join(dir, name)
        try {
          const st = await stat(file)
          return st.isFile() && st.size > 0
            ? {
                id: name.slice(0, -'.jsonl'.length),
                file,
                size: st.size,
                mtimeMs: st.mtimeMs,
                direct: dir === directDir,
              }
            : null
        } catch {
          return null
        }
      },
    )
    for (const s of stats) if (s) files.push(s)
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const seen = new Set<string>()
  const recent = files.filter(f => !seen.has(f.id) && seen.add(f.id)).slice(0, opts.limit ?? LIST_LIMIT)

  const built = await mapLimit(recent, 8, async f => {
    let head: HeadInfo
    try {
      head = await readHead(f.file, f.size, f.mtimeMs)
    } catch {
      return null
    }
    // 读到 HEAD_MAX 还没有 cwd：在这个项目自己的记录目录里就算这个项目的（编码撞车的目录里有 cwd 的照常核对）
    const recorded = head.cwd ?? (f.direct ? cwd : null)
    if (!recorded) return null
    const where = await matchCwd(cwd, recorded, subfolders)
    if (!where) return null
    // 头部没有用户输入、又已经是整个文件、也没有 last-prompt：只有元数据，不列
    if (!head.first && !head.prompted && head.whole && !head.lastPrompt) return null
    const summary: NativeListedSession = {
      id: f.id,
      file: f.file,
      size: f.size,
      mtimeMs: f.mtimeMs,
      updatedAt: f.mtimeMs,
      cwd: recorded,
      subdir: where.subdir,
      title: chooseTitle({ custom: head.customTitle, ai: null, first: head.first, last: head.lastPrompt }, f.mtimeMs),
      firstPrompt: clip(oneLine(head.first), 200),
      lastPrompt: head.whole ? promptLine(head.lastPrompt) : null,
      branch: head.branch,
      source: head.entrypoint === 'cli' ? 'terminal' : 'other',
      model: null,
    }
    return summary
  })
  const sessions = built.filter((s): s is NativeListedSession => s !== null)
  const budget: TailBudget = { left: opts.tailBudget ?? TAIL_BUDGET }
  return {
    sessions,
    budget,
    async *details(ids, signal) {
      const wanted = ids ? ids.map(id => sessions.find(s => s.id === id)) : sessions
      for (const s of wanted) {
        if (!s) continue
        signal?.throwIfAborted()
        const detail = await claudeSessionDetail(s, budget, opts.tailCap ?? TAIL_CAP)
        if (!detail.skipped) {
          s.lastPrompt = detail.lastPrompt
          s.title = detail.title
          s.model = detail.model
          s.branch = detail.branch ?? s.branch
        }
        yield detail
      }
    },
  }
}

// ---------- 列表：第二步（尾部） ----------

interface TailInfo {
  lastPrompt: string | null
  customTitle: string | null
  aiTitle: string | null
  lastActive: number | null
  model: string | null
  branch: string | null
  continuedIn: string | null
}

const tailCache = new Map<string, TailInfo>()

/** 读完这些就够了；lastPrompt 找到后读满 1 MB 还缺别的就不再往前找 */
function tailDone(t: TailInfo, read: number): boolean {
  if (t.lastPrompt === null) return false
  return (!!(t.aiTitle || t.customTitle) && t.lastActive !== null && !!t.model) || read >= 1024 * 1024
}

async function readTail(file: string, size: number, budget: TailBudget, cap: number): Promise<[TailInfo, number]> {
  const t: TailInfo = {
    lastPrompt: null,
    customTitle: null,
    aiTitle: null,
    lastActive: null,
    model: null,
    branch: null,
    continuedIn: null,
  }
  let read = 0
  const fh = await open(file, 'r')
  try {
    let end = size
    let carry: Buffer = Buffer.alloc(0)
    for (let chunk = 256 * 1024; end > 0 && read < cap && budget.left > 0; chunk *= 4) {
      const want = Math.min(chunk, end, cap - read, budget.left)
      const start = end - want
      const buf = Buffer.allocUnsafe(want)
      const { bytesRead } = await fh.read(buf, 0, want, start)
      budget.left -= want
      read += want
      const data = Buffer.concat([buf.subarray(0, bytesRead), carry])
      let body = data
      carry = Buffer.alloc(0)
      if (start > 0) {
        // 不是从文件开头读的：第一段多半是半截，留给下一块
        const nl = data.indexOf(10)
        if (nl < 0) {
          carry = data
          end = start
          continue
        }
        carry = Buffer.from(data.subarray(0, nl))
        body = data.subarray(nl + 1)
      }
      const lines = body.toString('utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = parseLine(lines[i])
        if (!e) continue
        if (t.lastPrompt === null && e.type === 'last-prompt' && typeof e.lastPrompt === 'string')
          t.lastPrompt = e.lastPrompt
        else if (t.aiTitle === null && e.type === 'ai-title' && typeof e.aiTitle === 'string') t.aiTitle = e.aiTitle
        else if (t.customTitle === null && e.type === 'custom-title' && typeof (e.customTitle ?? e.title) === 'string')
          t.customTitle = (e.customTitle ?? e.title) as string
        else if (t.continuedIn === null && e.type === 'continued-in' && typeof e.continuedInSessionId === 'string')
          t.continuedIn = e.continuedInSessionId
        if (t.lastActive === null && typeof e.timestamp === 'string') {
          const at = Date.parse(e.timestamp)
          if (Number.isFinite(at)) t.lastActive = at
        }
        if (t.branch === null && typeof e.gitBranch === 'string' && e.gitBranch) t.branch = e.gitBranch
        if (t.model === null && e.type === 'assistant' && e.isSidechain !== true) {
          const model = str(obj(e.message).model)
          if (model && model !== '<synthetic>') t.model = model
        }
      }
      end = start
      if (tailDone(t, read)) break
    }
  } finally {
    await fh.close()
  }
  return [t, read]
}

/**
 * 第二步：读一个会话的尾部，补 lastPrompt、标题、最后活动时间、模型、continued-in。
 * 单个文件最多读 cap 字节，总共受 budget 限制（读一次扣一次，命中缓存不扣）；预算用完了返回 skipped
 */
export async function claudeSessionDetail(
  s: NativeListedSession,
  budget: TailBudget,
  cap = TAIL_CAP,
): Promise<NativeListedDetail> {
  const key = `${s.file}|${s.size}|${s.mtimeMs}`
  let tail = tailCache.get(key)
  let read = 0
  if (!tail) {
    if (budget.left <= 0)
      return {
        id: s.id,
        lastPrompt: s.lastPrompt,
        title: s.title,
        lastActive: null,
        model: s.model,
        branch: s.branch,
        hidden: false,
        continuedIn: null,
        superseded: false,
        skipped: true,
        read: 0,
      }
    try {
      ;[tail, read] = await readTail(s.file, s.size, budget, cap)
    } catch {
      tail = {
        lastPrompt: null,
        customTitle: null,
        aiTitle: null,
        lastActive: null,
        model: null,
        branch: null,
        continuedIn: null,
      }
    }
    remember(tailCache, key, tail)
  }
  const head = await readHead(s.file, s.size, s.mtimeMs).catch(() => null)
  // 头部的 last-prompt 只有整个文件都在头部时才可信（否则后面还有更新的）
  const lastPrompt = tail.lastPrompt ?? (head?.whole ? head.lastPrompt : null)
  return {
    id: s.id,
    lastPrompt: promptLine(lastPrompt),
    title: chooseTitle(
      {
        custom: tail.customTitle ?? head?.customTitle ?? null,
        ai: tail.aiTitle ?? head?.aiTitle ?? null,
        first: head?.first ?? '',
        last: lastPrompt,
      },
      s.mtimeMs,
    ),
    lastActive: tail.lastActive,
    model: tail.model,
    branch: tail.branch ?? s.branch,
    hidden: !(head?.first || head?.prompted || s.firstPrompt) && lastPrompt === null,
    continuedIn: tail.continuedIn,
    superseded:
      !!tail.continuedIn &&
      UUID.test(tail.continuedIn) &&
      existsSync(join(dirname(s.file), `${tail.continuedIn}.jsonl`)),
    skipped: false,
    read,
  }
}

// ---------- 正开着吗 ----------

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // 没权限发信号说明进程在
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 登记读不了时，记录最近这么久写过就提示「可能还开着」 */
const MAYBE_LIVE_MS = 2 * 60 * 1000

/**
 * 这个会话现在有没有进程开着：读 <configDir>/sessions/*.json（Claude Code 的 pid 登记，没有公开的格式），
 * sessionId 对得上、进程还在、不是像素星空自己的进程（ownPids）就算开着；entrypoint 是 cli 的是终端，其余是别的程序。
 * 目录不存在或登记解析不了、又没找到时退回看记录的修改时间（transcriptMtimeMs）：2 分钟内写过的是 'maybe'
 */
interface Registry {
  regs: Row[]
  /** 目录读不了或有解析不了的登记 */
  unreadable: boolean
}

function readRegistry(configDir: string): Registry {
  const dir = join(configDir, 'sessions')
  const reg: Registry = { regs: [], unreadable: false }
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.json'))
  } catch {
    reg.unreadable = true
  }
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (!parsed || typeof parsed !== 'object') throw new Error('bad')
      reg.regs.push(parsed as Row)
    } catch {
      reg.unreadable = true
    }
  }
  return reg
}

function liveIn(reg: Registry, sessionId: string, own: ReadonlySet<number>, transcriptMtimeMs?: number): LiveState {
  for (const r of reg.regs) {
    if (r.sessionId !== sessionId || typeof r.pid !== 'number' || own.has(r.pid) || !pidAlive(r.pid)) continue
    return r.entrypoint === 'cli' ? 'terminal' : 'other'
  }
  if (reg.unreadable && transcriptMtimeMs !== undefined && Date.now() - transcriptMtimeMs < MAYBE_LIVE_MS)
    return 'maybe'
  return null
}

/**
 * 这个会话现在有没有进程开着：读 <configDir>/sessions/*.json（Claude Code 的 pid 登记，没有公开的格式），
 * sessionId 对得上、进程还在、不是像素星空自己的进程（ownPids）就算开着；entrypoint 是 cli 的是终端，其余是别的程序。
 * 目录不存在或登记解析不了、又没找到时退回看记录的修改时间（transcriptMtimeMs）：2 分钟内写过的是 'maybe'
 */
export function liveClaudeSession(
  configDir: string,
  sessionId: string,
  ownPids: Iterable<number> = [],
  transcriptMtimeMs?: number,
): LiveState {
  return liveIn(readRegistry(configDir), sessionId, new Set(ownPids), transcriptMtimeMs)
}

/** 一批会话的开着状态，登记只读一遍（列表里有上百个会话） */
export function liveClaudeSessions(
  configDir: string,
  rows: readonly { id: string; mtimeMs: number }[],
  ownPids: Iterable<number> = [],
): Map<string, LiveState> {
  const reg = readRegistry(configDir)
  const own = new Set(ownPids)
  return new Map(rows.map(r => [r.id, liveIn(reg, r.id, own, r.mtimeMs)]))
}

// ---------- 导入 ----------

const isTurn = (r: IndexRow): boolean => !r.sidechain && (r.user === 'prompt' || r.user === 'command')

/**
 * 当前分支（从末端沿 parentUuid 往回，到文件开头），按先后顺序。压缩边界之后接摘要，摘要后面接压缩时保留的一段
 * （preservedSegment，在文件里位于边界之前，摘要之后的行直接接在摘要上，§4.1）；越过边界时沿 logicalParentUuid 往前
 */
export function branchRows(idx: TranscriptIndex): IndexRow[] {
  const leaf = leafOf(idx)
  const out: IndexRow[] = []
  const seen = new Set<string>()
  const preserved = new Set<string>()
  let cur = leaf ? idx.rows.get(leaf) : undefined
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid)
    if (!cur.sidechain && !preserved.has(cur.uuid)) {
      if (cur.user === 'summary') {
        const boundary = cur.parent ? idx.rows.get(cur.parent) : undefined
        const seg = boundary?.boundary?.segment
        if (seg && seg.anchor === cur.uuid) {
          // 从 tail 沿 parentUuid 走到 head；到不了 head（记录不全）就整段不要，免得把整条历史拉进来
          const part: IndexRow[] = []
          const walked = new Set<string>()
          let r = idx.rows.get(seg.tail)
          let reached = false
          while (r && !walked.has(r.uuid)) {
            walked.add(r.uuid)
            if (!r.sidechain && !seen.has(r.uuid)) part.push(r)
            if (r.uuid === seg.head) {
              reached = true
              break
            }
            r = r.parent ? idx.rows.get(r.parent) : undefined
          }
          if (reached)
            for (const p of part) {
              out.push(p)
              preserved.add(p.uuid)
            }
        }
      }
      out.push(cur)
    }
    const next: string | null = cur.boundary ? (cur.logical ?? cur.parent) : cur.parent
    cur = next ? idx.rows.get(next) : undefined
  }
  return out.reverse()
}

/** i 是某个压缩区域的第一轮时，把起点退到那个边界（边界、摘要和前面的几条留在同一个窗口里） */
function extendStart(chain: readonly IndexRow[], i: number): number {
  let j = i - 1
  while (j >= 0 && !isTurn(chain[j]) && !chain[j].boundary) j--
  return j >= 0 && chain[j].boundary ? j : i
}

const turnIndexes = (chain: readonly IndexRow[], from = 0, to = chain.length): number[] => {
  const out: number[] = []
  for (let i = from; i < to; i++) if (isTurn(chain[i])) out.push(i)
  return out
}

function lastBoundary(chain: readonly IndexRow[]): number {
  for (let i = chain.length - 1; i >= 0; i--) if (chain[i].boundary) return i
  return -1
}

const userItem = (row: Row, text: string): Item => ({
  kind: 'user',
  id: str(row.uuid),
  text,
  createdAt: Date.parse(str(row.timestamp)) || 0,
  engine: 'claude',
})

/** 把一段连续的分支行读出来转成条目 */
async function render(idx: TranscriptIndex, rows: readonly IndexRow[], cwd: string): Promise<Item[]> {
  const parsed = await readRowsAt(idx.file, rows)
  const list = rows.flatMap(r => {
    const row = parsed.get(r.offset)
    return row ? [{ index: r, row }] : []
  })
  const relayUsers = new Set(rows.filter(r => r.relay && r.type === 'user').map(r => r.uuid))
  const relayReplies = new Set(rows.filter(r => r.relay && r.type === 'assistant').map(r => r.uuid))

  // 连续的接力轮次：第一轮前面放一条提示，说明有几轮、概要是什么
  const runs = new Map<string, { turns: number; overview: string | null }>()
  let run: { turns: number; overview: string | null } | null = null
  for (const { index, row } of list) {
    if (!isTurn(index)) continue
    if (!relayUsers.has(index.uuid)) {
      run = null
      continue
    }
    if (!run) {
      run = { turns: 0, overview: splitPrompt(userContent(obj(row.message).content).text).overview }
      runs.set(index.uuid, run)
    }
    run.turns++
  }

  // 并行调用的兄弟结果不在这条分支上：按索引找装着它们的行
  const have = new Set(list.map(l => l.index.offset))
  const extra: RowPos[] = []
  for (const { row } of list) {
    if (row.type !== 'assistant') continue
    const content = obj(row.message).content
    if (!Array.isArray(content)) continue
    for (const block of content as Row[]) {
      const found = block?.type === 'tool_use' ? idx.results.get(str(block.id)) : undefined
      if (found && !have.has(found.offset)) {
        have.add(found.offset)
        extra.push(found)
      }
    }
  }
  const siblings = extra.length ? await readRowsAt(idx.file, extra) : new Map<number, Row>()
  const results = new Map<string, Row>()
  for (const row of siblings.values())
    for (const id of userContent(obj(row.message).content).results) results.set(id, row)

  return transcriptItems(
    list.map(l => l.row),
    cwd,
    {
      ids: 'uuid',
      closeTools: true,
      noImages: true,
      result: id => results.get(id),
      hooks: {
        user: row => {
          const content = userContent(obj(row.message).content)
          const kind = classifyUser(row, content)
          if (kind === 'command') return [userItem(row, commandText(content.text.trimStart()) ?? '')]
          if (kind !== 'prompt') return []
          const out: Item[] = []
          const uuid = str(row.uuid)
          const first = runs.get(uuid)
          if (first)
            out.push({
              kind: 'notice',
              id: randomUUID(),
              level: 'info',
              text: NATIVE_TEXT.relayRun(first.turns),
              detail: first.overview,
            })
          const parts = splitPrompt(content.text)
          if (parts.handoff)
            out.push({
              kind: 'notice',
              id: randomUUID(),
              level: 'info',
              text: NATIVE_TEXT.handoff,
              detail: parts.handoff,
            })
          const note = content.images > 0 ? NATIVE_TEXT.images(content.images) : ''
          out.push(userItem(row, [parts.text, note].filter(Boolean).join('\n')))
          return out
        },
        skipText: (row, text) => relayReplies.has(str(row.uuid)) && text === NO_REPLY,
        system: row => {
          if (row.subtype !== 'compact_boundary') return []
          const info = boundaryOf(row)
          return [
            {
              kind: 'compaction',
              id: `imp-${str(row.uuid)}-0`,
              status: 'completed',
              trigger: info.trigger,
              startedAt: Date.parse(str(row.timestamp)) || 0,
              durationMs: info.durationMs,
              preTokens: info.preTokens,
              postTokens: info.postTokens,
            },
          ]
        },
      },
    },
  )
}

async function summaryText(idx: TranscriptIndex, chain: readonly IndexRow[]): Promise<string | null> {
  const b = lastBoundary(chain)
  const row = b >= 0 ? chain.slice(b + 1).find(r => r.user === 'summary') : undefined
  if (!row) return null
  const parsed = (await readRowsAt(idx.file, [row])).get(row.offset)
  const text = parsed ? userContent(obj(parsed.message).content).text : ''
  return text || null
}

async function titleOf(idx: TranscriptIndex, mtimeMs: number): Promise<string> {
  const first = idx.firstPrompt
    ? (await readRowsAt(idx.file, [idx.firstPrompt])).get(idx.firstPrompt.offset)
    : undefined
  return chooseTitle(
    {
      custom: idx.customTitle,
      ai: idx.aiTitle,
      first: first ? splitPrompt(userContent(obj(first.message).content).text).text : '',
      last: idx.lastPromptText,
    },
    mtimeMs,
  )
}

/** 没有结果的 tool_use：这一轮还没结束 */
async function openTurn(idx: TranscriptIndex, rows: readonly IndexRow[]): Promise<boolean> {
  const parsed = await readRowsAt(
    idx.file,
    rows.filter(r => r.type === 'assistant'),
  )
  for (const row of parsed.values()) {
    const content = obj(row.message).content
    if (Array.isArray(content))
      for (const block of content as Row[])
        if (block?.type === 'tool_use' && !idx.results.has(str(block.id))) return true
  }
  return false
}

function lastMessageUuid(chain: readonly IndexRow[]): string | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const r = chain[i]
    if (!r.sidechain && (r.type === 'user' || r.type === 'assistant')) return r.uuid
  }
  return null
}

function sourceOf(idx: TranscriptIndex): 'terminal' | 'other' {
  return idx.entrypoint === 'cli' ? 'terminal' : 'other'
}

/**
 * 把 Claude Code 的会话导入成条目：流式建索引，沿当前分支取最近 turns 轮（默认 50，条目最多 1000），
 * 在最近一次压缩处停下（摘要放在 summary 里）。记录不在时返回 null；id 不是 uuid 时抛错；signal 触发时抛出，不返回条目。
 * opts.before：加载更早的，返回 before 之前的 turns 轮（可以越过压缩边界一直到文件开头）
 */
export async function readClaudeSession(
  projectsDir: string,
  cwd: string,
  id: string,
  opts: ReadOptions = {},
): Promise<NativeRead | null> {
  if (!UUID.test(id)) throw new Error('会话 id 不对')
  const file = findClaudeTranscript(projectsDir, cwd, id)
  if (!file) return null
  const idx = await transcriptIndex(file, { signal: opts.signal, onProgress: opts.onProgress, chunk: opts.chunk })
  const turns = opts.turns ?? 50
  const maxItems = opts.maxItems ?? 1000
  let chain = branchRows(idx)
  const leaf = leafOf(idx)

  if (opts.live) {
    const starts = turnIndexes(chain)
    const last = starts.at(-1)
    if (last !== undefined && (await openTurn(idx, chain.slice(last)))) chain = chain.slice(0, last)
  }

  const lastB = lastBoundary(chain)
  const total = turnIndexes(chain).length
  let start: number
  let end = chain.length
  if (opts.before) {
    const p = chain.findIndex(r => r.uuid === opts.before)
    if (p < 0) throw new Error('找不到要接着往前加载的位置')
    end = extendStart(chain, p)
    const starts = turnIndexes(chain, 0, end)
    start = starts.length <= turns ? 0 : extendStart(chain, starts[starts.length - turns])
  } else {
    const region = Math.max(lastB, 0)
    const starts = turnIndexes(chain, region)
    start = starts.length <= turns ? region : extendStart(chain, starts[starts.length - turns])
  }

  opts.signal?.throwIfAborted()
  const fitted = fit(await render(idx, chain.slice(start, end), cwd), maxItems)
  opts.signal?.throwIfAborted()
  const shown = countUsers(fitted.items)
  const earliest = fitted.items.find(i => i.kind === 'user')?.id ?? null
  const before = turnIndexes(chain, 0, start).length + fitted.dropped
  const mtimeMs = (await stat(file)).mtimeMs
  return {
    file,
    items: fitted.items,
    title: await titleOf(idx, mtimeMs),
    turns: total,
    shown,
    summary: await summaryText(idx, chain),
    source: sourceOf(idx),
    model: idx.lastModel,
    leafUuid: chain.at(-1)?.uuid ?? leaf,
    at: lastMessageUuid(chain),
    earliestShownUuid: earliest,
    hasEarlier: before > 0,
    compacted: lastB >= 0 && start < lastB,
  }
}

/**
 * 补上：当前分支上 after（对话里已经有的最后一条的 uuid）之后新增的轮次（终端里又聊了几轮）。
 * 超过 turns 轮（默认 50）只给最近的，中间放一条提示。after 不在当前分支上时返回 null；记录不在时返回 null
 */
export async function newerTurns(
  projectsDir: string,
  cwd: string,
  id: string,
  after: string,
  opts: Pick<ReadOptions, 'turns' | 'maxItems' | 'signal' | 'onProgress' | 'chunk'> & {
    /** after 是一条用户消息（对话里认识的最后一条）时，从它这一轮的末尾算起，免得把它自己的回复当成新的 */
    afterTurn?: boolean
  } = {},
): Promise<NewerTurns | null> {
  if (!UUID.test(id)) throw new Error('会话 id 不对')
  const file = findClaudeTranscript(projectsDir, cwd, id)
  if (!file) return null
  const idx = await transcriptIndex(file, { signal: opts.signal, onProgress: opts.onProgress, chunk: opts.chunk })
  const chain = branchRows(idx)
  let at = chain.findIndex(r => r.uuid === after)
  if (at < 0) return null
  if (opts.afterTurn && isTurn(chain[at])) {
    // 这一轮的末尾：下一条用户消息之前的最后一行
    let next = at + 1
    while (next < chain.length && !isTurn(chain[next])) next++
    at = next - 1
  }
  const rest = chain.slice(at + 1)
  const starts = turnIndexes(rest)
  const limit = opts.turns ?? 50
  const gap = Math.max(0, starts.length - limit)
  const window = gap > 0 ? rest.slice(starts[gap]) : rest
  const items = fit(await render(idx, window, cwd), opts.maxItems ?? 1000).items
  opts.signal?.throwIfAborted()
  if (gap > 0)
    items.unshift({ kind: 'notice', id: randomUUID(), level: 'info', text: NATIVE_TEXT.gap(gap), detail: null })
  return {
    items,
    turns: starts.length,
    shown: countUsers(items),
    gap,
    leafUuid: chain.at(-1)?.uuid ?? null,
    at: lastMessageUuid(chain),
    base: chain[at].uuid,
  }
}
