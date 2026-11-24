// 日志去重：同样的内容一分钟内只写第一遍，过后补一句又出现了几次
const WINDOW_MS = 60_000
/** 补的那句只带开头，够认出是哪条 */
const HEAD = 120

export class RepeatFilter {
  private readonly seen = new Map<string, number>()

  constructor(private readonly windowMs = WINDOW_MS) {}

  write(text: string, write: (line: string) => void): void {
    const count = this.seen.get(text)
    if (count !== undefined) {
      this.seen.set(text, count + 1)
      return
    }
    this.seen.set(text, 0)
    write(text)
    setTimeout(() => {
      const more = this.seen.get(text) ?? 0
      this.seen.delete(text)
      if (more) write(`同样的内容又出现 ${more} 次：${text.slice(0, HEAD)}`)
    }, this.windowMs).unref()
  }
}
