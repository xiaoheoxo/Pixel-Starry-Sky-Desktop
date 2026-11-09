// Token 速度和首字（docs/ui/usage-learn.md §1.1）：只量模型真正在输出的时间，不含等待和跑工具。
// 一轮里可能有很多次请求，每次请求一段；同一个模型的累加起来。
import { SPEED_MIN_GEN_MS, type ModelTurnUsage } from '@pixelsky/protocol'

const baseModel = (model: string): string => model.replace(/\[[^\]]*\]$/, '')

/** 引擎报的用量里这个模型的那一条：名字可能带 [1m] 这样的后缀，而发给上游和结算用的名字不带 */
export function usageOfModel(models: Record<string, ModelTurnUsage>, model: string): ModelTurnUsage | undefined {
  return models[model] ?? Object.entries(models).find(([k]) => baseModel(k) === baseModel(model))?.[1]
}

export class GenTimer {
  private open: { startedAt: number; lastAt: number; model: string; output: number } | null = null
  private spans = new Map<string, { ms: number; output: number }>()
  private firstAt: number | null = null
  private firstModel: string | null = null

  constructor(private readonly now: () => number = Date.now) {}

  reset(): void {
    this.open = null
    this.spans.clear()
    this.firstAt = null
    this.firstModel = null
  }

  /** 一次请求开始输出；上一段没收尾的先收尾 */
  begin(): void {
    this.flush()
    const at = this.now()
    this.open = { startedAt: at, lastAt: at, model: '', output: 0 }
  }

  get running(): boolean {
    return this.open !== null
  }

  /** 这一轮第一次收到内容 */
  first(): void {
    this.firstAt ??= this.now()
  }

  /** 这次请求到现在为止的输出量（累计值，不是增量）；可以报多次 */
  update(model: string, output: number): void {
    if (!this.open) return
    this.open.model = model
    this.open.output = output
    this.open.lastAt = this.now()
    this.firstModel ||= model
  }

  /** 这次请求结束 */
  flush(): void {
    const span = this.open
    this.open = null
    if (!span || span.output <= 0 || !span.model) return
    const ms = span.lastAt - span.startedAt
    if (ms < SPEED_MIN_GEN_MS) return
    const sum = this.spans.get(span.model) ?? { ms: 0, output: 0 }
    sum.ms += ms
    sum.output += span.output
    this.spans.set(span.model, sum)
  }

  /** 把量到的写进这一轮的用量 */
  apply(models: Record<string, ModelTurnUsage>, startedAt: number): void {
    this.flush()
    for (const [model, span] of this.spans) {
      const m = usageOfModel(models, model)
      if (!m) continue
      m.genMs = span.ms
      m.genOutput = span.output
    }
    if (this.firstAt !== null && this.firstModel) {
      const m = usageOfModel(models, this.firstModel)
      if (m) m.firstTokenMs = Math.max(0, this.firstAt - startedAt)
    }
  }
}
