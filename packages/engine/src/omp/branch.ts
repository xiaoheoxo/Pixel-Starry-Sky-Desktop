// oh-my-pi 的回退和分叉（docs/omp-engine.md §12.6）：会话文件是一棵只追加的树，每轮开始前由 turn-ext.ts 在树上记一条
// 标记（我们的用户条目 id），截断点就是那条标记。回退在同一个文件里用 navigate_tree 移过去；分叉把文件复制一份再移过去
// （不用 omp 的 fork 命令：工作目录不一样时 switch_session 会被拒，实测；来源会话也可能正开着）
import { randomUUID } from 'node:crypto'
import { closeSync, cpSync, existsSync, ftruncateSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { RewindAnchor } from '../adapter'
import { object, string, type Message } from '../pixel/process'
import { IMPORT_ID } from '../pixel/transcript'
import { TURN_ENTRY } from './turn-ext'

/** 文件头在这么多字节里：在第一行，或者在一行标题后面 */
export const HEAD_BYTES = 64 * 1024
const CHUNK = 1024 * 1024
/** 消息条目看开头这么多就够认出 id、parentId、角色 */
const ROW_HEAD = 600

export interface OmpRow {
  id: string
  parent: string
  /** 用户消息 / 其他进上下文的消息 / 我们的轮次标记 / 其余（换模型、自定义数据……） */
  kind: 'user' | 'message' | 'turn' | 'other'
  /** 标记里的用户条目 id */
  turn?: string
  /** 压缩的条目 */
  compaction?: true
  /** 这一行在文件里的位置 */
  pos: number
  length: number
}

/** 消息条目的开头：id、parentId 紧跟类型，后面的正文不用看 */
const MESSAGE = /^\{"type":"message","id":"([^"\\]+)","parentId":(?:null|"([^"\\]+)"),/

function quick(head: string): Omit<OmpRow, 'pos' | 'length'> | null {
  const m = MESSAGE.exec(head)
  return m && { id: m[1], parent: m[2] ?? '', kind: head.includes('"message":{"role":"user"') ? 'user' : 'message' }
}

/** 其余条目 id 在正文后面（实测），整行解析 */
function full(line: string): Omit<OmpRow, 'pos' | 'length'> | null {
  let e: Message
  try {
    e = object(JSON.parse(line))
  } catch {
    return null
  }
  const id = string(e.id)
  if (!id || e.type === 'session') return null
  const base = { id, parent: string(e.parentId) }
  if (e.type === 'message') return { ...base, kind: object(e.message).role === 'user' ? 'user' : 'message' }
  if (e.type === 'custom' && e.customType === TURN_ENTRY)
    return { ...base, kind: 'turn', turn: string(object(e.data).id) }
  if (e.type === 'compaction') return { ...base, kind: 'other', compaction: true }
  return { ...base, kind: e.type === 'custom_message' ? 'message' : 'other' }
}

/** 会话文件的树。leaf 是最后一条（omp 重新打开时就从它接着）；正文大的消息条目只看开头 */
export function ompTree(file: string): { rows: Map<string, OmpRow>; leaf: string } {
  const rows = new Map<string, OmpRow>()
  let leaf = ''
  const fd = openSync(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(CHUNK)
    let parts: Buffer[] = []
    let size = 0
    let found: ReturnType<typeof quick> = null
    let start = 0
    let read = 0
    const take = (part: Buffer): void => {
      if (found || !part.length) return
      // 下一块会覆盖 chunk：留着的要复制
      parts.push(Buffer.from(part))
      size += part.length
      if (size < ROW_HEAD || size - part.length >= ROW_HEAD) return
      found = quick(Buffer.concat(parts).toString('utf8', 0, ROW_HEAD))
      if (found) parts = []
    }
    // 写到一半的最后一行（没有换行）不算
    const end = (at: number): void => {
      const line = found ? '' : Buffer.concat(parts).toString('utf8')
      const r = found ?? quick(line.slice(0, ROW_HEAD)) ?? full(line)
      if (r) {
        rows.set(r.id, { ...r, pos: start, length: at - start })
        leaf = r.id
      }
      parts = []
      size = 0
      found = null
      start = at + 1
    }
    for (let n; (n = readSync(fd, chunk, 0, CHUNK, null)) > 0; read += n) {
      const data = chunk.subarray(0, n)
      let from = 0
      for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, from)) {
        take(data.subarray(from, i))
        end(read + i)
        from = i + 1
      }
      take(data.subarray(from))
    }
  } finally {
    closeSync(fd)
  }
  return { rows, leaf }
}

