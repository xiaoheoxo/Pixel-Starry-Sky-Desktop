import { useI18n } from '@/i18n/I18nProvider'
import { useApprovalWait, locateApproval, useSelectedApprovalItem } from './approvals/focus'
import { tr, translateMessage, type TranslationKey } from '../../../i18n/core'
// 对话流里各种条目的显示（docs/engines.md §5.3、§11）
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Ban,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  Info,
  ListTodo,
  Plug,
  Search,
  SquareArrowOutUpRight,
  SquareTerminal,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { FileChange, Item, ItemStatus, ToolKind } from '@pixelsky/protocol'
import { withoutShownImagePlaceholders } from '@pixelsky/protocol'
import { CopyButton, DiffStat, IconButton, cn, useToast } from '@/ui'
import { DiffView } from '@/ui/code/DiffView'
import { CommandText } from '@/ui/code/CommandText'
import { hasWrapperExtra } from './commandWrapper'
import { AnsiText } from '@/ui/code/AnsiText'
import { useOpenTrace } from './trace'
import { StepMark } from './ProgressCard'
import { StatusDot } from './StatusDot'
import { rowLook, useLiveOwned } from './liveOwner'
import { UserText } from './UserText'
import { shouldFoldUser, userBlocks } from './userBlocks'
import { CodeBlock } from '@/ui/code/CodeBlock'
import { freshRequest, useExpandRequest } from '@/features/search/expand'
import { openFile } from '@/features/files/store'
import { useAppMode } from '@/features/coding/mode'
import { revealAiCommand } from '@/features/coding/bottom'
import { pathClickHandlers } from '@/ui/pathClick'
import { pathHint, revealPath } from '@/features/files/reveal'
import { taskNoticeText } from './subagentBoxModel'
import { foldNotice } from './noticeFold'
import { getActiveWorkspace } from '@/features/editor/target'
import { ImageAttachments } from '@/features/session/attachments/ImageAttachments'
import { FileAttachments } from '@/features/session/attachments/FileAttachments'
import { Markdown } from '@/ui/markdown/Markdown'
import { MarkdownImage } from '@/ui/markdown/MarkdownImage'
import { useMessageActionsPosition } from '@/features/settings/messageActions'
import { formatDuration } from './agentTrace'
import { STEP_CLOCK_MS, baseName, clockText } from './currentStep'
import { useSince } from './stepClock'
import { useMinimal } from '@/features/appearance/ThemeProvider'
import { NativeNoticeAction } from '@/features/resume/NativeNoticeAction'
import { AccountNoticeActions, accountNoticeText } from '@/features/model-channels/AccountNoticeActions'
import { clipOutput, OUTPUT_ALL_MAX } from './outputClip'

type ItemOf<K extends Item['kind']> = Extract<Item, { kind: K }>

/**
 * actions：消息操作（悬停显示）。按设置放在气泡左侧（底部对齐，不额外占行高）
 * 或气泡下方（右对齐的一行，不占正文宽度；GitHub #28）
 */
export function UserBubble({ item, actions }: { item: ItemOf<'user'>; actions?: ReactNode }) {
  useI18n()
  const position = useMessageActionsPosition()
  const minimal = useMinimal()
  if (item.mode === 'guidance')
    return (
      <div className="border-l border-accent-line pl-3 text-list whitespace-pre-wrap text-fg-muted">
        <span className="mr-2 text-accent-fg">{tr('session.live.ItemRows.steered')}</span>
        <UserText text={item.text} />
        {!!item.attachments?.length && (
          <div className="mt-2">
            <ImageAttachments images={item.attachments} itemId={item.id} />
          </div>
        )}
        {!!item.files?.length && (
          <div className="mt-2 whitespace-normal">
            <FileAttachments files={item.files} />
          </div>
        )}
      </div>
    )
  const bubble = (
    <div className="conversation-user-bubble min-w-0 rounded-2xl rounded-br-md bg-subtle px-4 py-2.5 text-prose break-words whitespace-pre-wrap text-fg">
      {!!item.attachments?.length && (
        <div className="mb-2">
          <ImageAttachments images={item.attachments} itemId={item.id} />
        </div>
      )}
      {!!item.files?.length && (
        <div className="mb-2 whitespace-normal">
          <FileAttachments files={item.files} />
        </div>
      )}
      <UserBody id={item.id} text={item.text} />
    </div>
  )
  // 极简模式：消息是整行的块，操作按钮浮在块的右上角，不占宽度也不占行高（docs/ui/minimal-mode.md）
  if (minimal)
    return (
      <div className="relative flex" data-message-actions="overlay">
        {bubble}
        {actions && (
          <div data-overlay-actions className="absolute -top-3 right-2">
            {actions}
          </div>
        )}
      </div>
    )
  // 下方：行高一直留着（对话块有绘制裁剪，按钮不能伸进消息之间的空隙），悬停时只是显示出来，不会把下面的内容顶下去
  if (actions && position === 'below')
    return (
      <div className="flex flex-col items-end" data-message-actions="below">
        {bubble}
        <div className="mt-1 flex min-h-6 justify-end">{actions}</div>
      </div>
    )
  return (
    <div className="flex items-end justify-end gap-1">
      {actions}
      {bubble}
    </div>
  )
}

