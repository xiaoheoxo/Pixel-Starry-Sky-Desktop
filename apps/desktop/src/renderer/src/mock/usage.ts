// 演示模式的用量记录：按固定种子生成近一年的数据（每次打开都一样），只在 pnpm dev:demo 时使用。
import type { UsageRecord } from '@/features/usage/types'

/** 固定种子的伪随机数（mulberry32） */
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

// 每百万 token 的价格（美元），只用来让演示费用看起来合理
const PRICE: Record<string, { input: number; cacheRead: number; cacheWrite: number; output: number }> = {
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-haiku-4-5': { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
}

const SESSIONS: Array<{ title: string; project: string }> = [
  { title: 'hhh', project: 'pixel-web' },
  { title: '重构网页版工作台为 Codex 式布局', project: 'pixel-web' },
  { title: '设置页迁移到新的表单组件', project: 'pixel-web' },
  { title: '把云主机配置引导改成两步', project: 'pixel-web' },
  { title: '修复云主机断线后仍显示已连接', project: 'pixel-desktop' },
  { title: '频道话题支持引用回复', project: 'pixel-channel' },
  { title: '整理 10 月更新日志', project: 'docs-site' },
  { title: '调研多智能体协作的交互', project: 'research-notes' },
]

const DAY = 24 * 60 * 60 * 1000

/** 一次很长的 Opus 任务：40 轮、缓存读占绝大部分 */
function spike(start: number): UsageRecord[] {
  return Array.from({ length: 40 }, (_, k) => {
    const startedAt = start + k * 90_000
    const input = 1800
    const cacheRead = 260_000 + (k % 7) * 9000
    const cacheWrite = 3000
    const output = 2400
    const p = PRICE['claude-opus-5-5']
    return {
      v: 1,
      id: `demo-s1:spike-${k}:claude-opus-5-5`,
      sessionId: 'demo-s1',
      turnId: `spike-${k}`,
      startedAt,
      endedAt: startedAt + 80_000,
      durationMs: 80_000,
      sessionTitle: SESSIONS[1].title,
      project: SESSIONS[1].project,
      engine: 'claude',
      model: 'claude-opus-5-5',
      route: 'cli',
      requests: 6,
      input,
      cacheRead,
      cacheWrite,
      output,
      costUsd: (input * p.input + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite + output * p.output) / 1_000_000,
      outcome: 'completed',
      genMs: 34_000,
      genOutput: output,
      firstTokenMs: 1400,
    }
  })
}

export function demoUsageRecords(now: number): UsageRecord[] {
  const r = rng(20261006)
  const int = (min: number, max: number) => Math.floor(min + r() * (max - min + 1))
  const records: UsageRecord[] = []
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)

  for (let day = 370; day >= 0; day--) {
    const date = today.getTime() - day * DAY
    const weekday = new Date(date).getDay()
    const weekend = weekday === 0 || weekday === 6
    // 越近的日子用得越多，周末少一些
    const turns = Math.max(0, Math.round((weekend ? 3 : 9) * (0.3 + 0.7 * (1 - day / 371)) + int(-3, 4)))
    // 两天前有一次长任务：缓存读特别多，其他天在同一纵轴上几乎贴底（docs/ui/usage-chart-style.md §5）
    if (day === 2) records.push(...spike(date + 15 * 3600_000))
    for (let k = 0; k < turns; k++) {
      const startedAt = date + int(9, 22) * 3600_000 + int(0, 59) * 60_000
      if (startedAt > now) continue
      const durationMs = int(6, 240) * 1000
      const endedAt = Math.min(startedAt + durationMs, now)
      const session = SESSIONS[int(0, SESSIONS.length - 1)]
      const sessionId = `demo-s${SESSIONS.indexOf(session)}`
      const turnId = `t${day}-${k}`
      const outcome = r() < 0.04 ? 'failed' : r() < 0.06 ? 'interrupted' : 'completed'
      const codex = r() < 0.08
      const models = codex
        ? ['gpt-5.5']
        : [r() < 0.15 ? 'claude-sonnet-5-5' : 'claude-opus-5-5', ...(r() < 0.3 ? ['claude-haiku-4-5'] : [])]
      for (const model of models) {
        const sub = model === 'claude-haiku-4-5'
        const input = int(300, sub ? 2000 : 6000)
        const cacheRead = sub ? int(2000, 20000) : int(15000, 140000)
        const cacheWrite = int(0, sub ? 2000 : 9000)
        const output = int(200, sub ? 1500 : 7000)
        const p = PRICE[model]
        const costUsd = p
          ? (input * p.input + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite + output * p.output) / 1_000_000
          : null
        records.push({
          v: 1,
          id: `${sessionId}:${turnId}:${model}`,
          sessionId,
          turnId,
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          sessionTitle: session.title,
          project: session.project,
          engine: codex ? 'codex' : 'claude',
          model,
          route: 'cli',
          requests: int(1, sub ? 4 : 12),
          input,
          cacheRead,
          cacheWrite,
          output,
          costUsd,
          outcome,
          ...(day < 60 && !codex
            ? { genMs: Math.round((output / int(sub ? 120 : 45, sub ? 190 : 110)) * 1000), genOutput: output }
            : {}),
          ...(day < 60 && model === models[0] ? { firstTokenMs: int(700, 6000) } : {}),
        })
      }
    }
  }
  records.push(...noCost(today.getTime() - DAY, now))
  return records
}

/** 几条没有费用的记录，演示「N 条没有费用」和费用情况分布（GitHub #22）：自定义 API 对不上价格、平台账单没对上 */
function noCost(date: number, now: number): UsageRecord[] {
  const base = (k: number, model: string, route: UsageRecord['route']) => {
    const startedAt = Math.min(date + (14 + k) * 3600_000, now - 60_000)
    return {
      v: 1 as const,
      id: `demo-s7:nc-${k}:${model}`,
      sessionId: 'demo-s7',
      turnId: `nc-${k}`,
      startedAt,
      endedAt: startedAt + 40_000,
      durationMs: 40_000,
      sessionTitle: SESSIONS[7].title,
      project: SESSIONS[7].project,
      engine: 'claude',
      model,
      route,
      requests: 3,
      input: 1200 + k * 300,
      cacheRead: 18_000,
      cacheWrite: 2000,
      output: 900,
      costUsd: null,
      outcome: 'completed' as const,
    }
  }
  return [
    { ...base(0, 'anthropic/claude-v4.1flash', 'api-key'), costSource: 'estimate' },
    { ...base(1, 'anthropic/claude-v4.1flash', 'api-key'), costSource: 'estimate' },
    { ...base(2, 'claude-sonnet-5-5', 'pixelsky'), costSource: 'unavailable' },
  ]
}
