// 演示模式的账号调用记录：固定种子生成近 90 天的数据，只用来搭界面（docs/ui/usage.md §9.4）。
import type { CallClient, RemoteCall } from '@/features/usage/remote-types'

function rng(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 每百万 token 的价格（只用来让演示扣费看起来合理，不代表真实价目）
const PRICE: Record<string, { input: number; cacheRead: number; cacheWrite: number; output: number }> = {
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-haiku-4-5': { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  'gpt-5.5': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
}

const CLIENTS: Array<[CallClient, number]> = [
  ['pixelsky-desktop', 0.55],
  ['jucode-cli', 0.25],
  ['api', 0.08],
  ['unknown', 0.12],
]

function pickClient(r: number): CallClient {
  let sum = 0
  for (const [c, w] of CLIENTS) {
    sum += w
    if (r < sum) return c
  }
  return 'unknown'
}

const DAY = 24 * 60 * 60 * 1000

/** 生成 1200 条左右的演示调用记录，每次生成内容相同 */
export function demoRemoteCalls(now: number): RemoteCall[] {
  const r = rng(31415926)
  const int = (min: number, max: number) => Math.floor(min + r() * (max - min + 1))
  const models = Object.keys(PRICE)
  const calls: RemoteCall[] = []
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)

  for (let day = 370; day >= 0; day--) {
    const date = today.getTime() - day * DAY
    const weekday = new Date(date).getDay()
    const weekend = weekday === 0 || weekday === 6
    const n = Math.max(0, Math.round((weekend ? 6 : 16) * (0.3 + 0.7 * (1 - day / 371)) + int(-3, 3)))
    for (let k = 0; k < n; k++) {
      const createdAt = date + int(8, 23) * 3600_000 + int(0, 3599_000)
      if (createdAt > now) continue
      const client = pickClient(r())
      const model = models[int(0, models.length - 1)]
      const failing = r()
      const status = failing < 0.03 ? 'error' : failing < 0.045 ? 'rate_limited' : 'success'
      const isError = status !== 'success'
      const input = int(200, 3000)
      const cacheRead = isError ? 0 : int(4000, 80000)
      const cacheWrite = int(0, isError ? 500 : 6000)
      const output = isError ? int(0, 150) : int(100, 3000)
      const p = PRICE[model]
      const costUsd = isError
        ? null
        : (input * p.input + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite + output * p.output) / 1_000_000
      const firstTokenMs = r() < 0.15 ? null : int(300, 2600)
      calls.push({
        id: `req_demo_${day}_${k}_${int(0, 9999)}`,
        createdAt,
        model,
        client,
        device: client === 'pixelsky-desktop' ? (r() < 0.85 ? '这台电脑' : '笔电') : null,
        keyName: r() < 0.8 ? 'default' : '备用 Key',
        stream: r() < 0.92,
        status,
        httpStatus: status === 'success' ? 200 : status === 'error' ? 500 : 429,
        input,
        cacheRead,
        cacheWrite,
        output,
        costUsd,
        firstTokenMs,
        durationMs: (firstTokenMs ?? int(400, 1200)) + int(500, isError ? 1500 : 18000),
        turnId: client === 'pixelsky-desktop' && r() < 0.4 ? `demo-t${day}-${k}` : null,
      })
    }
  }
  calls.sort((a, b) => b.createdAt - a.createdAt)
  return calls
}