/**
 * 用户消息正文（docs/ui/conversation-ux-2.md §2.4）：代码块按代码显示；长消息只显示前面一段，底部渐隐。
 * 折叠时全文仍在页面上（只是被裁掉）：对话内搜索照常能搜到，跳到被裁掉的命中时点 data-folded 里的展开按钮；
 * 全局搜索跳到这条消息时也展开。
 */
function UserBody({ id, text }: { id: string; text: string }) {
  useI18n()
  const blocks = useMemo(() => userBlocks(text), [text])
  const foldable = shouldFoldUser(text)
  const [expanded, setExpanded] = useState(false)
  const request = useExpandRequest(id)
  useEffect(() => {
    if (freshRequest(request)) setExpanded(true)
  }, [request])
  const folded = foldable && !expanded
  return (
    <div data-folded={folded || undefined}>
      <div className={cn('relative', folded && 'max-h-[12lh] overflow-hidden')}>
        {blocks.map((b, i) =>
          b.kind === 'code' ? (
            <CodeBlock key={i} code={b.code} lang={b.lang} className="my-2 whitespace-normal" />
          ) : (
            <UserText key={i} text={b.text} leading={i === 0} />
          ),
        )}
        {folded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-subtle to-transparent" />
        )}
      </div>
      {foldable && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
          className="press mt-1 inline-flex items-center gap-1 rounded-md text-meta whitespace-normal text-fg-muted hover:text-fg"
        >
          {expanded ? <ChevronUp size={13} strokeWidth={1.75} /> : <ChevronDown size={13} strokeWidth={1.75} />}
          {expanded ? tr('session.live.UserBody.collapse') : tr('session.live.UserBody.expand')}
        </button>
      )}
    </div>
  )
}

/**
 * 可折叠条目的展开状态：点击切换；对话内搜索的「展开」和搜索跳转也会让它展开（features/search/expand.ts）。
 * fold 放在条目根元素的 data-fold 上：对话内搜索据此知道哪些条目折叠着（docs/ui/conversation-ux.md §2.6）
 */
function useFold(id: string, foldable: boolean): { open: boolean; toggle: () => void; fold?: 'open' | 'closed' } {
  const [open, setOpen] = useState(false)
  const request = useExpandRequest(id)
  useEffect(() => {
    if (freshRequest(request)) setOpen(true)
  }, [request])
  return { open, toggle: () => setOpen(v => !v), fold: foldable ? (open ? 'open' : 'closed') : undefined }
}

function Chevron({ open }: { open: boolean }) {
  useI18n()
  return (
    <ChevronRight
      size={15}
      strokeWidth={1.5}
      className={cn('shrink-0 text-fg-muted transition-transform duration-(--dur-fast)', open && 'rotate-90')}
    />
  )
}

/**
 * 这次打开应用里看到的思考：开始时间、用时（只在内存里，重开会话后没有用时就显示「思考过程」）。
 * 引擎给了 durationMs 的用引擎的（Codex 的思考条目想完才发，这里只能看到 0 秒）
 */
const thinkingStart = new Map<string, number>()
const thinkingTook = new Map<string, number>()
/** 两张表只增不删（docs/perf-audit-2026-10-18.md D7）：超过上限丢最早的，最早的那些早已不在屏幕上 */
const THINKING_KEEP = 2000
function capThinking(map: Map<string, number>): void {
  while (map.size > THINKING_KEEP) map.delete(map.keys().next().value!)
}

/**
 * 思考过程：默认折叠；进行中显示「思考中 · 用时」，结束后「思考了 N 秒」（参照 Claude 桌面版）。
 * 思考内容被隐藏（显示思考摘要关着）时结束后仍留一行「思考了 N 秒」，不会出现又消失
 */
