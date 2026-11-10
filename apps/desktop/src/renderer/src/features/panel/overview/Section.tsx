// 概况里一个分组的外框：标题行点了折叠，折叠和隐藏记在 overviewPrefs（样稿 .sec）；分组里共用的小按钮、进度条、数字格也在这
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { cn } from '@/ui'
import type { QuotaLevel } from '@/features/session/quota/quotaModel'
import { overviewPrefs, useOverviewPrefs } from './overviewPrefs'

export function Section({
  id,
  icon: Icon,
  title,
  summary,
  quietOpen,
  attention,
  children,
}: {
  id: string
  icon: LucideIcon
  title: string
  /** 标题行右边的一句摘要，折叠时也看得到 */
  summary?: ReactNode
  /** 展开后摘要只是重复内容里的大数字：只在折叠时显示 */
  quietOpen?: boolean
  /** 「要处理」：边框和图标用警示色 */
  attention?: boolean
  children: ReactNode
}) {
  const open = !useOverviewPrefs().collapsed.includes(id)
  return (
    <section
      data-overview-section={id}
      className={cn('rounded-lg border bg-surface', attention ? 'border-warn/45' : 'border-line-card')}
    >
      <button
        type="button"
        data-overview-head
        aria-expanded={open}
        onClick={() => overviewPrefs.toggleCollapsed(id)}
        className="press flex min-h-[34px] w-full items-center gap-[7px] rounded-lg py-[5px] pr-2 pl-2.5 text-left hover:bg-hover"
      >
        <Icon size={14} strokeWidth={1.6} className={cn('shrink-0', attention ? 'text-warn-fg' : 'text-fg-muted')} />
        <span className="text-list font-medium whitespace-nowrap text-fg">{title}</span>
        <span className="min-w-0 flex-1 truncate text-right text-meta text-fg-muted tabular-nums">
          {open && quietOpen ? null : summary}
        </span>
        <ChevronRight
          size={14}
          strokeWidth={1.6}
          className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')}
        />
      </button>
      {open && <div className="px-2.5 pb-[9px] text-list">{children}</div>}
    </section>
  )
}

export const SECTION_ACTION =
  'press inline-flex h-6 shrink-0 items-center gap-[5px] rounded-md border border-line-card bg-surface px-2 text-meta whitespace-nowrap text-fg-secondary enabled:hover:bg-hover enabled:hover:text-fg disabled:cursor-default disabled:opacity-45'

/** 分组里的小按钮（样稿 .btn）。禁用时不用 pointer-events-none：悬停提示要告诉用户为什么点不了 */
export function SectionAction({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn(SECTION_ACTION, className)} {...rest} />
}

/** 点得动的一行（样稿 .row.click）：悬停底色伸出内容区一点，文字还和别的行对齐 */
export const SECTION_ROW =
  'press -mx-[5px] flex min-h-[26px] w-[calc(100%+10px)] items-center gap-[7px] rounded-md px-[5px] text-left text-fg-secondary hover:bg-hover'

const FILL: Record<QuotaLevel, string> = { normal: 'bg-accent', warn: 'bg-warn', full: 'bg-danger' }

/** 细进度条（样稿 .bar）；有用量就至少露一点 */
export function Meter({ percent, level, label }: { percent: number; level: QuotaLevel; label: string }) {
  const clamped = Math.min(100, Math.max(0, percent))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1 overflow-hidden rounded-full bg-selected"
    >
      <i className={cn('block h-full rounded-full', FILL[level])} style={{ width: `${Math.max(clamped, 2)}%` }} />
    </div>
  )
}

/** 四格数字里的一格（样稿 .stats） */
export function Stat({ value, label, title }: { value: ReactNode; label: string; title?: string }) {
  return (
    <div title={title} className="min-w-0 py-[3px]">
      <b className="block truncate text-section leading-tight font-medium tabular-nums">{value}</b>
      <span className="text-label text-fg-muted">{label}</span>
    </div>
  )
}
