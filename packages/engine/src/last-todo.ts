// 从 items.jsonl 末尾往前找最后一个 todo 条目：不加载整份会话，大文件也只读最后一段（任务面板用）
import { open, type FileHandle } from 'node:fs/promises'
import type { Item } from '@pixelsky/protocol'

export type TodoItem = Extract<Item, { kind: 'todo' }>

const CHUNK = 256 * 1024
const NEEDLE = Buffer.from('"kind":"todo"')
const NEWLINE = 0x0a
/** 增量扫描前用来确认「旧的那一段没被改写过」的字节数 */
const PROBE = 64

/** 一次扫描的结果，连同下次增量扫描需要的位置 */
interface TodoScan {
  todo: TodoItem | null
  size: number
  mtimeMs: number
  /** 扫描时最后一个换行之后的位置：下次从这里接着扫（末尾可能是还没写完的半行） */
  lineStart: number
  /** lineStart 之前的最后 PROBE 个字节；items.jsonl 被回退重写时它对不上，就整份重扫 */
  probe: Buffer
}

/**
 * 记录里最后一个 todo 条目；没有或文件不存在时 null。
 * 条目是 JSON.stringify 写的，kind 字段一定以 "kind":"todo" 的形式出现，先在字节上预过滤，含有才 JSON.parse。
 * 没等到完成的条目按读出整份会话时的规则标成已中断（store.loadItems）
 */
export async function lastTodoInFile(file: string): Promise<TodoItem | null> {
  return (await scanTodo(file))?.todo ?? null
}

/**
 * 按文件缓存 lastTodoInFile 的结果。items.jsonl 只追加：没变过（大小和修改时间都一样）直接用缓存，
 * 变大了只扫新增的一段，找不到就沿用缓存里的；变小、同大小改过或被回退重写（旧的那一段对不上）时整份重扫。
 * 任务面板每次刷新都会问一遍所有会话，没有 todo 的会话不能每次都把整份文件从尾读到头
 */
export class LastTodoCache {
  private readonly entries = new Map<string, TodoScan>()

  async get(file: string): Promise<TodoItem | null> {
    const scan = await scanTodo(file, this.entries.get(file))
    if (scan) this.entries.set(file, scan)
    else this.entries.delete(file)
    return scan?.todo ?? null
  }
}

async function scanTodo(file: string, prev?: TodoScan): Promise<TodoScan | null> {
  let handle: FileHandle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const { size, mtimeMs } = await handle.stat()
    if (prev && prev.size === size && prev.mtimeMs === mtimeMs) return prev
    const base = prev && size > prev.size && prev.lineStart > 0 && (await sameBefore(handle, prev)) ? prev : null
    const { todo, lineStart } = await scanBack(handle, base?.lineStart ?? 0, size)
    return {
      todo: todo ?? base?.todo ?? null,
      size,
      mtimeMs,
      lineStart,
      probe: await readRange(handle, Math.max(0, lineStart - PROBE), lineStart),
    }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readRange(handle: FileHandle, start: number, end: number): Promise<Buffer> {
  const buf = Buffer.alloc(end - start)
  const { bytesRead } = await handle.read(buf, 0, buf.length, start)
  return buf.subarray(0, bytesRead)
}

async function sameBefore(handle: FileHandle, prev: TodoScan): Promise<boolean> {
  return (await readRange(handle, prev.lineStart - prev.probe.length, prev.lineStart)).equals(prev.probe)
}

/** 从 size 往前扫 [from, size)（from 必须是一行的开头），找到最后一个 todo；同时记下最后一个换行之后的位置 */
async function scanBack(
  handle: FileHandle,
  from: number,
  size: number,
): Promise<{ todo: TodoItem | null; lineStart: number }> {
  let end = size
  let lineStart: number | undefined
  // 跨块的那一行已经读到的后半段（按文件顺序）；超长行（图片）不在每读一块时重新拼接
  let pieces: Buffer[] = []
  while (end > from) {
    const start = Math.max(from, end - CHUNK)
    const data = await readRange(handle, start, end)
    end = start
    const i = data.lastIndexOf(NEWLINE)
    if (i < 0) {
      // 整块都在同一行里面
      pieces.unshift(data)
      continue
    }
    lineStart ??= start + i + 1
    // 最后一个换行之后的部分接上后半段，就是跨块的那一行
    const tail = data.subarray(i + 1)
    const crossing = parse(pieces.length ? Buffer.concat([tail, ...pieces]) : tail)
    if (crossing) return { todo: crossing, lineStart }
    const body = data.subarray(0, i)
    // 整块里没有 todo 标记就不用逐行切开
    if (!body.includes(NEEDLE)) {
      const j = body.indexOf(NEWLINE)
      pieces = [j < 0 ? body : body.subarray(0, j)]
      continue
    }
    let to = body.length
    while (to > 0) {
      const j = body.lastIndexOf(NEWLINE, to - 1)
      if (j < 0) break
      const found = parse(body.subarray(j + 1, to))
      if (found) return { todo: found, lineStart }
      to = j
    }
    // 剩下的是这一块开头那一行的后半段，它的前半段在更早的块里
    pieces = [body.subarray(0, to)]
  }
  // 读到 from 了：剩下的就是第一行
  return { todo: parse(Buffer.concat(pieces)), lineStart: lineStart ?? from }
}

function parse(line: Buffer): TodoItem | null {
  if (!line.includes(NEEDLE)) return null
  try {
    const item = JSON.parse(line.toString('utf8')) as Item
    if (item && item.kind === 'todo' && typeof item.id === 'string')
      return item.status === 'running' ? { ...item, status: 'interrupted' } : item
  } catch {
    // 跳过写坏的行（例如写到一半断电）
  }
  return null
}
