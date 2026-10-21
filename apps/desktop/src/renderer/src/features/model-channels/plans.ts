// 订阅套餐的显示名和档位色（docs/ui/plan-tier-badges.md §1）。
// Claude 的倍数由引擎并进套餐值（max_20x、team_5x，packages/engine/src/claude/tier.ts）；ChatGPT 的直接按 Codex 的 planType。
// 两家都有 pro 但不是一个档（Claude Pro 是标准档，ChatGPT pro 是 Pro 10x），所以要带上是哪家。

import type { PlanBadgeTone } from '@/ui'

export type PlanProvider = 'claude' | 'chatgpt'
/** free 灰、std 墨绿、high 琥珀、top 琥珀渐变（最高档）、team 蓝灰 */
export type PlanTone = PlanBadgeTone
export interface PlanInfo {
  label: string
  tone: PlanTone
}

const capital = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

function claudePlan(p: string): PlanInfo {
  const tier = /^(max|team)_(\d{1,3})x$/.exec(p)
  if (tier) {
    const n = Number(tier[2])
    if (tier[1] === 'team') return { label: `Team ${n}x`, tone: 'team' }
    return { label: `Max ${n}x`, tone: n >= 20 ? 'top' : 'high' }
  }
  if (p === 'free') return { label: 'Free', tone: 'free' }
  if (p === 'pro') return { label: 'Pro', tone: 'std' }
  if (p === 'max') return { label: 'Max', tone: 'high' }
  if (p === 'team') return { label: 'Team', tone: 'team' }
  if (p === 'enterprise') return { label: 'Enterprise', tone: 'team' }
  return { label: capital(p), tone: 'std' }
}

/** ChatGPT 的 planType（codex 0.163 的枚举）；倍数对应用户确认过（2026-10-21） */
function chatgptPlan(p: string): PlanInfo {
  if (p === 'free' || p === 'go') return { label: capital(p), tone: 'free' }
  if (p === 'plus') return { label: 'Plus', tone: 'std' }
  if (p === 'prolite') return { label: 'Pro 5x', tone: 'high' }
  if (p === 'pro') return { label: 'Pro 10x', tone: 'high' }
  if (p === 'promax') return { label: 'Pro 25x', tone: 'top' }
  if (p === 'team') return { label: 'Team', tone: 'team' }
  if (p === 'self_serve_business_prolite') return { label: 'Team 5x', tone: 'team' }
  if (p === 'business' || p.startsWith('self_serve_business')) return { label: 'Business', tone: 'team' }
  if (p === 'ent26' || p.startsWith('enterprise')) return { label: 'Enterprise', tone: 'team' }
  if (p.startsWith('edu')) return { label: 'Edu', tone: 'std' }
  return { label: capital(p), tone: 'std' }
}

/** 套餐的显示名和档位；没有套餐、unknown 为 null */
export function planInfo(provider: PlanProvider, plan: string | null | undefined): PlanInfo | null {
  const p = plan?.trim().toLowerCase()
  if (!p || p === 'unknown') return null
  return provider === 'chatgpt' ? chatgptPlan(p) : claudePlan(p)
}

/** 引擎 → 哪家的套餐（codex 是 ChatGPT 账号） */
export const planProviderOf = (engine: string): PlanProvider => (engine === 'codex' ? 'chatgpt' : 'claude')
