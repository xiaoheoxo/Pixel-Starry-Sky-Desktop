import type { AgentAvatar, AgentAvatarStyle } from '../types/channels'

// AI 成员头像的清单和校验（docs/ui/channels-side-panels.md §3.2）；主进程存之前、界面画之前都用这一份

export const AVATAR_STYLES: readonly AgentAvatarStyle[] = ['engine', 'letter', 'gradient', 'icon', 'emoji', 'pixel']
export const AVATAR_COLORS = ['orange', 'blue', 'purple', 'green', 'teal', 'pink', 'yellow', 'gray'] as const
export const AVATAR_ICONS = [
  'code',
  'eye',
  'rocket',
  'terminal',
  'bug',
  'shield',
  'chart',
  'pen',
  'palette',
  'book',
  'box',
  'sparkles',
] as const
export const AVATAR_EMOJIS = ['🦊', '🦉', '🚀', '🐼', '🐙', '🐳', '🤖', '🧪', '🎨', '🔍', '📦', '🔧'] as const
/** pixel 样式可选的图案张数（seed 1..N） */
export const AVATAR_PATTERNS = 6

const inList = (list: readonly string[], v: unknown): v is string => typeof v === 'string' && list.includes(v)

/** 信任边界上的校验：style / color 不对返回 null；其余字段不合法的丢掉（合法的都留着，切回那个样式时还记得） */
export function cleanAvatar(raw: unknown): AgentAvatar | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!inList(AVATAR_STYLES, r.style) || !inList(AVATAR_COLORS, r.color)) return null
  const out: AgentAvatar = { style: r.style as AgentAvatarStyle, color: r.color }
  if (typeof r.text === 'string') {
    const text = [...r.text.trim()].slice(0, 2).join('')
    if (text) out.text = text
  }
  if (inList(AVATAR_ICONS, r.icon)) out.icon = r.icon
  if (inList(AVATAR_EMOJIS, r.emoji)) out.emoji = r.emoji
  if (typeof r.seed === 'number' && Number.isInteger(r.seed) && r.seed >= 1 && r.seed <= AVATAR_PATTERNS)
    out.seed = r.seed
  return out
}

/** FNV-1a（按码点） */
function hash(s: string): number {
  let h = 2166136261
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0
  return h
}

/** 新成员的默认头像：同名同结果 */
export function defaultAvatar(name: string): AgentAvatar {
  const h = hash(name)
  return {
    style: 'icon',
    color: AVATAR_COLORS[h % AVATAR_COLORS.length],
    icon: AVATAR_ICONS[Math.floor(h / AVATAR_COLORS.length) % AVATAR_ICONS.length],
  }
}

/** 像素图案：5×5 按行，左右对称；算法照样稿（FNV-1a 做种子，xorshift 出随机数），全空时点亮中心 */
export function pixelCells(name: string, seed: number): boolean[] {
  let h = hash(`${name}#${seed}`)
  const next = (): number => {
    if (!h) h = 0x9e3779b9
    h ^= h << 13
    h >>>= 0
    h ^= h >>> 17
    h ^= h << 5
    h >>>= 0
    return h / 4294967296
  }
  const cells = new Array<boolean>(25).fill(false)
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      if (next() < 0.5) continue
      cells[y * 5 + x] = true
      cells[y * 5 + 4 - x] = true
    }
  if (!cells.includes(true)) cells[12] = true
  return cells
}
