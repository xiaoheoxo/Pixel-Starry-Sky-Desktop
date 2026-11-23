// 认出自己切换权限档的回声（docs/ui/plan-mode-split.md §10、§11）：Claude、agy 都是先回应答、再单独报一次现在的模式，
// 可能晚于下一次切换，不能当成引擎自己换了模式

/** 应答之后最多等回声多久：没报的话就不等了，免得把引擎之后自己换的模式当成回声 */
const ECHO_MS = 1000

export class ModeEchoes {
  /** 发出去、回声还没到的切换，按顺序 */
  private list: { mode: string; until: number }[] = []

  /** 发一次切换：收到应答、失败时各调一个 */
  sent(mode: string): { acked(): void; failed(): void } {
    const echo = { mode, until: Infinity }
    this.list.push(echo)
    return {
      acked: () => void (echo.until = Date.now() + ECHO_MS),
      failed: () => void (this.list = this.list.filter(e => e !== echo)),
    }
  }

  /** 引擎报了 mode：是自己某次切换的回声就消掉（连同更早没等到的），返回 true */
  take(mode: string): boolean {
    const i = this.waiting().findIndex(e => e.mode === mode)
    if (i < 0) return false
    this.list.splice(0, i + 1)
    return true
  }

  get empty(): boolean {
    return this.waiting().length === 0
  }

  reset(): void {
    this.list = []
  }

  private waiting(): { mode: string; until: number }[] {
    return (this.list = this.list.filter(e => e.until > Date.now()))
  }
}