export function ReasoningBlock({ item }: { item: ItemOf<'reasoning'> }) {
  useI18n()
  const running = item.status === 'running'
  const look = rowLook(running, useLiveOwned())
  const hasText = !!item.text.trim()
  const { open, toggle, fold } = useFold(item.id, hasText)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!look.clock) return
    const timer = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(timer)
  }, [look.clock])
  if (running && !thinkingStart.has(item.id)) {
    thinkingStart.set(item.id, Date.now())
    capThinking(thinkingStart)
  }
  const started = thinkingStart.get(item.id)
  if (!running && started !== undefined && !thinkingTook.has(item.id)) {
    thinkingTook.set(item.id, Date.now() - started)
    capThinking(thinkingTook)
  }
  const took = (running ? undefined : item.durationMs) ?? thinkingTook.get(item.id) ?? null
  if (!running && !hasText && took === null) return null
  const elapsed = running && started !== undefined ? Date.now() - started : 0
  const label = running
    ? look.clock && elapsed >= 1000
      ? tr('session.live.thinkingFor', { time: formatDuration(elapsed) })
      : tr('session.live.ItemRows.thinking')
    : took !== null
      ? tr('session.live.thoughtFor', { time: formatDuration(took) })
      : tr('session.live.ItemRows.thinking2')
  if (!running && !hasText)
    return (
      <div data-step-row className="flex h-[30px] items-center gap-2 px-2 text-list text-fg-muted">
        <StatusDot status="none" />
        <Brain size={15} strokeWidth={1.5} className="shrink-0" />
        <span>{label}</span>
      </div>
    )
  return (
    <div data-fold={fold}>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        data-step-row
        className="flex h-[30px] items-center gap-2 rounded-md px-2 text-list text-fg-muted hover:bg-hover hover:text-fg-secondary"
      >
        {/* 思考完不打勾（每轮好几段，满屏绿勾太吵），只留位置让图标和工具行对齐 */}
        <StatusDot status={running ? 'running' : 'none'} still={!look.pulse} />
        <Brain size={15} strokeWidth={1.5} className={cn('shrink-0', running && 'text-active')} />
        <span className="tabular-nums">{label}</span>
        {!running && <Chevron open={open} />}
      </button>
      {open && item.text && (
        <div className="mt-1 ml-[15px] border-l border-line pl-3.5 text-meta leading-relaxed whitespace-pre-wrap text-fg-muted">
          {item.text}
        </div>
      )}
    </div>
  )
}

/** 行尾的说明：进行中、完成、失败在行首的状态点上（StatusDot），这里只写被拒绝、中断 */
function StatusMark({ status }: { status: ItemStatus }) {
  useI18n()
  switch (status) {
    case 'running':
    case 'completed':
    case 'failed':
      return null
    case 'declined':
      return (
        <span className="inline-flex shrink-0 items-center gap-1 text-meta text-fg-muted">
          <Ban size={12} strokeWidth={1.75} />
          {tr('session.live.ItemRows.denied')}
        </span>
      )
    case 'interrupted':
      return <span className="shrink-0 text-meta text-fg-muted">{tr('session.live.ItemRows.interrupted')}</span>
  }
}

const TOOL_META: Record<ToolKind, { icon: LucideIcon; verb: string }> = {
  read: {
    icon: FileText,
    get verb() {
      return tr('session.live.ItemRows.read')
    },
  },
  search: {
    icon: Search,
    get verb() {
      return tr('session.live.ItemRows.search')
    },
  },
  web: {
    icon: Globe,
    get verb() {
      return tr('session.live.ItemRows.web')
    },
  },
  mcp: { icon: Plug, verb: 'MCP' },
  task: {
    icon: Bot,
    get verb() {
      return tr('session.live.ItemRows.subtask')
    },
  },
  other: { icon: Wrench, verb: '' },
}

/**
 * 工具调用的行首（docs/ui/conversation-concise.md §7、§7.1）：状态点（橙色进行中、绿勾完成、红叉失败、空心被拒绝 / 中断）
 * 加类型图标；进行中图标也是橙色，动作上流过一道很淡的光，超过 3 秒在后面写用时
 */
function RunningIcon({ icon: Icon, status }: { icon: LucideIcon; status: ItemStatus }) {
  const look = rowLook(status === 'running', useLiveOwned())
  return (
    <>
      <StatusDot status={status} still={status === 'running' && !look.pulse} />
      <Icon
        size={15}
        strokeWidth={1.5}
        className={cn('shrink-0', status === 'running' ? 'text-active' : 'text-fg-muted')}
      />
    </>
  )
}
function StepClock({ id }: { id: string }) {
  const since = useSince(`step:${id}`, true)
  if (since < STEP_CLOCK_MS) return null
  return <span className="shrink-0 text-meta text-fg-faint tabular-nums">{clockText(since, formatDuration)}</span>
}

