import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { Fragment, useState, type HTMLAttributes, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, CircleHelp } from 'lucide-react'
import { IconButton, cn } from '@/ui'

/**
 * 用量页的表格（明细两张 + 分布表，docs/ui/usage.md §9.4）。
 * - 自动布局、不换行：数字和表头不截断，多出来的宽度各列按内容分，不再全给名称列。
 * - 不用分割线：隔行底色分行，组之间多留白，上面一行写组名。
 * - 放不下时按 `hideBelow` 隐藏次要列（容器查询，看表格自己的宽度；用 em，跟着字号缩放）。
 * - 点一行展开详情，展开 / 收起带动画（globals.css .usage-expand）。
 */
export interface UsageColumn<T> {
  key: string
  label: string
  /** 表头后面的「?」，悬停看说明 */
  help?: string
  /** 所属分组的名字，相邻同名的算一组；空串是没有组名但要和两边隔开；不写表示不分组 */
  group?: string
  /** 名称列：内容可以省略，占 26% 宽，最窄留 11em */
  fill?: boolean
  align?: 'left' | 'right'
  /** 表格宽度小于这个值时隐藏这一列（em）；不写表示一直显示。明细表隐藏的列要在展开详情里还能看到 */
  hideBelow?: UsageBreakpoint
  /** 额外样式，加在表头和单元格上 */
  className?: string
  /** 单元格样式（颜色、等宽字体等） */
  cellClass?: (row: T) => string
  render: (row: T) => ReactNode
  /** 悬停提示 */
  title?: (row: T) => string | undefined
}

// 类名要写全，Tailwind 才扫得到。阈值按英文（比中文宽）在真实界面量的
const HIDE_BELOW = {
  36: '@max-[36em]:hidden',
  40: '@max-[40em]:hidden',
  44: '@max-[44em]:hidden',
  50: '@max-[50em]:hidden',
  56: '@max-[56em]:hidden',
  58: '@max-[58em]:hidden',
  64: '@max-[64em]:hidden',
  70: '@max-[70em]:hidden',
} as const
const HIDE_FROM: Record<UsageBreakpoint, string> = {
  36: '@min-[36em]:hidden',
  40: '@min-[40em]:hidden',
  44: '@min-[44em]:hidden',
  50: '@min-[50em]:hidden',
  56: '@min-[56em]:hidden',
  58: '@min-[58em]:hidden',
  64: '@min-[64em]:hidden',
  70: '@min-[70em]:hidden',
}
export type UsageBreakpoint = keyof typeof HIDE_BELOW

const CELL_PAD = 'px-[1.08em] first:pl-2 last:pr-2 @max-[80em]:px-[0.7em]'
const GROUP_GAP = 'pl-[2.6em] @max-[80em]:pl-[1.6em]'
/** 一组里排在前面的列隐藏后，留白要由剩下的第一列接上（56 是速度列的 hideBelow） */
export const GROUP_GAP_WITHOUT_SPEED = '@max-[56em]:pl-[1.6em]'

export interface GroupCell {
  key: string
  label: string
  colSpan: number
  /** 这个格子只在表格宽度 from ≤ w < to 时显示（列隐藏后跨的列数不同，每段一个格子） */
  from?: UsageBreakpoint
  to?: UsageBreakpoint
  gap: boolean
}

/** 组名那一行的格子 */
export function groupCells<T>(columns: Array<UsageColumn<T>>): GroupCell[] {
  const runs: Array<Array<UsageColumn<T>>> = []
  for (const c of columns) {
    const last = runs.at(-1)
    if (last && last[0].group === c.group) last.push(c)
    else runs.push([c])
  }
  return runs.flatMap((run, r) => {
    const cuts = [...new Set(run.flatMap(c => c.hideBelow ?? []))].sort((a, b) => a - b)
    return [undefined, ...cuts].flatMap((from, i) => {
      const colSpan = run.filter(c => !c.hideBelow || (from !== undefined && c.hideBelow <= from)).length
      if (!colSpan) return []
      return {
        key: `${r}-${from ?? 0}`,
        label: run[0].group ?? '',
        colSpan,
        from,
        to: cuts[i],
        gap: run[0].group !== undefined,
      }
    })
  })
}

