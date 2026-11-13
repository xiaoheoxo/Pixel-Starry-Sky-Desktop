// 概况里的分组（D274，样稿 docs/ui/session-overview-pill-mockup.html）：每组一张圆角卡片（墨色底，没有描边），标题行有图标、粗标题、
// 小数字胶囊，点了折叠；折叠和隐藏记在 overviewPrefs。「状态」组是 2×2 的大数字格（StatusTile），点一格在下面展开。
// 分组里共用的胶囊按钮、标签、行、进度条也在这
import { createContext, useContext, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { ChevronRight, Gauge, type LucideIcon } from 'lucide-react'
import { cn } from '@/ui'
import { tr } from '@/i18n/core'
import type { QuotaLevel } from '@/features/session/quota/quotaModel'
import { overviewPrefs, useOverviewPrefs } from './overviewPrefs'

/** 坏了（红）还是要你处理（橙）；别的都是灰 */
export type Tone = 'bad' | 'warn'

export const TONE_TEXT: Record<Tone, string> = { bad: 'text-danger', warn: 'text-warn-fg' }

/** 折叠时标题图标上的点：标题行里有 data-tone 的摘要就亮，红的盖住橙的（「状态」组的摘要来自几格，各带各的） */
const PIP = 'absolute -top-0.5 -right-[3px] hidden size-[7px] rounded-full ring-2 ring-ov-card'

export function Section({
  id,
  icon: Icon,
  title,
  count,
  summary,
  right,
  tone,
  attention,
  className,
  children,
}: {
  id: string
  icon: LucideIcon
  title: string
  /** 标题后面的小数字胶囊（几项、几步） */
  count?: ReactNode
  /** 折叠时标题行右边的一句摘要 */
  summary?: ReactNode
  /** 展开时标题行右边的小字（这一轮用时） */
  right?: ReactNode
  /** 有问题：折叠时摘要变色、图标上一个点 */
  tone?: Tone
  /** 「要处理」：整张卡片警示色底，数字胶囊实心 */
  attention?: boolean
  className?: string
  children: ReactNode
}) {
  const open = !useOverviewPrefs().collapsed.includes(id)
  const side = open ? right : summary
  return (
    <section
      data-overview-section={id}
      className={cn(
        'group/sec rounded-2xl px-1.5',
        attention ? 'bg-ov-warn' : 'bg-ov-card',
        open ? 'pt-1 pb-2.5' : 'py-[3px]',
        className,
      )}
    >
      <button
        type="button"
        data-overview-head
        aria-expanded={open}
        onClick={() => overviewPrefs.toggleCollapsed(id)}
        className="group/head press flex min-h-8 w-full items-center gap-2 rounded-full px-2 text-left hover:bg-hover"
      >
        <span className={cn('relative inline-flex shrink-0', attention ? 'text-warn-fg' : 'text-fg-muted')}>
          <Icon size={15} strokeWidth={1.6} />
          {!open && (
            <>
              <span aria-hidden className={cn(PIP, 'bg-warn group-has-[[data-tone=warn]]/head:block')} />
              <span aria-hidden className={cn(PIP, 'bg-danger group-has-[[data-tone=bad]]/head:block')} />
            </>
          )}
        </span>
        <span className={cn('font-semibold whitespace-nowrap', attention ? 'text-warn-fg' : 'text-fg')}>{title}</span>
        {count !== undefined && (
          <span
            className={cn(
              'inline-grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-[5px] text-label font-medium tabular-nums',
              attention ? 'bg-warn text-(--bg-workbench)' : 'bg-ov-chip text-fg-muted',
            )}
          >
            {count}
          </span>
        )}
        <ChevronRight
          size={13}
          strokeWidth={1.6}
          className={cn(
            'shrink-0 text-fg-faint transition-transform motion-reduce:transition-none',
            open && 'rotate-90 opacity-0 group-hover/head:opacity-100 group-focus-visible/head:opacity-100',
          )}
        />
        {side !== undefined && (
          <span
            data-tone={open ? undefined : tone}
            className={cn(
              'min-w-0 flex-1 truncate pl-1 text-right text-meta tabular-nums',
              !open && tone ? TONE_TEXT[tone] : 'text-fg-muted',
            )}
          >
            {side}
          </span>
        )}
      </button>
      {open && <div className="px-2 pt-0.5 text-list">{children}</div>}
    </section>
  )
}

/** 「状态」组折叠时，各格只交出一段「名称 数字」拼进标题行 */
const StatusFolded = createContext(false)
/** 展开着的那一格：同时只开一格，明细在四格下面 */
const OpenTile = createContext<{ open: string | null; set(id: string | null): void }>({ open: null, set() {} })

/** 上下文、额度、MCP、已加载放在一组里；四项都没数据（或都隐藏了）时整组不显示。展开哪格不记，换会话就收起 */
export function StatusGroup({ children }: { children: ReactNode }) {
  const [open, set] = useState<string | null>(null)
  return (
    <Section
      id="status"
      icon={Gauge}
      title={tr('overview.status')}
      summary={<StatusFolded.Provider value>{children}</StatusFolded.Provider>}
      className="[&:not(:has([data-overview-row]))]:hidden"
    >
      <OpenTile.Provider value={{ open, set }}>
        {/* 明细排在四格后面（order-1），跨两列 */}
        <div className="grid grid-cols-2 gap-1.5 pt-0.5">{children}</div>
      </OpenTile.Provider>
    </Section>
  )
}

/** 大数字：样稿 19px，跟着字号和密度缩放 */
export const BIG_NUMBER =
  'text-[length:calc(19px*var(--font-scale,1)*var(--density,1))] leading-[1.15] font-medium tabular-nums'

/** 「状态」组里的一格：小标题、大数字、一条小图（进度条、圆点）、一句说明；有问题整格变橙或红 */
export function StatusTile({
  id,
  icon: Icon,
  title,
  value,
  folded,
  visual,
  sub,
  subTone,
  tone,
  children,
}: {
  id: string
  icon: LucideIcon
  title: string
  value: ReactNode
  /** 折叠时标题行里的那段（默认「名称 数字」） */
  folded?: ReactNode
  visual?: ReactNode
  sub?: ReactNode
  /** 只有说明那句变色（照这个速度要用完了） */
  subTone?: Tone
  tone?: Tone
  children: ReactNode
}) {
  const inHead = useContext(StatusFolded)
  const tiles = useContext(OpenTile)
  if (inHead)
    return (
      <span
        data-overview-row={id}
        data-tone={tone}
        className={cn("[&+&]:before:content-['_·_']", tone && TONE_TEXT[tone])}
      >
        {folded ?? (
          <>
            {title} {value}
          </>
        )}
      </span>
    )
  const open = tiles.open === id
  return (
    <>
      <button
        type="button"
        data-overview-row={id}
        aria-expanded={open}
        onClick={() => tiles.set(open ? null : id)}
        className={cn(
          'press flex min-w-0 flex-col gap-[3px] rounded-xl px-2.5 pt-2 pb-[9px] text-left',
          open
            ? 'bg-ov-chip'
            : tone === 'bad'
              ? 'bg-ov-bad'
              : tone === 'warn'
                ? 'bg-ov-warn'
                : 'bg-ov-tile hover:bg-hover',
        )}
      >
        <span
          className={cn('flex min-w-0 items-center gap-[5px] text-label', tone ? TONE_TEXT[tone] : 'text-fg-muted')}
        >
          <Icon size={12} strokeWidth={1.6} className="shrink-0" />
          <span className="truncate">{title}</span>
        </span>
        <span className={cn('truncate', BIG_NUMBER, tone ? TONE_TEXT[tone] : 'text-fg')}>{value}</span>
        {visual}
        {sub !== undefined && (
          <span className={cn('truncate text-label', subTone ? TONE_TEXT[subTone] : 'text-fg-muted')}>{sub}</span>
        )}
      </button>
      {open && (
        <div data-overview-detail={id} className="order-1 col-span-2 -mx-2 rounded-xl bg-ov-tile p-2 pb-2.5 text-meta">
          {children}
        </div>
      )}
    </>
  )
}

/** 大数字后面淡色的单位或分母（76% / 200k、2 / 4） */
export function Unit({ children }: { children: ReactNode }) {
  return <small className="ml-[3px] text-meta font-normal text-fg-muted">{children}</small>
}

/** 胶囊按钮：灰底（默认）、主操作（强调色实心，每块最多一个）、警示（橙色实心）、文字（没有底色） */
export type PillTone = 'default' | 'primary' | 'warn' | 'ghost'

const PILL_TONE: Record<PillTone, string> = {
  default: 'bg-ov-chip text-fg-secondary enabled:hover:bg-ov-chip-hover enabled:hover:text-fg',
  primary: 'bg-accent font-medium text-accent-on enabled:hover:bg-accent/88',
  warn: 'bg-warn font-medium text-(--bg-workbench) enabled:hover:bg-warn/88',
  ghost: 'px-1.5! text-accent-fg enabled:hover:bg-hover',
}

export const pillClass = (tone: PillTone = 'default'): string =>
  cn(
    'press inline-flex h-6 shrink-0 items-center gap-[5px] rounded-full px-2.5 text-meta whitespace-nowrap disabled:cursor-default disabled:opacity-45',
    PILL_TONE[tone],
  )

/** 分组里的胶囊按钮。禁用时不用 pointer-events-none：悬停提示要告诉用户为什么点不了 */
export function Pill({ tone, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: PillTone }) {
  return <button type="button" className={cn(pillClass(tone), className)} {...rest} />
}

/** 灰胶囊（「重连」「看页面」）；旧名字留着，各分组里到处在用 */
export const SectionAction = (props: ButtonHTMLAttributes<HTMLButtonElement>) => <Pill {...props} />

/** 展开内容底下的文字操作（明细、管理、用量页…）：没有底色 */
export const SectionLink = (props: ButtonHTMLAttributes<HTMLButtonElement>) => <Pill tone="ghost" {...props} />

/** 一排胶囊按钮 */
export const SECTION_LINKS = 'flex flex-wrap items-center gap-1.5 pt-2'

/** 小标签：灰（默认）、强调色、绿（好了）、橙（要处理）、红（坏了） */
export type TagTone = 'default' | 'accent' | 'ok' | 'warn' | 'bad'

const TAG_TONE: Record<TagTone, string> = {
  default: 'bg-ov-chip text-fg-secondary',
  accent: 'bg-accent-soft text-accent-fg',
  ok: 'bg-success/14 text-success',
  warn: 'bg-warn/18 text-warn-fg',
  bad: 'bg-danger/15 text-danger',
}

export const tagClass = (tone: TagTone = 'default'): string =>
  cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-label whitespace-nowrap', TAG_TONE[tone])

export function Tag({
  tone,
  icon: Icon,
  title,
  className,
  children,
}: {
  tone?: TagTone
  icon?: LucideIcon
  title?: string
  className?: string
  children: ReactNode
}) {
  return (
    <span title={title} className={cn(tagClass(tone), className)}>
      {Icon && <Icon size={11} strokeWidth={1.8} className="shrink-0" />}
      {children}
    </span>
  )
}

/** 一排筛选胶囊（全部 / 要处理 / 已连接…，带个数）；dot 是名字前的小圆点颜色 */
export function FilterChips<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T
  onChange(value: T): void
  options: readonly { id: T; label: string; count: number; dot?: string }[]
  className?: string
}) {
  return (
    <div className={cn('-mx-1 flex flex-wrap items-center gap-0.5', className)}>
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'press inline-flex h-6 items-center gap-1 rounded-full px-[7px] text-meta',
            value === o.id ? 'bg-ov-chip text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg-secondary',
          )}
        >
          {o.dot && <i className={cn('size-1.5 rounded-full', o.dot)} />}
          {o.label} <b className="font-medium tabular-nums">{o.count}</b>
        </button>
      ))}
    </div>
  )
}