function Row({
  id,
  icon,
  verb,
  status,
  children,
  trailing,
  expandable,
  open,
  onToggle,
  action,
}: {
  id: string
  icon: LucideIcon
  verb: string
  status: ItemStatus
  children: ReactNode
  trailing?: ReactNode
  expandable: boolean
  open: boolean
  onToggle: () => void
  /** 行尾的额外按钮（放在行按钮外面，不能嵌套按钮） */
  action?: ReactNode
}) {
  useI18n()
  const running = status === 'running'
  const look = rowLook(running, useLiveOwned())
  const row = (
    <button
      type="button"
      aria-expanded={expandable ? open : undefined}
      aria-busy={running || undefined}
      onClick={expandable ? onToggle : undefined}
      data-step-row
      className={cn(
        'flex h-[30px] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-list',
        running ? 'text-fg' : 'text-fg-secondary',
        expandable ? 'hover:bg-hover' : 'cursor-default',
      )}
    >
      <RunningIcon icon={icon} status={status} />
      {verb && (
        <span data-tool-verb className={cn('shrink-0', look.shimmer && 'step-shimmer')}>
          {verb}
        </span>
      )}
      {children}
      {look.clock && <StepClock id={id} />}
      {trailing}
      <span className="flex-1" />
      {expandable && <Chevron open={open} />}
    </button>
  )
  if (!action) return row
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="min-w-0 flex-1">{row}</div>
      {action}
    </div>
  )
}

/** 在等审批的工具行：标「等你决定」，点了跳到下面那一项（docs/ui/approval-stack.md）。放在行按钮外面，不嵌套按钮 */
function WaitTag({ itemId }: { itemId: string }) {
  useI18n()
  const wait = useApprovalWait(itemId)
  if (!wait) return null
  return (
    <button
      type="button"
      data-approval-wait={wait.requestId}
      title={tr('approvals.locate')}
      onClick={() => locateApproval(wait.sessionId, wait.requestId)}
      className="press shrink-0 rounded-sm bg-warn/12 px-1.5 text-label text-warn hover:bg-warn/20"
    >
      {tr('approvals.waiting')}
    </button>
  )
}

/** 审批里选中了这一项：对话里这一行轻微高亮 */
function useApprovalSelected(itemId: string): boolean {
  const wait = useApprovalWait(itemId)
  return useSelectedApprovalItem(wait?.sessionId ?? null) === itemId
}

/** 工具行上的小标签：是哪个子智能体调用的 */
function SubagentTag({ name }: { name?: string }) {
  useI18n()
  if (!name) return null
  return (
    <span
      className="inline-flex max-w-40 shrink-0 items-center gap-1 rounded-sm bg-subtle px-1.5 text-label text-fg-muted"
      title={tr('session.live.ItemRows.subagentCall', { p0: name })}
    >
      <Bot size={11} strokeWidth={1.75} className="shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  )
}

const OUTPUT_BOX = 'mt-1 mb-1.5 ml-[23px] max-h-72 overflow-auto rounded-lg border border-line-card bg-subtle'

/** 长输出默认只显示头尾这么多行（参照 Codex / Claude Code 的「… +N 行」） */
const OUTPUT_HEAD = 120
const OUTPUT_TAIL = 120

/** 工具输出：太长时中间折起来，点一下看全部 */
const formatNumber = (n: number): string => n.toLocaleString()

function LongOutput({ text }: { text: string }) {
  useI18n()
  const [all, setAll] = useState(false)
  // 按字数折叠时不用按行切（几 MB 的输出每来一段都切一遍很费）
  const clipped = useMemo(() => clipOutput(text), [text])
  const lines = useMemo(() => (clipped ? [] : text.split('\n')), [text, clipped])
  const hidden = lines.length - OUTPUT_HEAD - OUTPUT_TAIL
  const button = (label: string, onClick: () => void): ReactNode => (
    <button
      type="button"
      onClick={onClick}
      className="my-1 block w-full rounded-md py-1 text-center font-sans text-meta text-accent-fg hover:bg-hover"
    >
      {label}
    </button>
  )
  // 很长的（通常是一两行几 MB）先按字数折叠，「显示全部」也有上限（outputClip.ts）
  if (clipped) {
    if (all)
      return (
        <>
          <AnsiText text={text.length > OUTPUT_ALL_MAX ? text.slice(0, OUTPUT_ALL_MAX) : text} />
          {text.length > OUTPUT_ALL_MAX && (
            <span className="my-1 block font-sans text-meta text-fg-muted">
              {tr('session.live.outputTooLong', { n: formatNumber(text.length - OUTPUT_ALL_MAX) })}
            </span>
          )}
          {button(tr('session.live.outputCollapse'), () => setAll(false))}
        </>
      )
    return (
      <>
        <AnsiText text={clipped.head} />
        {button(tr('session.live.outputShowAllChars', { n: formatNumber(clipped.hidden) }), () => setAll(true))}
        <AnsiText text={clipped.tail} />
      </>
    )
  }
  if (hidden <= 20) return <AnsiText text={text} />
  if (all)
    return (
      <>
        <AnsiText text={text} />
        {button(tr('session.live.outputCollapse'), () => setAll(false))}
      </>
    )
  return (
    <>
      <AnsiText text={lines.slice(0, OUTPUT_HEAD).join('\n')} />
      {button(tr('session.live.outputShowAll', { n: lines.length, m: hidden }), () => setAll(true))}
      <AnsiText text={lines.slice(-OUTPUT_TAIL).join('\n')} />
    </>
  )
}

/** 没有分类图标的工具：按工具名给本地化的动作（标题放内容），认不出的才显示原始工具名 */
const NAMED_VERBS: Record<string, TranslationKey> = {
  AskUserQuestion: 'session.live.tool.AskUserQuestion',
  ExitPlanMode: 'session.live.tool.ExitPlanMode',
  EnterPlanMode: 'session.live.tool.EnterPlanMode',
  Skill: 'session.live.tool.Skill',
  BashOutput: 'session.live.tool.BashOutput',
  KillShell: 'session.live.tool.KillShell',
  KillBash: 'session.live.tool.KillShell',
  ToolSearch: 'session.live.tool.ToolSearch',
  ListMcpResourcesTool: 'session.live.tool.ListMcpResourcesTool',
  ReadMcpResourceTool: 'session.live.tool.ReadMcpResourceTool',
}

function fileVerb(changes: FileChange[]): string {
  return changes.length === 1 && changes[0].kind === 'add'
    ? tr('session.live.ItemRows.create')
    : tr('session.live.ItemRows.edit')
}

/** 上一级文件夹名：同一次改动里有同名文件时写在文件名前（common/build.gradle） */
const parentName = (path: string): string =>
  baseName(path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))))

