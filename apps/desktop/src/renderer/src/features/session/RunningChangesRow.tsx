import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, ScanEye } from 'lucide-react'
import type { Item } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { DiffStat, cn } from '@/ui'
import type { ChangedFile } from '@/data'
import { useAppMode } from '@/features/coding/mode'
import { reviewTurn, reviewTurnFile } from '@/features/panel/artifacts/focus'
import { BouncingDiffStat } from './BouncingDiffStat'
import { latestFile, runningChanges, type RunningChanges } from './runningChanges'

/** 正在跑的这一轮已经改完的文件；代码模式没有：左边已经有「AI 这一轮改的」 */
export function useRunningChanges(items: readonly Item[], running: boolean): RunningChanges | null {
  const code = useAppMode() === 'code'
  const last = useRef<RunningChanges | null>(null)
  return useMemo(
    () => (last.current = running && !code ? runningChanges(items, last.current) : null),
    [items, running, code],
  )
}

/**
 * 对话末尾的进度行：左边是在做什么（LiveStatusLine），最右边是这一轮已经改完的文件「N 个文件 +A −B ›」
 * （docs/ui/changes-bar.md）。点一下在下面展开列表；这一轮结束就收起，由对话里的改动卡片接着显示。
 * 对话往上滚时贴在对话底部（样式在 conversation.css 的 [data-live-row]）。
 */
export function RunningChangesRow({
  changes,
  sessionId,
  onExpand,
  jump,
  children,
}: {
  changes: RunningChanges | null
  sessionId: string
  /** 展开前调用：贴着底时要接着跟到底 */
  onExpand: () => void
  /** 「回到最新」：浮在这一行上面 */
  jump: ReactNode
  /** 在做什么；等你批准、压缩时没有，只剩改动 */
  children: ReactNode
}) {
  // 展开的是哪一轮：新的一轮从收起开始（一轮结束整行卸载）
  const [openTurn, setOpenTurn] = useState<string | null>(null)
  const listId = useId()
  const turn = changes?.userItemId ?? 'start'
  const open = !!changes && openTurn === turn
  return (
    <div data-live-row className="conversation-message">
      {jump && (
        // 点它不算在对话里操作（INTERACT_MS），和不在这一行里时一样
        <div className="absolute inset-x-0 bottom-full" onPointerDown={e => e.stopPropagation()}>
          {jump}
        </div>
      )}
      <div data-live-row-body className="flex flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          {children}
          {changes && (
            <Toggle
              changes={changes}
              open={open}
              listId={listId}
              onToggle={() => {
                if (!open) onExpand()
                setOpenTurn(open ? null : turn)
              }}
            />
          )}
        </div>
        {open && <FileList id={listId} sessionId={sessionId} changes={changes} />}
      </div>
    </div>
  )
}

function Toggle({
  changes: { data },
  open,
  listId,
  onToggle,
}: {
  changes: RunningChanges
  open: boolean
  listId: string
  onToggle: () => void
}) {
  useI18n()
  const n = data.files.length
  return (
    <button
      type="button"
      data-running-changes
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-label={`${tr('session.runningChanges.title', { n })} +${data.added} −${data.removed}`}
      title={tr('session.runningChanges.title', { n })}
      onClick={onToggle}
      className={cn(
        'press ml-auto inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-subtle pr-1 pl-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg',
        open && 'bg-hover text-fg',
      )}
    >
      {/* 很窄的分屏里只留增删数 */}
      <span className="@max-[26rem]/conversation:hidden">{tr('session.runningChanges.files', { n })}</span>
      <BouncingDiffStat added={data.added} removed={data.removed} />
      <ChevronRight
        size={14}
        strokeWidth={1.5}
        className={cn('shrink-0 text-fg-muted transition-transform duration-(--dur-fast)', open && 'rotate-90')}
      />
    </button>
  )
}

function FileList({ id, sessionId, changes }: { id: string; sessionId: string; changes: RunningChanges }) {
  useI18n()
  const { data, userItemId } = changes
  const groups = data.groups ?? [{ key: 'main', label: null, ...data }]
  const latest = latestFile(changes)
  const openFile = (f: ChangedFile): void => reviewTurnFile(sessionId, userItemId, f.dir + f.name)
  return (
    <div id={id} data-running-changes-list className="ml-3.5 border-l-2 border-line-subtle pl-1.5">
      {/* 自己滚，滚到头接着滚对话；最多占对话区（conversation-body）的四成，贴底时不把对话全盖住 */}
      <div className="max-h-[min(40cqh,18rem)] overflow-y-auto">
        {groups.map(group => (
          <section key={group.key} className="not-first:mt-1">
            {(group.label || groups.length > 1) && (
              <h3 className="flex items-center gap-2 px-2 pt-1 pb-0.5 text-label font-semibold text-fg-muted">
                <span className="min-w-0 flex-1 truncate">{group.label || tr('session.runningChanges.main')}</span>
                <DiffStat added={group.added} removed={group.removed} className="font-normal" />
              </h3>
            )}
            <ul>
              {group.files.map(f => (
                <li key={f.dir + f.name}>
                  <FileRow file={f} hot={latest === `${group.key}:${f.dir}${f.name}`} onOpen={() => openFile(f)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <button
        type="button"
        onClick={() => reviewTurn(sessionId, userItemId)}
        className="mt-1 inline-flex h-7 items-center gap-2 rounded-md px-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg"
      >
        <ScanEye size={14} strokeWidth={1.5} className="shrink-0" />
        {tr('session.ChangedFilesCard.review')}
      </button>
    </div>
  )
}

/** 一个文件一行；hot：刚改完的那个 */
function FileRow({ file, hot, onOpen }: { file: ChangedFile; hot: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      title={file.dir + file.name}
      onClick={onOpen}
      className={cn(
        'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-meta text-fg hover:bg-hover',
        hot && 'bg-accent-soft/60',
      )}
    >
      <span
        aria-label={tr(file.created ? 'session.runningChanges.added' : 'session.runningChanges.modified')}
        className={cn('w-3 shrink-0 text-center font-mono font-semibold', file.created ? 'text-success' : 'text-warn')}
      >
        {file.created ? 'A' : 'M'}
      </span>
      <span className="max-w-[70%] shrink-0 truncate">{file.name}</span>
      <span className="min-w-0 flex-1 truncate text-fg-faint">{file.dir}</span>
      <DiffStat added={file.added} removed={file.removed} className="shrink-0" />
    </button>
  )
}
