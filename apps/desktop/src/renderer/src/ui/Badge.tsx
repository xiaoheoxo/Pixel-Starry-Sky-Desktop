import { useI18n } from '@/i18n/I18nProvider'
import { cn } from './cn'

/** 蓝色数字角标（图标栏的 3、5） */
export function CountBadge({
  count,
  max,
  tone = 'accent',
  className,
}: {
  count: number
  /** 超过这个数显示「max+」（例如 9 → 9+） */
  max?: number
  /** notify = 红色提醒（反馈有新回复） */
  tone?: 'accent' | 'notify'
  className?: string
}) {
  useI18n()
  return (
    <span
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold',
        tone === 'notify' ? 'bg-notify text-white' : 'bg-accent text-accent-on',
        className,
      )}
    >
      {max !== undefined && count > max ? `${max}+` : count}
    </span>
  )
}

type DotTone = 'accent' | 'notify' | 'success' | 'muted'
const DOT_COLORS: Record<DotTone, string> = {
  accent: 'bg-accent',
  notify: 'bg-notify',
  success: 'bg-success',
  muted: 'bg-fg-faint',
}

/** 小圆点：accent = 蓝色未读，notify = 红色提醒 */
export function Dot({ tone = 'accent', size = 7, className }: { tone?: DotTone; size?: number; className?: string }) {
  useI18n()
  return (
    <span
      className={cn('inline-block shrink-0 rounded-full', DOT_COLORS[tone], className)}
      style={{ width: size, height: size }}
    />
  )
}

/** 套餐档位：free 灰、std 墨绿、high 琥珀、top 琥珀渐变（最高档）、team 蓝灰（docs/ui/plan-tier-badges.md） */
export type PlanBadgeTone = 'free' | 'std' | 'high' | 'top' | 'team'
const PLAN_TONES: Record<PlanBadgeTone, string> = {
  free: 'bg-selected text-fg-secondary',
  std: 'bg-accent-soft text-accent-fg',
  high: 'bg-warn/15 text-warn-fg',
  top: 'bg-[linear-gradient(100deg,var(--warn),color-mix(in_srgb,var(--warn)_72%,var(--danger)))] text-surface',
  team: 'bg-status-seen/12 text-status-seen',
}

/** 套餐标签（Max 20x、Pro 5x…）：一个胶囊，按档位上色 */
export function PlanBadge({ label, tone, className }: { label: string; tone: PlanBadgeTone; className?: string }) {
  return (
    <span
      data-plan-tone={tone}
      className={cn(
        'shrink-0 rounded-[5px] px-1.5 text-label leading-[18px] font-medium whitespace-nowrap tabular-nums',
        PLAN_TONES[tone],
        className,
      )}
    >
      {label}
    </span>
  )
}