/** 一行（样稿 .row）：悬停底色是胶囊，伸出内容区一点，文字还和别的行对齐。点得动的用 button，不点的加 SECTION_ROW_STATIC */
export const SECTION_ROW =
  'group/row press -mx-1.5 flex min-h-7 w-[calc(100%+12px)] items-center gap-[9px] rounded-full px-1.5 text-left text-fg-secondary hover:bg-hover'
export const SECTION_ROW_STATIC =
  'group/row -mx-1.5 flex min-h-7 w-[calc(100%+12px)] items-center gap-[9px] rounded-full px-1.5 text-fg-secondary hover:bg-hover'

/** 行里的次要操作：悬停或键盘聚焦到这一行才出现 */
export const ROW_OPS =
  'flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100'

/** 行里悬停时让位给操作的那部分（增删数字、多久前） */
export const ROW_HIDE = 'group-hover/row:hidden group-focus-within/row:hidden'

/** 行里图标的样式 */
export const ROW_ICON = 'shrink-0 text-fg-muted'

/** 小一级的分组标题（「这个会话的」「分类」） */
export const SUB_LABEL = 'flex pt-1.5 pb-0.5 text-label text-fg-faint'

/** 说明文字：最淡 */
export const NOTE = 'pt-1.5 text-label leading-[1.45] text-fg-faint'

const FILL: Record<QuotaLevel, string> = { normal: 'bg-accent', warn: 'bg-warn', full: 'bg-danger' }

/** 细进度条；有用量就至少露一点。className 给宽度和高度（默认 4px） */
export function Meter({
  percent,
  level,
  label,
  muted,
  className,
}: {
  percent: number
  level?: QuotaLevel
  label?: string
  /** 灰色的占比条（分类、工具调用），不是用量 */
  muted?: boolean
  className?: string
}) {
  const clamped = Math.min(100, Math.max(0, percent))
  return (
    <div
      role={label ? 'progressbar' : undefined}
      aria-label={label}
      aria-valuenow={label ? Math.round(clamped) : undefined}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      className={cn('h-1 overflow-hidden rounded-full bg-ov-track', className)}
    >
      <i
        className={cn('block h-full rounded-full', muted ? 'bg-fg-muted' : FILL[level ?? 'normal'])}
        style={{ width: `${Math.max(clamped, 2)}%` }}
      />
    </div>
  )
}
