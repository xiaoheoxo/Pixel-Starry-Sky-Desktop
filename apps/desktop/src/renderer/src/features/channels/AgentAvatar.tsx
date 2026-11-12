import {
  BookOpen,
  Box,
  Bug,
  ChartColumn,
  Code,
  Eye,
  Palette,
  PenLine,
  Rocket,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { EngineId } from '@pixelsky/protocol'
import { cn, EngineIcon } from '@/ui'
import type { AgentAvatar as Avatar } from '../../../../shared/types/channels'
import { pixelCells } from '../../../../shared/channels/avatar'

export const AVATAR_ICON: Record<string, LucideIcon> = {
  code: Code,
  eye: Eye,
  rocket: Rocket,
  terminal: SquareTerminal,
  bug: Bug,
  shield: ShieldCheck,
  chart: ChartColumn,
  pen: PenLine,
  palette: Palette,
  book: BookOpen,
  box: Box,
  sparkles: Sparkles,
}

const tint = (color: string) => `color-mix(in srgb, var(--avatar-${color}) 20%, transparent)`

/** 自选头像（docs/ui/channels-side-panels.md §4.1）；style 是 engine 的由 MemberAvatar 照旧画 */
export function AgentAvatarFace({
  avatar,
  name,
  engine,
  size,
  className,
}: {
  avatar: Avatar
  name: string
  engine: EngineId
  size: number
  className?: string
}) {
  const color = `var(--avatar-${avatar.color})`
  const box = 'relative inline-flex shrink-0 items-center justify-center rounded-md'
  let face: ReactNode
  let background: string = tint(avatar.color)
  if (avatar.style === 'letter' || avatar.style === 'gradient') {
    const text = avatar.text || [...name.trim()][0] || '?'
    background =
      avatar.style === 'letter'
        ? color
        : `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 62%, var(--avatar-on)))`
    face = (
      <span
        className="leading-none font-semibold"
        style={{ color: 'var(--avatar-on)', fontSize: Math.round(size * ([...text].length > 1 ? 0.38 : 0.5)) }}
      >
        {text}
      </span>
    )
  } else if (avatar.style === 'emoji') {
    face = <span style={{ fontSize: Math.round(size * 0.55), lineHeight: 1 }}>{avatar.emoji ?? '🤖'}</span>
  } else if (avatar.style === 'pixel') {
    const cells = pixelCells(name, avatar.seed ?? 1)
    face = (
      <svg aria-hidden viewBox="0 0 5 5" width={size * 0.64} height={size * 0.64} shapeRendering="crispEdges">
        {cells.map((on, i) => on && <rect key={i} x={i % 5} y={Math.floor(i / 5)} width={1} height={1} fill={color} />)}
      </svg>
    )
  } else {
    const Icon = AVATAR_ICON[avatar.icon ?? ''] ?? Code
    face = <Icon aria-hidden size={Math.round(size * 0.55)} strokeWidth={1.9} style={{ color }} />
  }
  return (
    <span className={cn(box, className)} style={{ width: size, height: size, background }}>
      {face}
      {size >= 24 && (
        <span
          aria-hidden
          className="absolute -right-1 -bottom-1 inline-flex size-[11px] items-center justify-center rounded-full bg-surface ring-2 ring-surface"
        >
          <EngineIcon engine={engine} size={9} />
        </span>
      )}
    </span>
  )
}