type PathClick = { title: string; 'data-path': string } & ReturnType<typeof pathClickHandlers>

/** 改文件的一行（一个文件）：有 diff 时点行展开 / 收起，打开编辑器用单独的图标；没有 diff 时点文件名直接打开 */
function FileChangeLine({
  item,
  change: c,
  dir,
  waitTag,
  changedClick,
}: {
  item: ItemOf<'file_change'>
  change: FileChange
  dir: string
  waitTag: ReactNode
  changedClick: (change: FileChange) => PathClick
}) {
  const foldable = !!c.diff
  const { open, toggle, fold } = useFold(item.id, foldable)
  const editing = item.status === 'running'
  const look = rowLook(editing, useLiveOwned())
  const name = (
    <>
      {dir && <span className="text-fg-muted">{dir}/</span>}
      {baseName(c.path)}
    </>
  )
  const summary = (
    <>
      <RunningIcon icon={c.kind === 'add' ? FilePlus : FilePen} status={item.status} />
      <span data-tool-verb className={cn('shrink-0', look.shimmer && 'step-shimmer')}>
        {fileVerb([c])}
      </span>
      <div className="flex min-w-0 flex-1 overflow-hidden">
        {foldable ? (
          <span title={c.path} className="truncate font-mono text-meta text-code-path">
            {name}
          </span>
        ) : (
          <button
            type="button"
            {...changedClick(c)}
            className="truncate text-left font-mono text-meta text-code-path hover:underline"
          >
            {name}
          </button>
        )}
      </div>
      {look.clock && <StepClock id={item.id} />}
      {(c.added > 0 || c.removed > 0) && <DiffStat added={c.added} removed={c.removed} className="text-meta" />}
      <StatusMark status={item.status} />
      <SubagentTag name={item.subagent} />
    </>
  )
  if (!foldable)
    return (
      <div
        data-step-row
        className="flex min-h-[30px] min-w-0 items-center gap-2 rounded-md px-2 text-list text-fg-secondary"
      >
        {summary}
        {waitTag}
      </div>
    )
  return (
    <div data-fold={fold}>
      <div className="group/file flex min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          title={tr(open ? 'session.ChangedFilesCard.hideChanges' : 'session.ChangedFilesCard.showChanges')}
          onClick={toggle}
          data-step-row
          className="flex min-h-[30px] min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-list text-fg-secondary hover:bg-hover"
        >
          {summary}
          <Chevron open={open} />
        </button>
        {waitTag}
        <span className={cn('opacity-0 group-hover/file:opacity-100 focus-within:opacity-100', open && 'opacity-100')}>
          <IconButton
            icon={SquareArrowOutUpRight}
            label={tr('session.ChangedFilesCard.openInEditor')}
            size={24}
            iconSize={13}
            {...changedClick(c)}
          />
        </span>
      </div>
      {open && (
        <div className={cn(OUTPUT_BOX, 'bg-surface py-1.5')}>
          <DiffView diff={c.diff} path={c.path} />
        </div>
      )}
    </div>
  )
}