/** 列表头和单元格共用的留白：一组的第一列多留一段 */
function columnClass<T>(columns: Array<UsageColumn<T>>, i: number): string {
  const c = columns[i]
  const startsGroup = i > 0 && c.group !== undefined && columns[i - 1].group !== c.group
  return cn(
    CELL_PAD,
    startsGroup && GROUP_GAP,
    c.align === 'right' ? 'text-right' : 'text-left',
    c.hideBelow && HIDE_BELOW[c.hideBelow],
    c.className,
  )
}

/** 表格本体：表头（组名 + 列名）和隔行底色的行 */
export function UsageGrid<T>({
  columns,
  rows,
  rowKey,
  rowProps,
  after,
}: {
  columns: Array<UsageColumn<T>>
  rows: T[]
  rowKey: (row: T) => string
  rowProps?: (row: T) => HTMLAttributes<HTMLTableRowElement>
  /** 这一行下面再放的内容（展开的详情） */
  after?: (row: T) => ReactNode
}) {
  return (
    // 字号调到最大、窗口又最小时才用得上横向滚动，其余宽度靠隐藏列放下
    <div className="overflow-x-auto">
      <table className="w-full whitespace-nowrap text-list tabular-nums">
        <thead>
          {columns.some(c => c.group) && (
            <tr>
              {groupCells(columns).map(g => (
                <th
                  key={g.key}
                  colSpan={g.colSpan}
                  className={cn(
                    CELL_PAD,
                    g.gap && GROUP_GAP,
                    'pb-0.5 text-left font-normal',
                    g.from && HIDE_BELOW[g.from],
                    g.to && HIDE_FROM[g.to],
                  )}
                >
                  <span className="text-label text-fg-faint">{g.label}</span>
                </th>
              ))}
            </tr>
          )}
          <tr>
            {columns.map((c, i) => (
              <th key={c.key} className={cn('pb-2 font-normal', columnClass(columns, i))}>
                <span className="text-meta text-fg-muted">
                  {c.label}
                  {c.help && <HelpMark text={c.help} />}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => {
            const { className, ...props } = rowProps?.(row) ?? {}
            return (
              <Fragment key={rowKey(row)}>
                <tr {...props} className={cn('cursor-default', r % 2 === 0 && 'bg-subtle', className)}>
                  {columns.map((c, i) => (
                    <td
                      key={c.key}
                      title={c.title?.(row)}
                      className={cn(
                        'h-[2.9em] py-0.5',
                        columnClass(columns, i),
                        c.fill && 'w-[26%] max-w-0 min-w-[11em] truncate',
                        c.cellClass?.(row) ?? 'text-fg-secondary',
                      )}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
                {after?.(row)}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

interface UsageTableProps<T> {
  title: string
  rows: T[]
  rowKey: (row: T) => string
  columns: Array<UsageColumn<T>>
  /** 展开后的详情 */
  detail: (row: T) => ReactNode
  /** 分页 */
  offset: number
  total: number
  pageSize: number
  onPage: (offset: number) => void
}

export function UsageTable<T>({
  title,
  rows,
  rowKey,
  columns,
  detail,
  offset,
  total,
  pageSize,
  onPage,
}: UsageTableProps<T>) {
  useI18n()
  const [open, setOpen] = useState<string | null>(null)
  // 详情那一行跨当前显示的列数：多写的话表格会多出空列，别的列被挤窄
  const [span, setSpan] = useState(columns.length)
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(offset + rows.length, total)

  return (
    // 容器查询的 em 按这个元素的字号算，和表格一样
    <div className="@container min-w-0 text-list">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h4 className="min-w-0 truncate text-ui font-medium text-fg">{title}</h4>
        <div className="flex shrink-0 items-center gap-1 text-meta text-fg-muted tabular-nums">
          <span className="mr-1">
            {from}–{to} / {total}
          </span>
          <IconButton
            icon={ChevronLeft}
            label={tr('settings.usage.UsageTable.previousPage')}
            disabled={offset === 0}
            onClick={() => onPage(Math.max(0, offset - pageSize))}
          />
          <IconButton
            icon={ChevronRight}
            label={tr('settings.usage.UsageTable.nextPage')}
            disabled={to >= total}
            onClick={() => onPage(offset + pageSize)}
          />
        </div>
      </div>

      <UsageGrid
        columns={columns}
        rows={rows}
        rowKey={rowKey}
        rowProps={row => {
          const id = rowKey(row)
          const expanded = open === id
          return {
            onClick: e => {
              setSpan([...e.currentTarget.children].filter(c => getComputedStyle(c).display !== 'none').length)
              setOpen(expanded ? null : id)
            },
            'aria-expanded': expanded,
            className: cn('hover:bg-selected', expanded && 'bg-selected!'),
          }
        }}
        after={row =>
          open === rowKey(row) && (
            <tr className="bg-selected">
              {/* max-w-0：详情里的长标题不能把列撑宽 */}
              <td colSpan={span} className="max-w-0 p-0! whitespace-normal">
                <div className="usage-expand overflow-hidden rounded-b-md">
                  <div className="min-w-0 overflow-hidden p-3 pt-1">{detail(row)}</div>
                </div>
              </td>
            </tr>
          )
        }
      />
    </div>
  )
}

/** 表头后面的「?」 */
export function HelpMark({ text }: { text: string }) {
  return (
    <span role="img" aria-label={text} title={text} className="ml-0.5 inline-block align-[-1.5px] text-fg-faint">
      <CircleHelp size={11} strokeWidth={1.5} aria-hidden />
    </span>
  )
}

/** 速度：287 tok/s，单位小一号；没有时「—」 */
export function SpeedCell({ speed }: { speed: number | null }) {
  if (speed === null) return <>—</>
  return (
    <>
      {Math.round(speed)} <span className="text-label text-fg-muted">tok/s</span>
    </>
  )
}

/** 费用：金额突出，前面的 ≈ / ≥ 调淡 */
export function CostCell({ text }: { text: string }) {
  const prefix = /^[≈≥] /.exec(text)?.[0]
  return (
    <>
      {prefix && <span className="font-normal text-fg-muted">{prefix}</span>}
      {prefix ? text.slice(prefix.length) : text}
    </>
  )
}
export const COST_CELL_CLASS = 'font-semibold text-fg'

/** 结果：前面一个状态点 */
export function ResultCell({ text, dot }: { text: string; dot: string }) {
  return (
    <>
      <span aria-hidden className={cn('mr-1.5 inline-block size-1.5 rounded-full align-[1.5px]', dot)} />
      {text}
    </>
  )
}

/** 分开日期和时刻：「Nov 5, 7:30 PM」的时刻是「7:30 PM」，不能按最后一个空格切 */
export function splitTime(text: string): [string, string] {
  const i = text.search(/\d{1,2}:\d{2}/)
  return i < 0 ? ['', text] : [text.slice(0, i), text.slice(i)]
}

/** 时间单元格：「10-02 18:24」，表格窄时只剩「18:24」，日期在悬停提示和详情里 */
export function TimeCell({ text }: { text: string }) {
  useI18n()
  const [date, clock] = splitTime(text)
  return (
    <>
      <span className="@max-[74em]:hidden">{date}</span>
      {clock}
    </>
  )
}

/**
 * 模型单元格：上面模型，表格窄时省掉「claude-」前缀（claude-opus-5-5 → opus-5-5）；
 * 下面一行写会话或客户端。两行各自截断，完整内容在悬停提示里。
 */
export function ModelCell({ model, source }: { model: string; source: string }) {
  useI18n()
  const claude = model.startsWith('claude-')
  return (
    <>
      <div className="truncate font-mono text-meta text-fg-secondary" title={model}>
        {claude && <span className="@max-[76em]:hidden">claude-</span>}
        {claude ? model.slice('claude-'.length) : model}
      </div>
      <div className="truncate text-meta text-fg-muted" title={source}>
        {source}
      </div>
    </>
  )
}

/** 详情卡片：字段网格（窄时两列）+ 底部一行（ID、按钮） */
export function UsageDetailCard({ fields, footer }: { fields: Array<[string, string]>; footer: ReactNode }) {
  useI18n()
  return (
    <div className="@container rounded-md border border-line bg-surface p-3">
      <dl className="grid grid-cols-3 gap-x-6 gap-y-2 text-meta @max-[520px]:grid-cols-2">
        {fields.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="truncate text-fg-muted">{k}</dt>
            <dd className="truncate text-fg tabular-nums" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex min-w-0 items-center justify-between gap-3 border-t border-line-subtle pt-2.5">
        {footer}
      </div>
    </div>
  )
}
