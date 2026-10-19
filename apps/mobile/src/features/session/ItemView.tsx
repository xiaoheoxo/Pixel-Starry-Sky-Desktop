// 对话流（docs/mobile-remote.md §21.12）：按 protocol 的 foldTurns 折出来的条目逐条显示。
// 你的消息右对齐气泡；回复是左侧白卡 + Markdown；思考「思考了 N 秒 ›」点开看原文；
// 一段过程收成一行「做了 N 步 · 改了 3 个文件 +40 −12 ›」，点开是底部面板（ProcessSheet）。
// 图片点开再向电脑取；回复可以复制；最近一轮出错时错误下面有「重试」（§17）。
import { useState, type ReactNode } from 'react'
import { Check, ChevronRight, CircleAlert, FileText, ListTodo, RotateCcw, X } from 'lucide-react'
import type { Item, TurnEntry } from '@pixelsky/protocol'
import { latestTodo, processLine, stepCount, thinkingLabel } from '@/data/turns'
import { Button, Dot, Spinner, Typing, cn } from '@/ui'
import { CopyButton } from '@/ui/code'
import { MarkdownText } from '@/ui/Markdown'
import { Sheet } from '@/ui/sheet'
import { ProcessSheet } from './ProcessSheet'
import { MessageImages, TodoCard, type TurnActions } from './steps'

export type { TurnActions } from './steps'

interface Props {
  entry: TurnEntry
  /** 是不是对话里最后一条（等审批的标记只给它） */
  last: boolean
  /** 在等用户审批 / 回答（不是在思考） */
  waiting: boolean
  truncated: string[]
  onDetail(itemId: string): void
  actions: TurnActions
}

export function EntryView({ entry, last, waiting, truncated, onDetail, actions }: Props) {
  const more = (id: string) =>
    truncated.includes(id) && (
      <button type="button" onClick={() => onDetail(id)} className="mt-1.5 text-meta font-medium text-accent-fg">
        内容较长，查看完整 ›
      </button>
    )
  if (entry.type === 'process') {
    return <Process entry={entry} waiting={waiting && last} more={more} actions={actions} />
  }
  const item = entry.item
  switch (item.kind) {
    case 'user':
      // 断线后电脑自动发的「继续」：一行小字，不当成你说的话
      if (item.reconnect) return <p className="text-label text-fg-faint">已自动重连 · 第 {item.reconnect} 次</p>
      if (item.dismissed)
        return (
          <div className="flex flex-col items-end gap-1">
            <div className="w-full opacity-55">
              <UserBubble item={item} more={more(item.id)} actions={actions} />
            </div>
            <p className="text-label text-fg-faint">
              <span className="text-warn">未送达</span> · 已关掉
            </p>
          </div>
        )
      return <UserBubble item={item} more={more(item.id)} actions={actions} />
    case 'assistant':
      return <AssistantCard item={item} more={more(item.id)} truncated={truncated.includes(item.id)} />
    case 'reasoning':
      return <Thinking item={item} />
    case 'todo':
      return <PlanRow items={[item]} />
    case 'notice':
      return item.level === 'info' ? null : <NoticeBar item={item} actions={actions} />
    case 'compaction':
      return (
        <p className="self-center text-label text-fg-faint">
          {item.status === 'running' ? '正在压缩…' : '上下文已压缩'}
        </p>
      )
    case 'turn_stats':
      return item.outcome === 'interrupted' ? (
        <div className="flex items-center gap-1.5 text-label text-fg-faint">
          <X size={12} /> 已停止
        </div>
      ) : null
    default:
      return null
  }
}

/** 运行中、最后一条还是你的消息：回复还没开始 */
export function ThinkingRow() {
  return (
    <div className="flex items-center gap-2 text-meta text-fg-muted">
      正在思考 <Typing />
    </div>
  )
}

function UserBubble({
  item,
  more,
  actions,
}: {
  item: Extract<Item, { kind: 'user' }>
  more: ReactNode
  actions: TurnActions
}) {
  return (
    <div className="flex flex-col items-end pl-10">
      {item.mode === 'guidance' && <span className="mb-0.5 pr-1 text-label text-fg-faint">补充</span>}
      {(item.text || (!item.files?.length && !item.attachments?.length)) && (
        <div className="rounded-2xl rounded-br-md bg-bubble-user px-3.5 py-2.5 text-prose break-words whitespace-pre-wrap text-bubble-user-fg">
          {item.text}
        </div>
      )}
      {!!item.attachments?.length && (
        <div className="mt-1.5">
          <MessageImages itemId={item.id} images={item.attachments} actions={actions} align="end" />
        </div>
      )}
      {!!item.files?.length && (
        <span className="mt-1 flex max-w-full items-center gap-1 text-meta text-fg-muted">
          <FileText size={14} className="shrink-0" />
          <span className="truncate">{item.files.map(f => f.name).join('、')}</span>
        </span>
      )}
      {more}
    </div>
  )
}

/** 回复：左侧白卡 + Markdown；说完了才有小复制图标（被截断的先「查看完整」再复制，免得复制不全） */
function AssistantCard({
  item,
  more,
  truncated,
  copy = true,
}: {
  item: Extract<Item, { kind: 'assistant' }>
  more: ReactNode
  truncated: boolean
  copy?: boolean
}) {
  const running = item.status === 'running'
  if (!item.text.trim() && !running) return null
  return (
    <div className="max-w-full self-start rounded-2xl rounded-bl-md border border-line-subtle bg-card-assistant px-3.5 py-3">
      <MarkdownText text={item.text} />
      {running && (
        <div className={item.text ? 'mt-1.5' : undefined}>
          <Typing />
        </div>
      )}
      {more}
      {copy && !running && item.text && !truncated && (
        <CopyButton text={item.text} label="" className="mt-0.5 -mb-1 -ml-2" />
      )}
    </div>
  )
}