/** 工具调用的一行：运行命令 / 编辑文件 / 读取 / 搜索 / 网页 / MCP / 子任务；点开看输出或 diff。条目没变就不重新渲染 */
export const ToolItemRow = memo(function ToolItemRow({ item }: { item: ItemOf<'command' | 'file_change' | 'tool'> }) {
  useI18n()
  const images = item.kind === 'tool' ? (item.images ?? []) : []
  const viewedImage = item.kind === 'tool' && item.name === 'imageView' && !images.length ? item.title : null
  // 已经显示成图片的，不再在文字框里重复一行「[图片]」；只剩占位时文字框整个不显示
  const output = item.kind === 'file_change' ? '' : withoutShownImagePlaceholders(item.output, images.length)
  const foldable =
    item.kind === 'file_change' ? item.changes.some(c => c.diff) : !!output || images.length > 0 || !!viewedImage
  const { open, toggle, fold } = useFold(item.id, foldable)
  const row = useRef<HTMLDivElement>(null)
  const [fileError, setFileError] = useState('')
  const waiting = !!useApprovalWait(item.id)
  const waitTag = waiting ? <WaitTag itemId={item.id} /> : null
  const approvalSelected = useApprovalSelected(item.id)
  const rowClass = cn('rounded-md', approvalSelected && 'bg-hover')
  const openTrace = useOpenTrace()
  const toast = useToast()
  const code = useAppMode() === 'code'
  const changedRef = () => {
    const sessionId = row.current?.closest<HTMLElement>('[data-search-session]')?.dataset.searchSession
    return sessionId ? { sessionId } : getActiveWorkspace().ref
  }
  const openChangedFile = (change: FileChange): void => {
    const ref = changedRef()
    if (!ref) return
    const added = change.diff
      .split('\n')
      .filter(l => l.startsWith('+') && !l.startsWith('+++'))
      .map(l => l.slice(1))
      .join('\n')
    void openFile(ref, change.path, undefined, 1, change.newText || added).catch(e => setFileError(e.message))
  }
  /** 单击打开、双击在文件夹中显示（docs/ui/path-click.md）；远程机器不能显示，提示只写单击打开 */
  const changedClick = (change: FileChange) => {
    const ref = changedRef()
    const reveal = ref ? () => void revealPath(ref, change.path, toast) : null
    return {
      title: pathHint(ref, change.path),
      'data-path': change.path,
      ...pathClickHandlers({ open: () => openChangedFile(change), reveal }),
    }
  }

  if (item.kind === 'command') {
    const verb = item.status === 'running' ? tr('session.live.ItemRows.running') : tr('session.live.ItemRows.ran')
    return (
      <div ref={row} data-fold={fold} className={rowClass}>
        <Row
          id={item.id}
          icon={SquareTerminal}
          verb={verb}
          status={item.status}
          expandable={!!item.output || hasWrapperExtra(item.wrapper)}
          open={open}
          onToggle={toggle}
          action={
            (waiting || code) && (
              <>
                {waitTag}
                {code && (
                  <button
                    type="button"
                    onClick={() => {
                      const ref = changedRef()
                      const sessionId = ref && 'sessionId' in ref ? ref.sessionId : undefined
                      if (sessionId) revealAiCommand(sessionId, item.id)
                    }}
                    className="shrink-0 rounded-md px-2 py-1 text-meta text-accent-fg hover:bg-hover"
                  >
                    {tr('coding.shell.viewInTerminal')}
                  </button>
                )}
              </>
            )
          }
          trailing={
            <>
              <StatusMark status={item.status} />
              {hasWrapperExtra(item.wrapper) && (
                <span className="shrink-0 rounded-sm bg-warn/12 px-1.5 py-px text-label text-warn">
                  {tr('approvals.wrapped')}
                </span>
              )}
              {item.status !== 'running' && item.exitCode !== null && item.exitCode !== 0 && (
                <span className="shrink-0 text-meta text-danger tabular-nums">
                  {tr('session.live.exitCode', { n: item.exitCode })}
                </span>
              )}
              <SubagentTag name={item.subagent} />
            </>
          }
        >
          <code
            data-tool-arg
            className="truncate rounded-sm bg-subtle px-1.5 py-0.5 font-mono text-[length:calc(12.5px*var(--font-scale,1))] text-fg"
            title={
              item.description ??
              (item.wrapper ? tr('approvals.fullCommandTip', { line: item.wrapper.line }) : item.command)
            }
          >
            <CommandText command={item.command} />
          </code>
        </Row>
        {open && (item.output || hasWrapperExtra(item.wrapper)) && (
          <pre
            className={cn(OUTPUT_BOX, 'p-3 font-mono text-meta leading-[1.6] whitespace-pre-wrap text-fg-secondary')}
          >
            {item.wrapper && (
              <span className="mb-1 block break-all select-text">
                <span className="font-sans text-fg-muted">{tr('approvals.fullCommand')}</span> {item.wrapper.line}
              </span>
            )}
            {item.output && <LongOutput text={item.output} />}
          </pre>
        )}
      </div>
    )
  }

  if (item.kind === 'file_change') {
    // 一次改了几个文件就拆成几行，每行只写文件名、各自展开自己的 diff；完整路径在悬停提示里
    const names = item.changes.map(c => baseName(c.path))
    return (
      <div ref={row} className={rowClass}>
        {item.changes.map((c, i) => (
          <FileChangeLine
            key={c.path}
            item={item}
            change={c}
            dir={names.indexOf(names[i]) !== names.lastIndexOf(names[i]) ? parentName(c.path) : ''}
            waitTag={i === 0 ? waitTag : null}
            changedClick={changedClick}
          />
        ))}
        {fileError && (
          <p role="status" className="px-2 text-meta text-danger">
            {fileError}
          </p>
        )}
      </div>
    )
  }

  const meta = TOOL_META[item.tool]
  // 子任务（Agent 工具）和多智能体编排（Workflow 工具）可以打开智能体追踪
  const traceable = !!openTrace && item.tool === 'task' && !item.subagent
  const named = NAMED_VERBS[item.name]
  const verb =
    item.name === 'Workflow' ? tr('session.live.ItemRows.orchestration') : named ? tr(named) : meta.verb || item.name
  // 提交计划：展开看的是计划正文（Markdown），批准之后对话里还在
  const plan = item.name === 'ExitPlanMode'
  return (
    <div ref={row} data-fold={fold} className={rowClass}>
      <Row
        id={item.id}
        icon={plan ? ListTodo : meta.icon}
        verb={verb}
        status={item.status}
        expandable={foldable}
        open={open}
        onToggle={toggle}
        trailing={
          <>
            <StatusMark status={item.status} />
            {images.length > 0 && (
              <span className="shrink-0 text-meta text-fg-faint">
                {tr('session.live.viewedImages', { n: images.length })}
              </span>
            )}
            <SubagentTag name={item.subagent} />
          </>
        }
        action={
          waiting || traceable ? (
            <>
              {waitTag}
              {traceable && (
                <button
                  type="button"
                  onClick={() => openTrace?.({ toolUseId: item.id })}
                  className="shrink-0 rounded-md px-1.5 py-1 text-meta text-accent-fg hover:bg-hover"
                >
                  {tr('session.live.ItemRows.viewActivity')}{' '}
                </button>
              )}
            </>
          ) : undefined
        }
      >
        <span data-tool-arg className="truncate text-fg-muted" title={item.title}>
          {item.title}
        </span>
      </Row>
      {open &&
        output &&
        (plan ? (
          <div className={cn(OUTPUT_BOX, 'max-h-[28rem] bg-surface px-4 py-3')}>
            <Markdown text={output} />
          </div>
        ) : (
          <pre
            className={cn(OUTPUT_BOX, 'p-3 font-mono text-meta leading-[1.6] whitespace-pre-wrap text-fg-secondary')}
          >
            <LongOutput text={output} />
          </pre>
        ))}
      {open && images.length > 0 && (
        <div className="mt-1 mb-1.5 ml-[23px]">
          <ImageAttachments images={images} itemId={item.id} />
        </div>
      )}
      {open && viewedImage && (
        <div className="mt-1 mb-1.5 ml-[23px]">
          <MarkdownImage src={viewedImage} />
        </div>
      )}
    </div>
  )
})

