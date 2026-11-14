import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '../../../i18n/core'
// 每轮的过程收成一行「执行」（docs/ui/conversation-concise.md §3）：点开看全部；运行中露出最近 2 条
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronRight, Circle, Layers } from 'lucide-react'
import type { Item } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { REQUEST_MS, useExpandAny } from '@/features/search/expand'
import { formatDuration } from './agentTrace'
import { planResult } from './progressData'
import { planSections, type PlanSection } from './planStages'
import { summarize, type ProcessSummary } from './turnFold'
import { useMinimal } from '@/features/appearance/ThemeProvider'
import { ImageThumbs } from '../attachments/ImageAttachments'
import { failedItems, useRowMode, type ViewMode } from '../viewMode'

/** 运行中收起时露出的最近几条 */
const TAIL = 2

const PARTS: readonly (keyof Omit<ProcessSummary, 'failed' | 'blocked'>)[] = [
  'commands',
  'edits',
  'reads',
  'searches',
  'web',
  'mcp',
  'agents',
  'other',
]

export function summaryText(s: ProcessSummary, steps: number): string {
  const parts = PARTS.filter(k => s[k] > 0).map(k =>
    tr(`session.process.${k}${s[k] === 1 ? 'One' : ''}` as TranslationKey, { n: s[k] }),
  )
  return parts.length ? parts.join(tr('session.process.joiner')) : tr('session.process.steps', { n: steps })
}

/**
 * 「执行」没点过时展开不展开：有被拦下的展开，原因和「仍要执行」不用点开就能看到；
 * 详细模式展开（docs/ui/view-mode.md §3；聊天模式穿插显示，用的是 ProcessGroup）。极简模式也跟查看模式走（docs/ui/minimal-mode.md §12 B）
 */
export const processOpenByDefault = (items: readonly Item[], mode: ViewMode = 'normal'): boolean =>
  mode === 'detailed' || summarize(items).blocked > 0

/** 点过的展开只在这次模式里算（§4 第 4 条）：gen 变了回到模式默认 */
function useModeToggle(): [boolean | null, (open: boolean) => void] {
  const { gen } = useRowMode()
  const [t, setT] = useState<{ gen: number; open: boolean } | null>(null)
  return [t && t.gen === gen ? t.open : null, open => setT({ gen, open })]
}

const ROWS = 'mt-1 ml-[15px] flex flex-col gap-3 border-l border-line-subtle pl-3'

