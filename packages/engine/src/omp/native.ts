// 接着 oh-my-pi 自己留下的会话（docs/omp-engine.md §12.6）：<会话目录>/<编码过的工作目录>/<时间>_<会话 id>.jsonl，
// 只沿当前分支读（branch.ts）；标题行、自定义条目不显示。子智能体的在同名目录里，不列
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Item } from '@pixelsky/protocol'
import type { ListOptions, NativeListedDetail, NativeListedSession, NativeRead, ReadOptions } from '../native/types'
import type { NativeSessionList } from '../native/types'
import { matchCwd, sameDir } from '../native/paths'
import { splitPrompt } from '../native/prompt'
import { number, object, string, type Message } from '../pixel/process'
import { IMPORT_ID, messageItems, textOf } from '../pixel/transcript'
import { HEAD_BYTES, ompPath, ompTree, type OmpRow } from './branch'

/** 最多看最近改过的这么多个文件 */
const MAX_FILES = 2000
/** 一次同时读几个文件头 */
const PARALLEL = 16
const TAIL_BYTES = 128 * 1024

interface Found {
  file: string
  size: number
  mtimeMs: number
}

/** 会话目录下所有会话文件，从新到旧 */
async function files(root: string): Promise<Found[]> {
  const found: Found[] = []
  for (const bucket of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!bucket.isDirectory()) continue
    const dir = join(root, bucket.name)
    const names = (await readdir(dir).catch(() => [])).filter(name => name.endsWith('.jsonl'))
    const stats = await Promise.all(names.map(name => stat(join(dir, name)).catch(() => null)))
    stats.forEach((s, i) => {
      if (s?.isFile()) found.push({ file: join(dir, names[i]), size: s.size, mtimeMs: s.mtimeMs })
    })
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES)
}

/** 会话 id 或文件路径 → 文件；不在了返回 null */
export async function ompSessionFile(root: string, id: string): Promise<string | null> {
  if (isAbsolute(id))
    return stat(id).then(
      s => (s.isFile() ? id : null),
      () => null,
    )
  return (await files(root)).find(f => f.file.endsWith(`_${id}.jsonl`))?.file ?? null
}

async function slice(file: string, pos: number, length: number): Promise<Buffer> {
  const fd = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(Math.max(0, length))
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, pos)
    return buffer.subarray(0, bytesRead)
  } finally {
    await fd.close()
  }
}

const parse = (line: string): Message | null => {
  try {
    return object(JSON.parse(line))
  } catch {
    // 空行、读到一半的行
    return null
  }
}

const userText = (e: Message): string => {
  const m = object(e.message)
  return e.type === 'message' && m.role === 'user' ? splitPrompt(textOf(m.content)).text.trim() : ''
}
const modelOf = (e: Message): string => {
  const m = object(e.message)
  if (e.type !== 'message' || m.role !== 'assistant' || !string(m.model)) return ''
  return string(m.provider) ? `${string(m.provider)}/${string(m.model)}` : string(m.model)
}

interface Head {
  id: string
  cwd: string
  title: string
  firstPrompt: string
}

/** 文件头：标题、会话 id、工作目录、第一句话。不是会话文件返回 null */
async function headOf(file: string): Promise<(Head & { whole: boolean }) | null> {
  const bytes = await slice(file, 0, HEAD_BYTES)
  const head: Head = { id: '', cwd: '', title: '', firstPrompt: '' }
  for (const line of bytes.toString('utf8').split('\n')) {
    const e = parse(line)
    if (!e) continue
    if (e.type === 'title') head.title = string(e.title)
    else if (e.type === 'session') {
      head.id = string(e.id)
      head.cwd = string(e.cwd)
      head.title ||= string(e.title)
    } else if ((head.firstPrompt = userText(e))) break
  }
  return head.id && head.cwd ? { ...head, whole: bytes.length < HEAD_BYTES } : null
}

/**
 * omp 会话进程从哪个目录启动：omp 按文件头里写的工作目录认，大小写不一样（VS Code 终端里盘符是 d:）、走的是目录联接
 * 就拒绝切换（实测）。续接时是同一个目录就用文件头里的写法；还没有会话文件的按磁盘上的大小写（分叉的文件头照它写）
 */
export async function ompCwd(file: string | null, cwd: string): Promise<string> {
  if (file) {
    const head = await headOf(file).catch(() => null)
    return head && (await sameDir(head.cwd, cwd)) ? head.cwd : cwd
  }
  const real = await realpath(cwd).catch(() => cwd)
  return real.toLowerCase() === cwd.toLowerCase() ? real : cwd
}