/** 待办清单（Claude 的 TodoWrite、Codex 的计划）：一行概要，点开看完整列表；当前计划常驻在进度卡片里（docs/ui/progress-card.md §5） */
export function TodoCard({ item }: { item: ItemOf<'todo'> }) {
  useI18n()
  const { open, toggle, fold } = useFold(item.id, item.steps.length > 0)
  if (item.steps.length === 0) return null
  const done = item.steps.filter(s => s.status === 'completed').length
  const current = item.steps.find(s => s.status === 'in_progress')
  const note = current
    ? tr('session.todo.current', { text: current.text })
    : done === item.steps.length
      ? tr('session.todo.allDone')
      : null
  return (
    <div data-fold={fold}>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        data-step-row
        className="flex h-[30px] max-w-full min-w-0 items-center gap-2 rounded-md px-2 text-list text-fg-muted hover:bg-hover hover:text-fg-secondary"
      >
        {/* 历史里的待办只是当时的快照，不标「进行中」；正在做的看「正在执行」那一行和进度卡片 */}
        <StatusDot status={done === item.steps.length ? 'completed' : 'pending'} />
        <ListTodo size={15} strokeWidth={1.5} className="shrink-0" />
        <span className="shrink-0">{tr('session.live.ItemRows.toDo')}</span>
        <span className="shrink-0 text-meta text-fg-faint tabular-nums">
          {done}/{item.steps.length}
        </span>
        {note && <span className="min-w-0 truncate text-fg-faint">{note}</span>}
        <Chevron open={open} />
      </button>
      {open && (
        <ul className="mt-1 ml-[15px] flex flex-col gap-1 border-l border-line pl-3.5">
          {item.steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-list">
              <StepMark status={s.status} live={false} />
              <span
                className={cn(
                  s.status === 'completed' ? 'text-fg-muted line-through' : 'text-fg',
                  s.status === 'in_progress' && 'font-medium',
                )}
              >
                {s.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 提示：信息 / 警告 / 错误 */
export function NoticeRow({ item, sessionId }: { item: ItemOf<'notice'>; sessionId?: string | null }) {
  useI18n()
  // 接着终端里的会话时提示右边的按钮：加载更早的 / 补上终端里新聊的 N 轮（docs/ui/claude-resume.md §4.8）
  const [actionError, setActionError] = useState<string | null>(null)
  const Icon = item.level === 'error' ? CircleAlert : item.level === 'warn' ? TriangleAlert : Info
  // 后台任务结束、自动换了账号的提示带结构化信息时按界面语言重新拼（引擎的 text 是中文）
  const text = item.task
    ? taskNoticeText(item.task)
    : item.account
      ? accountNoticeText(item.account, Date.now())
      : translateMessage(item.text)
  // 引擎给了原始报错详情（附加说明、错误类型、HTTP 状态码）时可展开查看和复制
  const detail = item.detail?.trim() || null
  // 很长的提示（子智能体带回的整份报告）只显示前几行，展开后按 Markdown 显示（docs/ui/minimal-mode.md §7）
  const long = foldNotice(text)
  const { open, toggle, fold } = useFold(item.id, !!detail || !!long)
  return (
    <div
      data-fold={fold}
      data-notice-level={item.level}
      className={cn(
        'rounded-lg px-3 py-2 text-list',
        item.level === 'error' && 'border border-danger/30 bg-danger/5 text-danger',
        item.level === 'warn' && 'text-warn',
        item.level === 'info' && 'text-fg-muted',
      )}
    >
      <div className="flex items-start gap-2">
        <Icon size={15} strokeWidth={1.5} className="mt-[2px] shrink-0" />
        {long ? (
          <Markdown text={open ? text : long.preview} className="selectable min-w-0 flex-1 text-fg-secondary" />
        ) : (
          <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{text}</span>
        )}
        {item.action && sessionId && (
          <NativeNoticeAction action={item.action} sessionId={sessionId} onError={setActionError} />
        )}
        {(detail || long) && (
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className={cn(
              'press -my-0.5 inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-meta opacity-80 hover:opacity-100',
              item.level === 'error' ? 'hover:bg-danger/10' : 'hover:bg-hover',
            )}
          >
            {open
              ? tr('session.notice.hideDetail')
              : tr(detail ? 'session.notice.showDetail' : 'session.notice.showAll')}
            <ChevronRight
              size={13}
              strokeWidth={1.5}
              className={cn('transition-transform duration-(--dur-fast)', open && 'rotate-90')}
            />
          </button>
        )}
      </div>
      {/* 自动换了账号：换回去 / 关闭自动切换放在文字下面一行（文字长，放右边会把它挤成一窄条） */}
      {item.account && (
        <div className="mt-1 ml-[23px]">
          <AccountNoticeActions account={item.account} onError={setActionError} />
        </div>
      )}
      {actionError && (
        <p role="alert" className="mt-1 ml-[23px] text-meta text-danger">
          {translateMessage(actionError)}
        </p>
      )}
      {detail && open && (
        <div
          data-notice-detail
          className="mt-2 ml-[23px] rounded-md border border-line-subtle bg-surface/70 text-fg-secondary"
        >
          <pre className="selectable max-h-60 overflow-auto px-3 py-2 font-mono text-meta break-all whitespace-pre-wrap">
            {detail}
          </pre>
          <div className="flex justify-end border-t border-line-subtle px-1.5 py-1">
            <CopyButton text={`${text}\n${detail}`} label={tr('session.notice.copyDetail')} />
          </div>
        </div>
      )}
    </div>
  )
}