/**
 * 从 at（没有就是当前的叶子）往根走的条目，近的在前。at 是用户消息时从它的上一条走：
 * navigate_tree 到用户消息是退到它前面
 */
export function ompPath(tree: ReturnType<typeof ompTree>, at?: string | null): OmpRow[] {
  const path: OmpRow[] = []
  const seen = new Set<string>()
  let r = tree.rows.get(at || tree.leaf)
  if (at && r?.kind === 'user') r = tree.rows.get(r.parent)
  for (; r && !seen.has(r.id); r = tree.rows.get(r.parent)) {
    seen.add(r.id)
    path.push(r)
  }
  return path
}

/**
 * 截断点：被移除的用户条目里最早那条的标记。从终端补回来、导入来的轮次没有标记，条目 id 里带着 omp 的条目 id。
 * from：还没落实的回退 / 分叉的截断点，从它往前找。
 * 一条都没找到：最后一条用户消息有我们的标记，才能确定被移除的都没进过记录（unchanged）；不然按找不到算，
 * 由宿主开新会话带上交接（宁可多带一遍，也不能把回退掉的留在上下文里）
 */
export function ompAnchor(file: string, removedIds: readonly string[], from?: string | null): RewindAnchor | null {
  if (!existsSync(file)) return null
  const path = ompPath(ompTree(file), from)
  if (!path.length) return null
  const start = from || path[0].id
  if (!removedIds.length) return { at: start, unchanged: true }
  // 自动重连、重试的标记是「<条目 id>-reconnect-…」
  const removed = (turn: string): boolean => removedIds.some(id => turn === id || turn.startsWith(`${id}-`))
  const entries = new Set(removedIds.flatMap(id => IMPORT_ID.exec(id)?.[1] ?? []))
  let hit = -1
  path.forEach((r, i) => {
    if (r.kind === 'turn' ? removed(r.turn!) : r.kind === 'user' && entries.has(r.id)) hit = i
  })
  if (hit >= 0) {
    const kept = path.slice(hit + 1).some(r => r.kind === 'user' || r.kind === 'message')
    return { at: kept ? path[hit].id : null }
  }
  const last = path.findIndex(r => r.kind === 'user')
  const before = path.slice(last + 1).find(r => r.kind !== 'other')
  return last >= 0 && before?.kind === 'turn' && before.turn ? { at: start, unchanged: true } : null
}

/**
 * 复制一份会话文件给分叉用：换会话 id（omp 的租约按 id 算）和工作目录，只要写完整的行；子智能体的对话、
 * 放在文件里的大输出在同名目录里，一起复制。dir：omp 给这个工作目录的会话文件夹。找不到文件头抛错
 */
export function ompForkFile(source: string, dir: string, cwd: string): string {
  const id = randomUUID()
  const dest = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`)
  const from = openSync(source, 'r')
  try {
    const chunk = Buffer.allocUnsafe(CHUNK)
    const n = readSync(from, chunk, 0, HEAD_BYTES, 0)
    const text = chunk.toString('latin1', 0, n)
    const line = /^\{"type":"session",[^\n]*\n/m.exec(text)
    if (!line) throw new Error('认不出这个对话的会话文件')
    const header = JSON.parse(Buffer.from(line[0], 'latin1').toString('utf8')) as Record<string, unknown>
    const fresh: Record<string, unknown> = {
      ...header,
      id,
      cwd,
      timestamp: new Date().toISOString(),
      parentSession: header.id,
      // 提示缓存接着原来的（omp 自己整份分叉也带）
      providerPromptCacheKey: header.providerPromptCacheKey ?? header.id,
    }
    delete fresh.previousSessionFiles
    const to = openSync(dest, 'wx')
    try {
      let size = writeSync(to, chunk, 0, line.index)
      size += writeSync(to, JSON.stringify(fresh) + '\n')
      let complete = size
      for (let pos = line.index + line[0].length, got; (got = readSync(from, chunk, 0, CHUNK, pos)) > 0; pos += got) {
        writeSync(to, chunk, 0, got)
        const at = chunk.subarray(0, got).lastIndexOf(10)
        if (at >= 0) complete = size + at + 1
        size += got
      }
      ftruncateSync(to, complete)
    } catch (error) {
      rmSync(dest, { force: true })
      throw error
    } finally {
      closeSync(to)
    }
  } finally {
    closeSync(from)
  }
  const extras = join(dirname(source), basename(source, '.jsonl'))
  try {
    if (existsSync(extras)) cpSync(extras, dest.slice(0, -'.jsonl'.length), { recursive: true })
  } catch {
    // 少了只影响点开以前的子智能体、读以前的大输出
  }
  return dest
}