/** 计划的一步（规则 A，docs/ui/auto-fold.md §3）：做完就收成一行；正在做的、有失败的摊开，点过就按点的来 */
function PlanStage({
  stage,
  render,
}: {
  stage: Extract<PlanSection, { type: 'stage' }>
  render: (items: Item[]) => ReactNode
}) {
  const [toggled, setToggled] = useModeToggle()
  const { mode } = useRowMode()
  const ids = useMemo(() => stage.items.map(i => i.id), [stage.items])
  const requested = useExpandAny(ids)
  useEffect(() => {
    if (requested && Date.now() - requested < REQUEST_MS) setToggled(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只跟请求走
  }, [requested])
  const summary = useMemo(() => summarize(stage.items), [stage.items])
  const open = toggled ?? (mode === 'detailed' || stage.active || summary.failed > 0 || summary.blocked > 0)
  return (
    <div data-fold={open ? 'open' : 'closed'} data-fold-items={open ? undefined : ids.join(' ')} data-plan-stage>
      <button
        type="button"
        aria-expanded={open}
        title={stage.step}
        onClick={() => setToggled(!open)}
        className="flex h-[30px] max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-list text-fg-muted hover:bg-hover hover:text-fg-secondary"
      >
        {stage.done ? (
          <Check size={15} strokeWidth={1.5} className="mr-0.5 shrink-0 text-success" />
        ) : (
          <Circle size={13} strokeWidth={1.5} className={cn('mr-1 ml-px shrink-0', stage.active && 'text-warn')} />
        )}
        <span className="min-w-0 truncate text-fg-secondary">
          {stage.n === null ? stage.step : `${stage.n}. ${stage.step}`}
        </span>
        <span aria-hidden className="shrink-0 text-fg-faint">
          ·
        </span>
        <span className="min-w-0 truncate">{summaryText(summary, stage.items.length)}</span>
        {summary.failed > 0 && (
          <span className="shrink-0 text-danger">
            <span aria-hidden className="mr-1.5 text-fg-faint">
              ·
            </span>
            {tr('session.process.failed', { n: summary.failed })}
          </span>
        )}
        {summary.blocked > 0 && (
          <span className="shrink-0 text-danger">
            <span aria-hidden className="mr-1.5 text-fg-faint">
              ·
            </span>
            {tr('codex.review.blockedCount', { n: summary.blocked })}
          </span>
        )}
        <ChevronRight
          size={15}
          strokeWidth={1.5}
          className={cn('shrink-0 transition-transform duration-(--dur-fast)', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div data-process-rows className={ROWS}>
          {render(stage.items)}
        </div>
      )}
    </div>
  )
}

function PlanSections({ sections, render }: { sections: PlanSection[]; render: (items: Item[]) => ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {sections.map(s =>
        s.type === 'stage' ? (
          <PlanStage key={s.key} stage={s} render={render} />
        ) : (
          <div key={s.key} data-process-rows className={ROWS}>
            {render(s.items)}
          </div>
        ),
      )}
    </div>
  )
}

export function TurnProcess({
  items,
  running,
  latest,
  durationMs,
  toggled,
  onToggle,
  render,
}: {
  items: Item[]
  running: boolean
  /** 在最后一轮里：按计划分步时不要「执行」这一行，直接列出每一步；下一轮开始后才收成一行 */
  latest: boolean
  durationMs: number | null
  /** 点开 / 收起的状态由外面管（运行中底部的状态行也能展开它）：null 是还没点过，按查看模式的默认 */
  toggled: boolean | null
  onToggle: (open: boolean) => void
  /** 显示一组过程条目（LiveTranscript 的工具行分组、思考、待办、过渡话） */
  render: (items: Item[]) => ReactNode
}) {
  useI18n()
  const minimal = useMinimal()
  const { mode } = useRowMode()
  const summary = useMemo(() => summarize(items), [items])
  const open = toggled ?? processOpenByDefault(items, mode)
  // 对话内搜索的「展开」、全局搜索跳到里面的条目：执行块先展开，里面的条目自己再展开
  const ids = useMemo(() => items.map(i => i.id), [items])
  const requested = useExpandAny(ids)
  useEffect(() => {
    if (requested && Date.now() - requested < REQUEST_MS) onToggle(true)
  }, [requested, onToggle])
  const plan = useMemo(() => (running ? null : planResult(items)), [items, running])
  // 隐藏了内容的思考（只剩「思考了 N 秒」或什么都不显示）不算步数，也不占运行中露出的那几条
  const shown = useMemo(
    () => items.filter(i => !(i.kind === 'reasoning' && i.status !== 'running' && !i.text.trim())),
    [items],
  )
  // 极简模式不分阶段（docs/ui/auto-fold.md §6）：计划写在对话末尾
  const sections = useMemo(() => (minimal ? null : planSections(items, running)), [minimal, items, running])
  // 收起时露出来的：运行中最近 2 条，以及失败的那几条（所有模式一样，docs/ui/view-mode.md §3）
  const tail = useMemo(() => {
    if (open) return []
    const keep = new Set([...(running ? shown.slice(-TAIL) : []), ...failedItems(items)])
    return items.filter(i => keep.has(i))
  }, [open, running, shown, items])
  if (sections && toggled === null && (running || latest))
    return (
      <div data-fold="open" data-turn-process>
        <PlanSections sections={sections} render={render} />
      </div>
    )
  // 收起时不在页面上的条目：对话内搜索算进「折叠中还有 N 处」
  const hidden = open ? [] : ids.filter(id => !tail.some(i => i.id === id))
  // 收起时，藏起来的那几行里模型看过的图直接排在「执行」下面（露出来的行自己带缩略图）
  const viewed = open
    ? []
    : items.flatMap(i =>
        i.kind === 'tool' && !tail.includes(i) ? (i.images ?? []).map(image => ({ image, itemId: i.id })) : [],
      )
  return (
    <div data-fold={open ? 'open' : 'closed'} data-fold-items={hidden.join(' ') || undefined} data-turn-process>
      <button
        type="button"
        aria-expanded={open}
        title={tr(open ? 'session.process.collapse' : 'session.process.expand')}
        onClick={() => onToggle(!open)}
        className="flex h-[30px] max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-list text-fg-muted hover:bg-hover hover:text-fg-secondary"
      >
        {/* 运行中也只是安静的标题：在做什么写在底部的状态行上（LiveStatusLine），这里不再重复、不再闪 */}
        <Layers size={15} strokeWidth={1.5} className="mr-0.5 shrink-0" />
        <span className="shrink-0 text-fg-secondary">{tr('session.process.title')}</span>
        <span aria-hidden className="shrink-0 text-fg-faint">
          ·
        </span>
        <span className="min-w-0 truncate">{summaryText(summary, shown.length)}</span>
        {plan && (
          <span className={cn('min-w-0 truncate', plan.stoppedAt ? 'text-warn' : 'text-success')}>
            <span aria-hidden className="mr-1.5 text-fg-faint">
              ·
            </span>
            {plan.stoppedAt
              ? tr('session.process.planStopped', { total: plan.total, done: plan.done, step: plan.stoppedAt })
              : tr('session.process.planDone', { total: plan.total })}
          </span>
        )}
        {summary.failed > 0 && (
          <span className="shrink-0 text-danger">
            <span aria-hidden className="mr-1.5 text-fg-faint">
              ·
            </span>
            {tr('session.process.failed', { n: summary.failed })}
          </span>
        )}
        {summary.blocked > 0 && (
          <span className="shrink-0 text-danger">
            <span aria-hidden className="mr-1.5 text-fg-faint">
              ·
            </span>
            {tr('codex.review.blockedCount', { n: summary.blocked })}
          </span>
        )}
        {!running && durationMs !== null && (
          <span className="shrink-0 text-fg-faint tabular-nums">
            <span aria-hidden className="mr-1.5">
              ·
            </span>
            {formatDuration(durationMs)}
          </span>
        )}
        <ChevronRight
          size={15}
          strokeWidth={1.5}
          className={cn('shrink-0 transition-transform duration-(--dur-fast)', open && 'rotate-90')}
        />
      </button>
      {viewed.length > 0 && (
        <div className="mt-1 mb-0.5 ml-[31px]">
          <ImageThumbs entries={viewed} />
        </div>
      )}
      {open && sections ? (
        <div className="mt-1">
          {/* 分步时不画清单；展开了就画出来，全局搜索跳到清单这一条才找得到 */}
          <div data-process-rows className={ROWS}>
            {render(items.filter(i => i.kind === 'todo'))}
          </div>
          <PlanSections sections={sections} render={render} />
        </div>
      ) : (
        (open || tail.length > 0) && (
          <div data-process-rows className={ROWS}>
            {render(open ? items : tail)}
          </div>
        )
      )}
    </div>
  )
}
