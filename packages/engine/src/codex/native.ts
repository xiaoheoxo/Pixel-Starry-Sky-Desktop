// 接着 Codex 自己留下的线程（docs/ui/codex-resume.md）：列线程、判断是不是还开着、把旧历史导入成条目。
// 读历史全部走 app-server 的 thread/list、thread/read、thread/turns/list（见 reader.ts），不自己解析 rollout 文件；
// 只有两件事直接看文件：线程写入锁（正开着吗）、rollout 文件还在不在。
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Item } from '@pixelsky/protocol'
import { HANDOFF_TAG } from '../handoff'
import { NEW_TITLE, titleFrom } from '../host/title'
import { IS_WINDOWS } from '../exec'
import { countUsers, fit } from '../native/items'
import { matchCwd } from '../native/paths'
import { splitIdeContext, splitPrompt } from '../native/prompt'
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
import { array, object, string, type Message } from './process'
import type { CodexRpc } from './reader'
import { findCodexRollouts, threadTime } from './runs'
import { CodexTranslator } from './translate'

/** 列表里最多给这么多个（按最后活动时间从新到旧） */
export const LIST_LIMIT = 200
/** 翻线程列表时最多看这么多个线程 */
const SCAN_LIMIT = 2000
const LIST_PAGE = 100
/** 每次打开选择框第二步最多发这么多次请求（ListOptions.tailBudget 在 Codex 里是请求数） */
export const DETAIL_BUDGET = 200
/** 读轮次内容每页的轮数（一轮 full 视图最大约 650 KB，5 轮离协议帧上限很远） */
export const FULL_PAGE = 5
const INDEX_PAGE = 200
const DAY = 86_400_000

const CACHE_MAX = 500
const INDEX_CACHE_MAX = 8

type Cache<T> = Map<string, T>

function remember<T>(cache: Cache<T>, key: string, value: T, max: number): T {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > max) cache.delete(cache.keys().next().value!)
  return value
}

/**
 * 第二步的「最后一句」，按 线程 id + updatedAt 缓存；tail 是缓存时最后一轮的 id + 状态
 * （updatedAt 只到秒，同一秒里的新回复靠 tail 发现）
 */
const detailCache: Cache<{ last: string | null; tail: string; cachedAt: number }> = new Map()
/** 轮次索引，按 线程 id + updatedAt 缓存（同一个线程最多留一份）；命中后还要核对最后一轮（codexTurnIndex） */
const indexCache: Cache<{ refs: TurnRef[]; cachedAt: number }> = new Map()

/** 同一秒之后再有改动 updatedAt 一定会变（缓存键失效）；所以只有缓存是在 updatedAt 那一秒内、或之后 2 秒内（时钟 / 落盘余量）取的，才需要核对 */
const mayChangeInSameSecond = (cachedAt: number, updatedAtMs: number): boolean => cachedAt < updatedAtMs + 1000 + 2000

/** 清掉列表和轮次索引的缓存（测试用） */
export function clearCodexCaches(): void {
  detailCache.clear()
  indexCache.clear()
}

/** 最后一轮的指纹：id + 状态；没有轮次是空串 */
const tailOf = (turn: { id?: unknown; status?: unknown } | undefined): string =>
  turn ? `${string(turn.id)}|${string(turn.status)}` : ''