export async function ompNativeSessions(
  root: string,
  project: string,
  opts: ListOptions = {},
): Promise<NativeSessionList> {
  const all = await files(root)
  const sessions: NativeListedSession[] = []
  for (let i = 0; i < all.length; i += PARALLEL) {
    const rows = await Promise.all(
      all.slice(i, i + PARALLEL).map(async f => {
        const head = await headOf(f.file).catch(() => null)
        // 一句话都没说过的
        if (!head || (head.whole && !head.firstPrompt)) return null
        const where = await matchCwd(project, head.cwd, opts.subfolders !== false)
        if (!where) return null
        return {
          id: head.id,
          file: f.file,
          size: f.size,
          mtimeMs: f.mtimeMs,
          updatedAt: f.mtimeMs,
          cwd: head.cwd,
          subdir: where.subdir,
          title: head.title || head.firstPrompt.split('\n')[0]!.slice(0, 80),
          firstPrompt: head.firstPrompt,
          lastPrompt: null,
          branch: null,
          source: 'terminal' as const,
          model: null,
        }
      }),
    )
    for (const row of rows) if (row) sessions.push(row)
  }
  const limited = opts.limit ? sessions.slice(0, opts.limit) : sessions
  return {
    sessions: limited,
    async *details(ids, signal) {
      for (const s of limited) {
        if (signal?.aborted) return
        if (!ids || ids.includes(s.id)) yield await detail(s)
      }
    },
  }
}

async function detail(s: NativeListedSession): Promise<NativeListedDetail> {
  const bytes = await slice(s.file, Math.max(0, s.size - TAIL_BYTES), TAIL_BYTES).catch(() => Buffer.alloc(0))
  let lastPrompt = '',
    model = '',
    lastActive = 0
  for (const line of bytes.toString('utf8').split('\n').reverse()) {
    const e = parse(line)
    if (!e || e.type !== 'message') continue
    lastActive ||= Date.parse(string(e.timestamp)) || 0
    model ||= modelOf(e)
    lastPrompt ||= userText(e)
    if (model && lastPrompt) break
  }
  s.lastPrompt = lastPrompt || null
  s.model = model || null
  return {
    id: s.id,
    lastPrompt: s.lastPrompt,
    title: s.title,
    lastActive: lastActive || null,
    model: s.model,
    branch: null,
    hidden: false,
    continuedIn: null,
    superseded: false,
    skipped: false,
    read: bytes.length,
  }
}

/** 条目：用户的 id 是 px-imp-<omp 条目 id>-u（回退、加载更早的靠它对位置） */
function itemsOf(list: readonly Message[], cwd: string): Item[] {
  const items: Item[] = []
  let run: Message[] = []
  const flush = (): void => {
    for (const item of messageItems(run, cwd, 'px-imp'))
      items.push(item.kind === 'user' ? { ...item, text: splitPrompt(item.text).text, engine: 'omp' } : item)
    run = []
  }
  for (const e of list) {
    if (e.type === 'message') run.push(e)
    if (e.type !== 'compaction') continue
    flush()
    items.push({
      kind: 'compaction',
      id: `px-imp-${string(e.id)}-c`,
      status: 'completed',
      trigger: null,
      startedAt: Date.parse(string(e.timestamp)) || 0,
      durationMs: null,
      preTokens: number(e.tokensBefore) || null,
      postTokens: number(e.tokensAfter) || null,
      ...(e.method === 'handoff' ? { handoff: string(e.summary) } : {}),
    })
  }
  flush()
  return items
}

/** 读一个会话当前分支最近的几轮；没有能显示的返回 null */
export async function ompReadNative(file: string, opts: ReadOptions = {}): Promise<NativeRead | null> {
  const head = await headOf(file)
  if (!head) return null
  const tree = ompTree(file)
  const path = ompPath(tree).reverse()
  const users = path.flatMap((r, i) => (r.kind === 'user' ? [i] : []))
  if (!users.length) return null
  const before = opts.before ? IMPORT_ID.exec(opts.before)?.[1] : undefined
  if (opts.before && !path.some(r => r.id === before)) return null
  const end = before ? path.findIndex(r => r.id === before) : path.length
  const earlier = users.filter(i => i < end)
  let shown = Math.min(earlier.length, opts.turns ?? 50)
  const load = async (r: OmpRow): Promise<Message | null> => {
    if (opts.signal?.aborted) throw new Error('aborted')
    return parse((await slice(file, r.pos, r.length)).toString('utf8'))
  }
  // 第一轮之前的条目（换模型之类）不要
  const from = shown ? earlier[earlier.length - shown] : end
  const list: Message[] = []
  for (const r of path.slice(from, end)) {
    const e = r.kind === 'message' || r.kind === 'user' || r.compaction ? await load(r) : null
    if (e) list.push(e)
  }
  let items = itemsOf(list, head.cwd)
  const most = opts.maxItems ?? 1000
  // 太多：从最早的一轮开始少给，至少留一轮
  while (items.length > most && shown > 1) {
    const next = items.findIndex((item, i) => i > 0 && item.kind === 'user')
    if (next < 0) break
    items = items.slice(next)
    shown--
  }
  const last = path.findLastIndex(r => r.compaction)
  const summary = last >= 0 ? object(await load(path[last])) : null
  let model = ''
  for (let i = path.length - 1; i >= 0 && !model; i--)
    if (path[i].kind === 'message') model = modelOf(object(await load(path[i])))
  const first = items.find(item => item.kind === 'user')
  return {
    file,
    sessionId: file,
    items,
    title: head.title || head.firstPrompt.split('\n')[0]!.slice(0, 80),
    turns: users.length,
    shown,
    summary: string(summary?.summary) || null,
    source: 'terminal',
    model: model || null,
    leafUuid: path.at(-1)!.id,
    at: path.at(-1)!.id,
    earliestShownUuid: first?.id ?? null,
    hasEarlier: earlier.length > shown,
    compacted: last >= end,
    cwd: head.cwd,
  }
}
