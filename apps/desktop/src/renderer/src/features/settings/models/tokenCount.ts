// 上下文长度的输入（docs/ui/custom-api.md）：可以写 200000、200,000、200k、1m、1.5M
/** 和主进程保存时的校验一致 */
export const MIN_TOKENS = 1000
export const MAX_TOKENS = 100_000_000

const UNIT: Record<string, number> = { '': 1, k: 1_000, m: 1_000_000 }

/** 空 → null；认不出或超出范围 → undefined */
export function parseTokens(input: string): number | null | undefined {
  const text = input
    .trim()
    .replace(/[,_\s]/g, '')
    .toLowerCase()
  if (!text) return null
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(text)
  if (!m) return undefined
  const n = Math.round(Number(m[1]) * UNIT[m[2]])
  return n >= MIN_TOKENS && n <= MAX_TOKENS ? n : undefined
}

/** 输入框里的文字和当前值是否对不上（认不出的文字也算）：用来判断关闭前有没有没交出去的草稿 */
export function isTokenDraftDirty(text: string, value: number | null): boolean {
  return parseTokens(text) !== value
}

/** 显示：整百万写 1M、整千写 200K，其他原样 */
export function formatTokens(n: number): string {
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`
  if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}M`
  if (n % 1_000 === 0) return `${n / 1_000}K`
  return String(n)
}
