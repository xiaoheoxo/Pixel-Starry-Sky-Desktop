// Claude 订阅的倍数档位（Max 5x / 20x、Team 5x；docs/ui/plan-tier-badges.md §2）。
// claude auth status、额度接口、.claude.json 都只有 subscriptionType，倍数只在 Claude Code 登录时写进凭据文件的
// claudeAiOauth.rateLimitTier。用户同意（2026-10-21）只取 rateLimitTier、seatTier 两个字段：在读到的文本上按字段名匹配，
// 不解析成对象，读完就丢，令牌不保存、不记日志、不上传。macOS 的凭据在钥匙串里，不读。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeRealDir } from './accounts'

export interface ClaudeTier {
  /** 如 default_claude_max_20x */
  rateLimitTier: string | null
  /** 如 premium（2.1.303 的凭据文件里没有，留着以后的版本） */
  seatTier: string | null
}

/** 只认 "字段名": "短的标识"：值限 64 个字母数字和 _-.，不会匹配到令牌那种长串 */
const field = (text: string, name: string): string | null =>
  new RegExp(`"${name}"\\s*:\\s*"([A-Za-z0-9_.-]{1,64})"`).exec(text)?.[1] ?? null

/** 从凭据文件文本里取档位（纯函数，测试用） */
export function tierFromCredentialsText(text: string): ClaudeTier | null {
  const rateLimitTier = field(text, 'rateLimitTier')
  const seatTier = field(text, 'seatTier')
  return rateLimitTier || seatTier ? { rateLimitTier, seatTier } : null
}

/** 某个配置目录（原来的 ~/.claude 或账号目录）里的档位；macOS、没有文件、读不了都为 null */
export function readClaudeTier(configDir: string, platform: NodeJS.Platform = process.platform): ClaudeTier | null {
  if (platform === 'darwin') return null
  let text: string
  try {
    text = readFileSync(join(configDir, '.credentials.json'), 'utf8')
  } catch {
    return null
  }
  return tierFromCredentialsText(text)
}

/** 倍数：default_claude_max_20x → 20；Team 高级席位 → 5；认不出为 null */
export function tierMultiplier(tier: ClaudeTier | null): number | null {
  const m = /(\d{1,3})x$/i.exec(tier?.rateLimitTier ?? '')
  if (m) return Number(m[1])
  if (tier?.seatTier && /premium/i.test(tier.seatTier)) return 5
  return null
}

/** 套餐值并上倍数：max + 20x → max_20x，team + 5x → team_5x；其余原样（界面按套餐值显示，plans.ts） */
export function claudePlanWithTier(plan: string | null | undefined, tier: ClaudeTier | null): string | null {
  const p = plan?.trim().toLowerCase()
  if (!p) return plan ?? null
  const n = tierMultiplier(tier)
  if (n && (p === 'max' || p === 'team')) return `${p}_${n}x`
  return plan ?? null
}

/** 用这个环境（原来的账号或某个添加的账号）的 Claude Code 的套餐值并上倍数 */
export const claudePlanFor = (plan: string | null | undefined, env: NodeJS.ProcessEnv): string | null =>
  claudePlanWithTier(plan, readClaudeTier(claudeRealDir(env)))
