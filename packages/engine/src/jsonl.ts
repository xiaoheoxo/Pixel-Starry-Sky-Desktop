// 子进程的标准输出：每行一条 JSON
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'

/**
 * 按 \n 切行的增量切分器。没有换行的块先攒进数组，只在新来的块里找换行，找到时才拼成一行：
 * 单行很大（几十 MB）时不会每来一块就把整个缓冲拼接 / 摊平一遍（审查报告 D12）
 */
export class LineSplitter {
  private parts: string[] = []
  private len = 0
  /** 还没凑成一行的已收字符数（用来做单行上限检查） */
  get pending(): number {
    return this.len
  }
  /** 喂入一块文本，返回这一块里凑齐的整行（不含 \n） */
  push(text: string): string[] {
    const lines: string[] = []
    let rest = text
    for (;;) {
      const i = rest.indexOf('\n')
      if (i < 0) {
        if (rest) {
          this.parts.push(rest)
          this.len += rest.length
        }
        return lines
      }
      const head = rest.slice(0, i)
      lines.push(this.parts.length ? this.parts.join('') + head : head)
      this.parts = []
      this.len = 0
      rest = rest.slice(i + 1)
    }
  }
  /** 流结束：取出剩下没有换行的部分 */
  end(): string {
    const tail = this.parts.join('')
    this.parts = []
    this.len = 0
    return tail
  }
}

/** 按行读取流；坏掉的行（不是 JSON）交给 onBadLine，不会中断后面的行 */
export function readJsonLines(
  stream: Readable,
  onMessage: (msg: Record<string, unknown>) => void,
  onBadLine?: (line: string) => void,
): void {
  const decoder = new StringDecoder('utf8')
  const splitter = new LineSplitter()
  const flush = (line: string): void => {
    const t = line.trim()
    if (!t) return
    let msg: unknown
    try {
      msg = JSON.parse(t)
    } catch {
      onBadLine?.(t)
      return
    }
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) onMessage(msg as Record<string, unknown>)
    else onBadLine?.(t)
  }
  stream.on('data', (chunk: Buffer) => {
    for (const line of splitter.push(decoder.write(chunk))) flush(line)
  })
  stream.on('end', () => {
    for (const line of splitter.push(decoder.end())) flush(line)
    const tail = splitter.end()
    if (tail) flush(tail)
  })
}

/** 只保留最后 max 个字符（用来留 stderr 的结尾，出错时给用户看） */
export class TailBuffer {
  private text = ''
  constructor(private readonly max = 4000) {}
  push(chunk: string): void {
    this.text += chunk
    if (this.text.length > this.max) this.text = this.text.slice(-this.max)
  }
  toString(): string {
    return this.text
  }
}