/** 「思考了 4 秒 ›」，点开看原文；没有文字也没有计时就不显示 */
function Thinking({ item }: { item: Extract<Item, { kind: 'reasoning' }> }) {
  const [open, setOpen] = useState(false)
  const label = thinkingLabel(item)
  if (!label) return null
  const canOpen = !!item.text.trim()
  return (
    <div className="flex flex-col items-start">
      <button
        type="button"
        onClick={() => canOpen && setOpen(o => !o)}
        className="flex min-h-8 items-center gap-1 text-meta text-fg-muted"
      >
        {label}
        {canOpen && <ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} />}
      </button>
      {open && (
        <p className="mt-1 border-l-2 border-line-subtle pl-3 text-meta whitespace-pre-wrap text-fg-muted">
          {item.text}
        </p>
      )}
    </div>
  )
}

/** warn / error 的居中提示条；error 挂着「重试」时带按钮 */
function NoticeBar({ item, actions }: { item: Extract<Item, { kind: 'notice' }>; actions: TurnActions }) {
  return (
    <div
      className={cn(
        'flex max-w-full items-start gap-2 self-center rounded-xl bg-subtle px-3 py-2.5 text-meta',
        item.level === 'error' ? 'text-danger' : 'text-warn',
      )}
    >
      <CircleAlert size={15} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">
        {item.text}
        {item.id === actions.retryId && (
          <span className="mt-2 flex">
            <Button size="sm" disabled={actions.retrying} onClick={actions.retry}>
              {actions.retrying ? <Spinner size={12} /> : <RotateCcw size={14} />} 重试
            </Button>
          </span>
        )}
      </span>
    </div>
  )
}

/** 一段过程：一行摘要（点开 ProcessSheet）、有待办时多一行进度；运行中把正在输出的回复照常显示在下面 */
function Process({
  entry,
  waiting,
  more,
  actions,
}: {
  entry: Extract<TurnEntry, { type: 'process' }>
  waiting: boolean
  more(id: string): ReactNode
  actions: TurnActions
}) {
  const [open, setOpen] = useState(false)
  const { items, running } = entry
  const steps = stepCount(items)
  const todo = latestTodo(items)
  // 运行中 foldTurns 把正在输出的回复留在过程里，手机只显示摘要行的话它会一直看不见
  // 回复后面可能还跟着思考、空白文字、信息提示（foldTurn 也不把它们算作「又干了活」），从后往前跳过它们
  const tail = running
    ? items.findLast(
        i =>
          !(
            i.kind === 'reasoning' ||
            (i.kind === 'notice' && i.level === 'info') ||
            (i.kind === 'assistant' && !i.text.trim())
          ),
      )
    : undefined
  const reply = tail?.kind === 'assistant' ? tail : null
  const line = processLine(items)
  return (
    <div className="flex flex-col items-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-9 max-w-full items-center gap-2 rounded-full py-1 pr-2 text-meta text-fg-muted"
      >
        {waiting ? (
          <Dot tone="danger" />
        ) : running ? (
          <Spinner size={12} className="text-fg-faint" />
        ) : (
          <Check size={14} className="text-fg-faint" />
        )}
        <span className="min-w-0 truncate">
          {waiting ? (
            `等你允许${steps ? ` · ${steps} 步` : ''}`
          ) : running ? (
            `正在执行${steps ? ` · ${steps} 步` : ''}`
          ) : line ? (
            <LineText line={line} />
          ) : (
            '过程'
          )}
        </span>
        <ChevronRight size={14} className="shrink-0" />
      </button>
      {todo && <PlanRow items={items} onOpen={() => setOpen(true)} />}
      {reply && (
        <div className="mt-2 flex w-full flex-col">
          <AssistantCard item={reply} more={more(reply.id)} truncated={false} copy={false} />
        </div>
      )}
      {open && (
        <ProcessSheet
          title={line || '过程'}
          items={items}
          more={more}
          actions={actions}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

/** 「计划 3/5 · 当前这一步 ›」一行；单独的待办点开是只有这份清单的面板，过程里的由外面传 onOpen 打开过程面板 */
function PlanRow({ items, onOpen }: { items: Item[]; onOpen?: () => void }) {
  const [open, setOpen] = useState(false)
  const todo = latestTodo(items)
  const card = items.findLast(i => i.kind === 'todo')
  if (!todo || card?.kind !== 'todo') return null
  return (
    <>
      <button
        type="button"
        onClick={onOpen ?? (() => setOpen(true))}
        className="flex min-h-8 max-w-full items-center gap-1.5 self-start text-meta text-fg-muted"
      >
        <ListTodo size={14} className="shrink-0" />
        <span className="shrink-0">
          计划 {todo.at}/{todo.total}
        </span>
        {todo.current && <span className="truncate text-fg-faint">· {todo.current}</span>}
        <ChevronRight size={14} className="shrink-0" />
      </button>
      {open && (
        <Sheet title={`计划 ${todo.at}/${todo.total}`} onClose={() => setOpen(false)}>
          <div className="px-4 py-3">
            <TodoCard item={card} />
          </div>
        </Sheet>
      )}
    </>
  )
}

/** 摘要行里「N 步失败」标红 */
function LineText({ line }: { line: string }) {
  return (
    <>
      {line.split(' · ').map((p, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {p.endsWith('步失败') ? <span className="text-danger">{p}</span> : p}
        </span>
      ))}
    </>
  )
}