/** 廉价核对：只取最后一轮（desc、limit 1、summary），返回它的指纹。请求失败原样抛出 */
async function tailProbe(reader: CodexRpc, id: string, signal?: AbortSignal): Promise<string> {
  const reply = await reader.request(
    'thread/turns/list',
    { threadId: id, sortDirection: 'desc', limit: 1, itemsView: 'summary' },
    signal,
  )
  return tailOf(array(reply.data).map(object)[0])
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const pad = (n: number): string => String(n).padStart(2, '0')
const secondsOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Codex 报「线程不存在」的几种说法（实测：thread not loaded: <id>；id 写错是 invalid thread id）。
 * 不能单独匹配 not found：配置里的 provider / profile 找不到也是这个词，会被当成线程没了而盖住真正的原因
 */
const GONE = /thread not loaded|thread not found|invalid thread id|no rollout found/i
const isGone = (err: unknown): boolean => GONE.test(err instanceof Error ? err.message : String(err))

// ---------- 用户话 ----------

/** userMessage 的内容：文字拼起来（换行分隔），图片张数 */
function userInput(item: Message): { text: string; images: number } {
  const text: string[] = []
  let images = 0
  for (const part of array(item.content).map(object)) {
    if (part.type === 'text') text.push(string(part.text))
    else if (part.type === 'image' || part.type === 'localImage') images++
  }
  return { text: text.join('\n'), images }
}

/** 用户话去掉像素星空的交接前缀和 VS Code 扩展的编辑器上下文；交接材料被截断（列表的 preview）时整段当没有 */
function plainPrompt(raw: string): string {
  const parts = splitPrompt(raw)
  if (!parts.handoff && parts.text.trimStart().startsWith(`<${HANDOFF_TAG}`)) return ''
  return splitIdeContext(parts.text).text
}

const promptLine = (raw: string): string | null => {
  const text = oneLine(plainPrompt(raw))
  return text ? clip(text, 200) : null
}

/** 标题（§3.2）：用户改的名字 / Codex 自动起的 name → 第一句话（去前缀）→「Codex 会话 MM-DD HH:mm」 */
/**
 * 经像素星空网关（平台线路、自定义接口）开的线程，在 Codex 自己的列表里的名字前缀：
 * 这些线程的 provider 只在像素星空启动 Codex 时临时传入，在 Codex 里打不开，带上前缀让用户认得出来
 */
export const PIXELSKY_THREAD_MARK = '[像素星空] '

/**
 * 线程该改成什么名字：经网关的是「前缀 + 会话标题」（标题还是「新会话」时先不改），
 * 不经网关的去掉以前加的前缀（这时它在 Codex 里能接着用了）。不用改时为 null
 */
export function codexThreadName(current: string, title: string, gateway: boolean): string | null {
  if (gateway) {
    const base = title.trim()
    if (!base || base === NEW_TITLE) return null
    const want = PIXELSKY_THREAD_MARK + base
    return want === current ? null : want
  }
  if (!current.startsWith(PIXELSKY_THREAD_MARK)) return null
  return current.slice(PIXELSKY_THREAD_MARK.length).trim() || null
}

export function codexTitle(thread: Message): string {
  const raw = string(thread.name).trim()
  const name = raw.startsWith(PIXELSKY_THREAD_MARK.trim()) ? raw.slice(PIXELSKY_THREAD_MARK.trim().length).trim() : raw
  if (name) return name
  const title = titleFrom(plainPrompt(string(thread.preview)))
  if (title !== NEW_TITLE) return title
  const d = new Date((secondsOf(thread.updatedAt) ?? 0) * 1000)
  return `Codex 会话 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const sourceOf = (thread: Message): 'terminal' | 'other' => (thread.source === 'cli' ? 'terminal' : 'other')

// ---------- 列表：第一步 ----------

/**
 * 列出项目文件夹（和它的子文件夹）里的 Codex 线程（第一步）：翻 thread/list，按线程的 cwd 自己判断在不在项目下面
 * （服务端的 cwd 过滤是精确匹配、区分大小写，不用）。不要子智能体、ephemeral、没有内容的线程。
 * Codex 没装 / app-server 起不来时抛错（reader 给的原因）
 */
export async function listCodexThreads(
  reader: CodexRpc,
  projectPath: string,
  opts: ListOptions = {},
): Promise<NativeSessionList> {
  const subfolders = opts.subfolders === true
  const limit = opts.limit ?? LIST_LIMIT
  const found: { thread: Message; subdir: string | null }[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  let scanned = 0
  for (let page = 0; found.length < limit && scanned < SCAN_LIMIT; page++) {
    const reply: Message = await reader.request('thread/list', {
      limit: LIST_PAGE,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      // 不传只列当前来源的线程；传 [] 才是全部
      modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      archived: false,
      ...(cursor ? { cursor } : {}),
      // 第一页让 Codex 顺手修元数据，后面的页只查状态库
      ...(page > 0 ? { useStateDbOnly: true } : {}),
    })
    const rows = array(reply.data).map(object)
    scanned += rows.length
    for (const thread of rows) {
      if (found.length >= limit) break
      const id = string(thread.id),
        cwd = string(thread.cwd)
      if (!id || !cwd || seen.has(id)) continue
      if (thread.ephemeral === true || string(thread.parentThreadId) || !string(thread.preview).trim()) continue
      const where = await matchCwd(projectPath, cwd, subfolders)
      if (!where) continue
      seen.add(id)
      found.push({ thread, subdir: where.subdir })
    }
    cursor = string(reply.nextCursor) || null
    if (!cursor || rows.length === 0) break
  }

  const sessions = await Promise.all(
    found.map(async ({ thread, subdir }): Promise<NativeListedSession> => {
      const file = string(thread.path)
      const size = file
        ? await stat(file).then(
            s => s.size,
            () => 0,
          )
        : 0
      const updatedAt = (secondsOf(thread.updatedAt) ?? 0) * 1000
      return {
        id: string(thread.id),
        file,
        size,
        mtimeMs: updatedAt,
        updatedAt,
        cwd: string(thread.cwd),
        subdir,
        title: codexTitle(thread),
        firstPrompt: clip(oneLine(plainPrompt(string(thread.preview))), 200),
        lastPrompt: null,
        branch: string(object(thread.gitInfo).branch) || null,
        source: sourceOf(thread),
        model: string(thread.model) || null,
      }
    }),
  )
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const budget: TailBudget = { left: opts.tailBudget ?? DETAIL_BUDGET }
  return {
    sessions,
    budget,
    async *details(ids, signal) {
      const wanted = ids ? ids.map(id => sessions.find(s => s.id === id)) : sessions
      for (const s of wanted) {
        if (!s) continue
        signal?.throwIfAborted()
        const detail = await codexThreadDetail(reader, s, budget, signal)
        if (!detail.skipped) s.lastPrompt = detail.lastPrompt
        yield detail
      }
    },
  }
}

// ---------- 列表：第二步 ----------

/**
 * 第二步：补一个线程的「最后一句」。thread/turns/list 倒序取 3 轮的 summary 视图，
 * 取第一个带用户消息的轮次。命中缓存且缓存是在 updatedAt 那一秒前后取的（同一秒里可能还有改动，见 mayChangeInSameSecond）
 * 才多发一次 limit 1 核对；每发一次请求（核对、重取）扣一次预算；预算（请求数）用完了：没缓存返回 skipped，有缓存直接用缓存
 */
export async function codexThreadDetail(
  reader: CodexRpc,
  s: NativeListedSession,
  budget: TailBudget,
  signal?: AbortSignal,
): Promise<NativeListedDetail> {
  const key = `${s.id}|${s.updatedAt}`
  const detail = (lastPrompt: string | null, skipped: boolean): NativeListedDetail => ({
    id: s.id,
    lastPrompt,
    title: s.title,
    lastActive: s.updatedAt,
    model: s.model,
    branch: s.branch,
    hidden: false,
    continuedIn: null,
    superseded: false,
    skipped,
    read: 0,
  })
  const cached = detailCache.get(key)
  if (cached) {
    const keep = (): NativeListedDetail => detail(remember(detailCache, key, cached, CACHE_MAX).last, false)
    // 预算没了就信缓存
    if (budget.left <= 0 || !mayChangeInSameSecond(cached.cachedAt, s.updatedAt)) return keep()
    // updatedAt 只到秒：同一秒里又有新回复 key 不变，核对一下最后一轮（多一次 limit 1 的请求，算进预算）
    budget.left--
    try {
      if ((await tailProbe(reader, s.id, signal)) === cached.tail) return keep()
    } catch (err) {
      if (signal?.aborted) throw err
      return keep()
    }
    // 变了：下面重取，重取也扣一次预算
    budget.left--
  } else {
    if (budget.left <= 0) return detail(s.lastPrompt, true)
    budget.left--
  }
  const cachedAt = Date.now()
  let last: string | null = null
  let tail: string
  try {
    const reply = await reader.request(
      'thread/turns/list',
      { threadId: s.id, sortDirection: 'desc', limit: 3, itemsView: 'summary' },
      signal,
    )
    const turns = array(reply.data).map(object)
    tail = tailOf(turns[0])
    for (const turn of turns) {
      const users = array(turn.items)
        .map(object)
        .filter(item => item.type === 'userMessage')
      const text = users.length ? promptLine(userInput(users[users.length - 1]).text) : null
      if (text) {
        last = text
        break
      }
    }
  } catch (err) {
    // 取消要往外抛；其余（线程刚被删……）这一行没有「最后一句」就是了，不缓存；有旧缓存就退回旧的，别显示成空
    if (signal?.aborted) throw err
    return detail(cached ? cached.last : null, false)
  }
  remember(detailCache, key, { last, tail, cachedAt }, CACHE_MAX)
  return detail(last, false)
}

// ---------- 正开着吗 ----------

export type LockProbe = (file: string) => 'busy' | 'free' | 'unknown'

/** Windows 上被占着的锁文件读不了（EBUSY）；读得到说明锁已经放了，文件是残留 */
const probeLock: LockProbe = file => {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    readSync(fd, Buffer.alloc(1), 0, 1, 0)
    return 'free'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EBUSY' ? 'busy' : 'unknown'
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export interface LiveOptions {
  /** 读锁文件的方法；默认真去读，测试注入假的 */
  probe?: LockProbe
  /** 默认当前平台 */
  windows?: boolean
}

/**
 * 一批线程现在有没有进程开着：看 <codexHome>/thread-writer-locks/<id>.lock（Codex 的线程写入锁）。
 * - 文件不存在 → null；
 * - Windows：读不了（EBUSY）才算被占着，读得到是残留文件 → null；
 * - macOS / Linux：锁是建议锁，Node 测不了，文件存在就是 'maybe'。
 * 锁文件里没有是谁占的，被占着时按线程的来源近似：cli → 'terminal'，其余 → 'other'（sources 没有的按 other）。
 * own：像素星空自己的会话正在用的线程，不算。目录不存在（比较老的 Codex）→ 全部 null
 */
export function liveCodexThreads(
  codexHome: string,
  rows: readonly { id: string }[],
  own: ReadonlySet<string> | readonly string[] = [],
  sources: ReadonlyMap<string, 'terminal' | 'other'> = new Map(),
  opts: LiveOptions = {},
): Map<string, LiveState> {
  const ownSet = new Set(own)
  const dir = join(codexHome, 'thread-writer-locks')
  const windows = opts.windows ?? IS_WINDOWS
  const probe = opts.probe ?? probeLock
  const result = new Map<string, LiveState>()
  const present = existsSync(dir)
  for (const { id } of rows) {
    result.set(id, null)
    if (!present || ownSet.has(id)) continue
    const file = join(dir, `${id}.lock`)
    if (!existsSync(file)) continue
    if (!windows) {
      result.set(id, 'maybe')
      continue
    }
    const state = probe(file)
    if (state === 'busy') result.set(id, sources.get(id) === 'terminal' ? 'terminal' : 'other')
    else if (state === 'unknown') result.set(id, 'maybe')
  }
  return result
}

// ---------- 记录还在不在 ----------

/**
 * 线程创建那天（本地日期，前后各一天，防时区 / 跨零点）的日期目录里有没有它的 rollout：第一段一定放在那里。
 * 宿主每发一条消息都要问一次「记录还在不在」，先查这三个目录，不用把创建日之后的每一天都读一遍
 */
function rolloutOnCreationDay(codexHome: string, id: string, createdAt: number): boolean {
  const pad = (n: number): string => String(n).padStart(2, '0')
  for (const offset of [0, -DAY, DAY]) {
    const day = new Date(createdAt + offset)
    const dir = join(codexHome, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()))
    try {
      if (readdirSync(dir).some(name => name.startsWith('rollout-') && name.endsWith('.jsonl') && name.includes(id)))
        return true
    } catch {
      // 那天没有目录
    }
  }
  return false
}

/**
 * 线程的记录还在不在：sessions/ 下有它的 rollout，或 archived_sessions/ 下有文件名带它的 id。
 * sessions 目录不存在（读不了、布局变了），或线程 id 不是 UUIDv7（rollout 放在哪天的目录算不出来）拿不准，当它在
 * （旧格式线程的 id 是 v4，也落在这里：它们一律复制导入，复制出的新线程是 v7，兜底只对新线程有用）。
 * 先查创建日的目录，没有再把创建日之后的目录全扫一遍（rollout 被删后才会走到全扫）
 */
export function codexThreadExists(codexHome: string, id: string): boolean {
  const createdAt = threadTime(id)
  if (!existsSync(join(codexHome, 'sessions')) || createdAt === null) return true
  if (rolloutOnCreationDay(codexHome, id, createdAt)) return true
  if (findCodexRollouts(codexHome, id).length > 0) return true
  try {
    return readdirSync(join(codexHome, 'archived_sessions')).some(name => name.includes(id))
  } catch {
    return false
  }
}

// ---------- 轮次索引 ----------

/** 一轮的概要（thread/turns/list 的 summary 视图）。startedAt 是 Codex 给的秒 */
export interface TurnRef {
  id: string
  status: string
  startedAt: number | null
  /** 这一轮有没有用户消息（没有的是 Codex 自己续跑的轮，并进前一轮，不单独算） */
  prompt: boolean
  /**
   * summary 视图里用户消息的 clientId（像素星空发的消息 id；终端里发的没有）。
   * 实测 Codex 0.163.0：originator 是 pixelsky 的线程，thread/turns/list 的 summary 和 full 视图里 userMessage 都带 clientId
   * （重试的消息是 <原 id>-retry-<uuid>），所以索引不用 full 视图
   */
  clientIds: string[]
}

/** Codex 的一个 Turn（thread/turns/list 返回的原样 JSON） */
export type CodexTurn = Message

/** thread/read 只读元数据（不带轮次）；线程不在了返回 null */
async function threadMeta(reader: CodexRpc, id: string, signal?: AbortSignal): Promise<Message | null> {
  try {
    const reply = await reader.request('thread/read', { threadId: id, includeTurns: false }, signal)
    const thread = object(reply.thread)
    return string(thread.id) ? thread : null
  } catch (err) {
    if (isGone(err)) return null
    throw err
  }
}

/**
 * 整个线程的轮次索引（升序）：thread/turns/list 的 summary 视图，每页 200 轮翻完。
 * 传了 updatedAt 就按 线程 id + updatedAt 缓存（最多 8 个线程），「加载更早的」「补上」接着用
 */
export async function codexTurnIndex(
  reader: CodexRpc,
  id: string,
  signal?: AbortSignal,
  updatedAt?: number,
): Promise<TurnRef[]> {
  const key = `${id}|${updatedAt}`
  if (updatedAt !== undefined) {
    const hit = indexCache.get(key)
    // updatedAt 只到秒：同一秒里新增 / 结束的轮次 key 不变，所以命中后核对最后一轮（id + 状态）一致才复用。
    // 核对请求失败原样抛出，调用方按 isGone 等处理
    // 缓存是在那一秒的余量之外取的：之后再有改动 updatedAt 一定变了，直接复用
    if (
      hit &&
      (!mayChangeInSameSecond(hit.cachedAt, updatedAt * 1000) ||
        (await tailProbe(reader, id, signal)) === tailOf(hit.refs[hit.refs.length - 1]))
    ) {
      remember(indexCache, key, hit, INDEX_CACHE_MAX)
      return hit.refs
    }
  }
  const refs: TurnRef[] = []
  // 取数据之前的时间：保守，宁可多核对
  const cachedAt = Date.now()
  let cursor: string | null = null
  // 页数上限只是防止异常的游标死循环
  for (let page = 0; page < 1000; page++) {
    signal?.throwIfAborted()
    const reply: Message = await reader.request(
      'thread/turns/list',
      { threadId: id, sortDirection: 'asc', itemsView: 'summary', limit: INDEX_PAGE, ...(cursor ? { cursor } : {}) },
      signal,
    )
    for (const turn of array(reply.data).map(object)) {
      const users = array(turn.items)
        .map(object)
        .filter(item => item.type === 'userMessage')
      refs.push({
        id: string(turn.id),
        status: string(turn.status),
        startedAt: secondsOf(turn.startedAt),
        prompt: users.length > 0,
        clientIds: users.map(u => string(u.clientId)).filter(Boolean),
      })
    }
    cursor = string(reply.nextCursor) || null
    if (!cursor) {
      if (updatedAt !== undefined) remember(indexCache, key, { refs, cachedAt }, INDEX_CACHE_MAX)
      return refs
    }
  }
  throw new Error('Codex turn list did not end')
}

/** 轮次索引里 refs[from, to) 中有用户消息的轮的下标 */
const promptIndexes = (refs: readonly TurnRef[], from = 0, to = refs.length): number[] => {
  const out: number[] = []
  for (let i = from; i < to; i++) if (refs[i].prompt) out.push(i)
  return out
}

/** 最后一个已结束（不是 inProgress）的轮，refs[from, to) 里找；没有为 null */
const lastEnded = (refs: readonly TurnRef[], from: number, to: number): string | null => {
  for (let i = to - 1; i >= from; i--) if (refs[i].status !== 'inProgress') return refs[i].id
  return null
}

/** 要显示的轮是不是在末尾还没结束：会话正开着时这一轮不导入 */
const liveEnd = (refs: readonly TurnRef[], live: boolean | undefined): number =>
  live && refs.length > 0 && refs[refs.length - 1].status === 'inProgress' ? refs.length - 1 : refs.length

/**
 * 读 refs[from, to) 这几轮的完整内容（升序）。full 视图的游标是不透明的，不能跳着读，所以从线程末尾 desc 往前翻，
 * 每页 FULL_PAGE 轮，翻过不要的页只解析不留，读到 refs[from] 为止
 */
async function readTurns(
  reader: CodexRpc,
  id: string,
  refs: readonly TurnRef[],
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<CodexTurn[]> {
  if (to <= from) return []
  const wanted = new Set(refs.slice(from, to).map(r => r.id))
  const oldest = refs[from].id
  const found: CodexTurn[] = []
  let cursor: string | null = null
  const pages = Math.ceil(refs.length / FULL_PAGE) + 20
  for (let page = 0; page < pages; page++) {
    signal?.throwIfAborted()
    const reply: Message = await reader.request(
      'thread/turns/list',
      {
        threadId: id,
        sortDirection: 'desc',
        itemsView: 'full',
        limit: FULL_PAGE,
        ...(cursor ? { cursor } : {}),
      },
      signal,
    )
    let reached = false
    for (const turn of array(reply.data).map(object)) {
      const turnId = string(turn.id)
      if (wanted.has(turnId)) found.push(turn)
      if (turnId === oldest) reached = true
    }
    cursor = string(reply.nextCursor) || null
    if (reached || !cursor) break
  }
  return found.reverse()
}

// ---------- 条目怎么转 ----------

export interface CodexItemsOptions {
  /** 会话正开着：末尾还没结束的一轮不转（readCodexThread 已经在取段时去掉，这里再兜一次） */
  live?: boolean
  /** 压缩条目前面放「模型只看到压缩摘要」，默认放；加载更早的由宿主放，补上不需要，传 false */
  summaryNote?: boolean
}

/** 交给翻译器的条目类型（其余 hookPrompt、enteredReviewMode、sleep……和没见过的类型跳过） */
const TRANSLATED = new Set([
  'agentMessage',
  'plan',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'imageView',
  'collabAgentToolCall',
  'collabToolCall',
  'subAgentActivity',
  'imageGeneration',
  'contextCompaction',
])

const notice = (text: string, detail: string | null = null, level: 'info' | 'warn' = 'info'): Item => ({
  kind: 'notice',
  id: randomUUID(),
  level,
  text,
  detail,
})

/**
 * app-server 的轮次 → 像素星空的条目（§4.2）。用户条目的 id 是 turn id（同一轮后面的引导消息是 <turn id>-u<n>），
 * 其余条目交给 CodexTranslator（id 是 cx-<item id>）。用户话前面像素星空的交接材料、VS Code 扩展的编辑器上下文拆成一条提示
 */
export function codexItems(turns: readonly CodexTurn[], opts: CodexItemsOptions = {}): Item[] {
  const list = turns.map(object)
  if (opts.live && list.length > 0 && list[list.length - 1].status === 'inProgress') list.pop()
  const out: Item[] = []
  for (const turn of list) {
    const turnId = string(turn.id),
      startedAt = (secondsOf(turn.startedAt) ?? 0) * 1000,
      unfinished = turn.status === 'inProgress'
    const translator = new CodexTranslator(() => {})
    const emitted = new Set<string>()
    let users = 0
    for (const raw of array(turn.items).map(object)) {
      const type = string(raw.type)
      if (type === 'userMessage') {
        const { text, images } = userInput(raw)
        const parts = splitPrompt(text)
        const ide = splitIdeContext(parts.text)
        if (parts.handoff) out.push(notice(NATIVE_TEXT.handoff, parts.handoff))
        if (ide.context) out.push(notice(NATIVE_TEXT.ideContext, ide.context))
        const note = images > 0 ? NATIVE_TEXT.images(images) : ''
        out.push({
          kind: 'user',
          id: users === 0 ? turnId : `${turnId}-u${users}`,
          text: [ide.text, note].filter(Boolean).join('\n'),
          createdAt: startedAt,
          engine: 'codex',
        })
        users++
        continue
      }
      if (!TRANSLATED.has(type)) continue
      // 没结束的轮里还在进行的条目：不按「已完成」翻，下面改成已中断
      translator.item(raw, !(unfinished && raw.status === 'inProgress'), false)
      for (const item of translator.items.values()) {
        if (emitted.has(item.id)) continue
        emitted.add(item.id)
        out.push(...finalize(item, startedAt, out.length > 0 && opts.summaryNote !== false))
      }
    }
    const error = string(object(turn.error).message)
    if (turn.status === 'failed' && error)
      out.push(notice(error, string(object(turn.error).additionalDetails) || null, 'warn'))
  }
  return out
}

/** 翻译器出来的条目 → 导入用的：压缩条目用这一轮的时间；还在 running 的改成已中断 */
function finalize(item: Item, startedAt: number, note: boolean): Item[] {
  let next = item
  if (next.kind === 'compaction') next = { ...next, startedAt, durationMs: null, preTokens: null, postTokens: null }
  if ('status' in next && next.status === 'running') next = { ...next, status: 'interrupted' }
  return next.kind === 'compaction' && note ? [notice(NATIVE_TEXT.summaryOnly), next] : [next]
}

// ---------- 导入 ----------

/**
 * 读一个线程，转成条目（§4.1）。线程不在了返回 null。
 * 默认最近 opts.turns（50）个「有用户消息的轮」到末尾；opts.before：加载更早的，取 before（turn id 或 clientId）前面的那些轮；
 * opts.live 且最后一轮没结束：这一轮不导入。条目超过 opts.maxItems（1000）从前面整轮去掉
 */
export async function readCodexThread(
  reader: CodexRpc,
  projectCwd: string,
  id: string,
  opts: ReadOptions = {},
): Promise<NativeRead | null> {
  const signal = opts.signal
  const thread = await threadMeta(reader, id, signal)
  if (!thread) return null
  let refs: TurnRef[]
  try {
    refs = await codexTurnIndex(reader, id, signal, secondsOf(thread.updatedAt) ?? undefined)
  } catch (err) {
    if (isGone(err)) return null
    throw err
  }
  const turns = opts.turns ?? 50
  const maxItems = opts.maxItems ?? 1000

  const last = liveEnd(refs, opts.live)
  const total = promptIndexes(refs, 0, last).length
  let end = last
  if (opts.before) {
    const p = refs.findIndex(r => r.id === opts.before || r.clientIds.includes(opts.before!))
    if (p < 0 || p >= last) throw new Error('找不到要接着往前加载的位置')
    end = p
  }
  const starts = promptIndexes(refs, 0, end)
  const start = starts.length <= turns ? 0 : starts[starts.length - turns]

  const raw = await readTurns(reader, id, refs, start, end, signal)
  signal?.throwIfAborted()
  const fitted = fit(codexItems(raw, { summaryNote: !opts.before }), maxItems)
  const earliest = fitted.items.find(i => i.kind === 'user')?.id ?? null
  const hidden = promptIndexes(refs, 0, start).length + fitted.dropped
  const historyMode = string(thread.historyMode)
  return {
    file: string(thread.path),
    items: fitted.items,
    title: codexTitle(thread),
    turns: total,
    shown: countUsers(fitted.items),
    summary: null,
    source: sourceOf(thread),
    model: string(thread.model) || null,
    leafUuid: null,
    at: lastEnded(refs, start, end),
    earliestShownUuid: earliest,
    hasEarlier: hidden > 0,
    compacted: fitted.items.some(i => i.kind === 'compaction'),
    cwd: string(thread.cwd) || projectCwd,
    ...(historyMode === 'legacy' ? { copyOnly: true } : {}),
    pixelsky: string(thread.originator) === 'pixelsky',
  }
}

/**
 * 补上：after（对话里认识的最后一条用户消息的 id：turn id 或 clientId）所在的那一轮之后新增的轮次（终端里又聊了几轮）。
 * after 那一轮后面没有用户消息的续跑轮算它自己的（导入时已经显示了）。超过 opts.turns（50）轮只给最近的，最前面放一条
 * 「中间还有 M 轮没有显示」。线程不在了、after 不在线程里返回 null。
 * base 是 after 这一轮（含续跑轮）最后的 turn id：「复制一份接着聊」从这里分叉；at 是线程里最后一个已结束的 turn id
 */
export async function newerCodexTurns(
  reader: CodexRpc,
  _cwd: string,
  id: string,
  after: string,
  opts: Pick<ReadOptions, 'turns' | 'maxItems' | 'signal' | 'live'> = {},
): Promise<NewerTurns | null> {
  const signal = opts.signal
  const thread = await threadMeta(reader, id, signal)
  if (!thread) return null
  let refs: TurnRef[]
  try {
    refs = await codexTurnIndex(reader, id, signal, secondsOf(thread.updatedAt) ?? undefined)
  } catch (err) {
    if (isGone(err)) return null
    throw err
  }
  // live：终端里正在跑的那一轮不导入（导入的话会固定成「已中断」，剩下的回复永远补不进来），下次 check 再补
  const last = liveEnd(refs, opts.live)
  const p = refs.findIndex(r => r.id === after || r.clientIds.includes(after))
  if (p < 0) return null
  // after 就是还没结束的那一轮（last 之后）：没有可补的
  let from = p + 1
  while (from < last && !refs[from].prompt) from++
  const starts = promptIndexes(refs, from, last)
  const limit = opts.turns ?? 50
  const gap = Math.max(0, starts.length - limit)
  const begin = gap > 0 ? starts[gap] : from

  const raw = await readTurns(reader, id, refs, begin, last, signal)
  signal?.throwIfAborted()
  const items = fit(codexItems(raw, { summaryNote: false }), opts.maxItems ?? 1000).items
  if (gap > 0) items.unshift(notice(NATIVE_TEXT.gap(gap)))
  return {
    items,
    turns: starts.length,
    shown: countUsers(items),
    gap,
    leafUuid: null,
    at: lastEnded(refs, 0, last),
    base: refs[from - 1].id,
  }
}
