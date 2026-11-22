import { translateMessage } from '../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import {
  CheckCheck,
  ChevronRight,
  FileDiff,
  Redo2,
  ScanEye,
  ScanSearch,
  SquareArrowOutUpRight,
  Undo2,
} from 'lucide-react'
import { Button, DiffStat, IconButton, cn, useComingSoon, useToast } from '@/ui'
import { DiffView } from '@/ui/code/DiffView'
import { changedFiles, type ChangedFile, type ChangedFiles } from '@/data'
import { openFile } from '@/features/files/store'
import { pathClickHandlers } from '@/ui/pathClick'
import { isRemoteRef, pathHint, revealPath } from '@/features/files/reveal'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { isDemo, projects } from '@/data'
import { useState, type CSSProperties } from 'react'
import { useAppMode } from '@/features/coding/mode'
import { openCodeDiff } from '@/features/coding/editor'

/** 撤回这一轮的改动（docs/ui/undo-changes.md §3）；路径是卡片里的 dir + name */
export interface CardUndo {
  /** 不能撤回的原因（运行中、没有快照等）；null 可以撤回 */
  disabledReason: string | null
  reverted: ReadonlySet<string>
  pending: boolean
  revert: (paths: string[]) => void
  restore: (paths: string[]) => void
}

/**
 * 改动文件卡片；data 不传时用演示数据。
 * 真实会话里没做好的按钮不显示（docs/ui/conversation-ux.md §2.1）：「审查」要传 onReview，撤回要传 undo。
 * 点文件行在卡片里展开这一轮的 diff，行尾图标打开编辑器；没有 diff 的文件点行直接打开（docs/ui/changes-inline-diff.md）。
 */
export function ChangedFilesCard({
  className,
  data = changedFiles,
  target,
  onReview,
  onKeepAll,
  undo,
  style,
  aiReview,
  inlineHistory = false,
}: {
  className?: string
  style?: CSSProperties
  data?: ChangedFiles | null
  target?: WorkspaceRef
  onReview?: () => void
  /** 代码模式：整轮标记为已审查 */
  onKeepAll?: () => void
  undo?: CardUndo | null
  /** 「AI 审查」（docs/ui/review-pr-actions.md §2）：不传不显示 */
  aiReview?: { onClick: () => void; running: boolean } | null
  /** 对话总览展示已记录的补丁，不打开工作区当前的 diff。 */
  inlineHistory?: boolean
}) {
  useI18n()
  const comingSoon = useComingSoon()
  const toast = useToast()
  const code = useAppMode() === 'code' && !inlineHistory
  const [error, setError] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  if (!data) return null
  const codeRef = target ?? (isDemo && projects[0] ? { projectId: projects[0].id } : null)
  const firstDiff = data.files.find(f => f.diffs?.length) ?? data.files[0]
  // 代码模式：「审查」打开第一个文件的变更（中栏）
  const codeReview =
    code && codeRef && firstDiff
      ? () => void openCodeDiff(codeRef, firstDiff.dir + firstDiff.name).catch(e => setError(e.message))
      : null
  const review = codeReview ?? onReview ?? (isDemo ? () => comingSoon(tr('session.ChangedFilesCard.review')) : null)
  /** 一个文件一行；prefix 区分分组（同一个文件可能在两组里），展开状态按它记 */
  const fileRow = (f: ChangedFile, prefix: string) => {
    const path = f.dir + f.name
    const reverted = !!undo?.reverted.has(path)
    const ref = target ?? (isDemo && projects[0] ? { projectId: projects[0].id } : null)
    const openInEditor = (): void => {
      if (ref) void openFile(ref, path, undefined, 1, f.newText).catch(e => setError(e.message))
    }
    // 单击：有对比的展开 / 收起，否则打开文件；双击在文件夹中显示。第二下点击 detail > 1 不算单击，对比不会开了又关
    // （docs/ui/path-click.md）。远程机器双击只提示不能在本机文件夹中显示
    const reveal = ref ? () => void revealPath(ref, path, toast) : null
    const diffs = f.diffs ?? []
    const openKey = prefix + path
    const expanded = diffs.length > 0 && open.has(openKey)
    const toggle = (): void =>
      setOpen(current => {
        const next = new Set(current)
        if (!next.delete(openKey)) next.add(openKey)
        return next
      })
    // 代码模式：有 diff 的行不在卡片里展开，直接打开中栏的变更
    const openDiff = (): void => {
      if (ref) void openCodeDiff(ref, path).catch(e => setError(e.message))
    }
    const rowClick = pathClickHandlers({
      open: diffs.length ? (code && ref ? openDiff : toggle) : openInEditor,
      reveal,
    })
    const iconClick = pathClickHandlers({ open: openInEditor, reveal })
    return (
      <li key={path}>
        <div
          data-change-row
          data-reverted={reverted || undefined}
          className="group/file flex h-[34px] items-center gap-1 rounded-md pr-1 pl-2 text-list hover:bg-hover"
        >
          <button
            type="button"
            className="flex h-full min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
            aria-expanded={diffs.length ? expanded : undefined}
            title={
              diffs.length
                ? `${tr(expanded ? 'session.ChangedFilesCard.hideChanges' : 'session.ChangedFilesCard.showChanges')}
${path}${ref && !isRemoteRef(ref) ? `\n${tr('path.hintDiff')}` : ''}`
                : pathHint(ref, path)
            }
            disabled={!diffs.length && !ref}
            data-path={path}
            {...rowClick}
          >
            {diffs.length > 0 && (
              <ChevronRight
                size={14}
                strokeWidth={1.5}
                className={cn(
                  'shrink-0 text-fg-muted transition-transform duration-(--dur-fast)',
                  expanded && 'rotate-90',
                )}
              />
            )}
            <span
              data-file-path
              className={cn(
                'min-w-0 flex-1 truncate',
                !diffs.length && 'hover:underline',
                reverted && 'text-fg-faint line-through',
              )}
            >
              <span className={reverted ? undefined : 'text-fg-muted'}>{f.dir}</span>
              <span className={reverted ? undefined : 'text-fg'}>{f.name}</span>
            </span>
            <DiffStat
              added={f.added}
              removed={f.removed}
              className={cn('shrink-0 text-meta', reverted && 'line-through opacity-50')}
            />
          </button>
          {undo &&
            (reverted ? (
              <>
                <span className="shrink-0 text-meta text-fg-muted">{tr('undo.reverted')}</span>
                <Button
                  variant="ghost"
                  icon={Redo2}
                  className="h-[26px] shrink-0 px-1.5 text-meta"
                  disabled={undo.pending}
                  title={undo.disabledReason ?? tr('undo.restore')}
                  onClick={() => (undo.disabledReason ? toast(undo.disabledReason) : undo.restore([path]))}
                >
                  {tr('undo.restore')}
                </Button>
              </>
            ) : (
              <IconButton
                icon={Undo2}
                label={f.created ? tr('undo.fileNew') : tr('undo.file')}
                size={26}
                iconSize={14}
                disabled={undo.pending}
                data-undo-file
                onClick={() => (undo.disabledReason ? toast(undo.disabledReason) : undo.revert([path]))}
                className={cn(
                  'opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100',
                  undo.disabledReason && 'text-fg-faint',
                )}
              />
            ))}
          {diffs.length > 0 && ref && (
            <IconButton
              icon={SquareArrowOutUpRight}
              label={tr('session.ChangedFilesCard.openInEditor')}
              title={pathHint(ref, path)}
              size={26}
              iconSize={14}
              {...iconClick}
              className={cn(
                'opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100',
                expanded && 'opacity-100',
              )}
            />
          )}
        </div>
        {expanded && (
          <div className="mx-2 mt-0.5 mb-1.5 max-h-72 overflow-auto rounded-lg border border-line-card bg-surface py-1.5">
            {diffs.map((diff, i) => (
              <DiffView
                key={i}
                diff={diff}
                path={path}
                className={i > 0 ? 'mt-1.5 border-t border-line-subtle pt-1.5' : undefined}
              />
            ))}
          </div>
        )}
      </li>
    )
  }
  const paths = [...new Set(data.files.map(f => f.dir + f.name))]
  const revertedCount = undo ? paths.filter(p => undo.reverted.has(p)).length : 0
  const allReverted = !!undo && revertedCount === paths.length && paths.length > 0
  return (
    <section
      data-changes-card
      className={cn('@container/changes rounded-xl border border-line-card bg-surface shadow-sm', className)}
      style={style}
    >
      {/* 一行标题（docs/ui/conversation-concise.md §3 E） */}
      <div data-changes-head className="flex min-h-10 items-center gap-2 px-4 pt-1.5 pb-0.5">
        <FileDiff size={15} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
        <span data-changes-title className="min-w-[5.5em] shrink truncate text-list font-medium text-fg">
          {allReverted
            ? tr('undo.allReverted')
            : tr(
                data.files.length === 1
                  ? 'session.ChangedFilesCard.editedFile'
                  : 'session.ChangedFilesCard.editedFiles',
                { n: data.files.length },
              )}
        </span>
        <DiffStat added={data.added} removed={data.removed} className="shrink-0 text-meta" />
        <span className="flex-1" />
        {/* 卡片窄于 440px：三个按钮只剩图标（文字进 title / aria-label），标题才不会被挤没 */}
        {undo && (
          <Button
            variant="ghost"
            icon={allReverted ? Redo2 : Undo2}
            data-undo-turn
            className="h-7 px-2 text-meta @max-[440px]/changes:px-1.5"
            disabled={undo.pending}
            title={undo.disabledReason ?? (allReverted ? tr('undo.restoreAll') : tr('undo.turnHint'))}
            aria-label={allReverted ? tr('undo.restoreAll') : tr('undo.turn')}
            onClick={() =>
              undo.disabledReason
                ? toast(undo.disabledReason)
                : allReverted
                  ? undo.restore(paths)
                  : undo.revert(paths.filter(p => !undo.reverted.has(p)))
            }
          >
            <span className="@max-[440px]/changes:hidden">{allReverted ? tr('undo.restoreAll') : tr('undo.turn')}</span>
          </Button>
        )}
        {code && onKeepAll && (
          <Button
            variant="ghost"
            className="h-7 px-2 text-meta @max-[440px]/changes:px-1.5"
            title={tr('coding.review.bar.keepAll')}
            aria-label={tr('coding.review.bar.keepAll')}
            onClick={onKeepAll}
          >
            <CheckCheck size={14} strokeWidth={1.5} className="hidden @max-[440px]/changes:block" />
            <span className="@max-[440px]/changes:hidden">{tr('coding.review.bar.keepAll')}</span>
          </Button>
        )}
        {aiReview && (
          <Button
            variant="ghost"
            data-ai-review-start
            className="h-7 px-2 text-meta @max-[440px]/changes:px-1.5"
            title={tr('aiReview.startTitle')}
            aria-label={tr('aiReview.start')}
            disabled={aiReview.running}
            onClick={aiReview.onClick}
          >
            <ScanSearch size={14} strokeWidth={1.5} className="hidden @max-[440px]/changes:block" />
            <span className="@max-[440px]/changes:hidden">
              {aiReview.running ? tr('aiReview.running') : tr('aiReview.start')}
            </span>
          </Button>
        )}
        {review && (
          <Button
            variant="outline"
            pill
            className="h-7 px-3 text-meta @max-[440px]/changes:px-1.5"
            title={tr('session.ChangedFilesCard.review')}
            aria-label={tr('session.ChangedFilesCard.review')}
            onClick={review}
          >
            <ScanEye size={14} strokeWidth={1.5} className="hidden @max-[440px]/changes:block" />
            <span className="@max-[440px]/changes:hidden">{tr('session.ChangedFilesCard.review')}</span>
          </Button>
        )}
      </div>
      {data.groups ? (
        // 有子智能体改的文件：按来源分组，每组一行小标题（docs/ui/subagent-changes.md §2.2）
        <div className="px-2 pb-2">
          {data.groups.map(g => {
            const label = g.label ?? tr('session.changes.mainAgent')
            return (
              <div key={g.key} data-change-group={g.key}>
                <div className="flex h-7 items-center gap-1.5 px-2 pt-1 text-meta text-fg-muted">
                  <span className="min-w-0 truncate font-medium text-fg-secondary" title={label}>
                    {label}
                  </span>
                  <span className="shrink-0">
                    ·{' '}
                    {tr(g.files.length === 1 ? 'session.changes.groupFile' : 'session.changes.groupFiles', {
                      n: g.files.length,
                    })}
                  </span>
                  <DiffStat added={g.added} removed={g.removed} className="shrink-0" />
                </div>
                <ul>{g.files.map(f => fileRow(f, g.key + '|'))}</ul>
              </div>
            )
          })}
        </div>
      ) : (
        <ul className="px-2 pb-2">{data.files.map(f => fileRow(f, ''))}</ul>
      )}
      {undo && revertedCount > 0 && !allReverted && (
        <div
          data-undo-foot
          className="flex h-8 items-center gap-2 border-t border-line-subtle px-4 text-meta text-fg-muted"
        >
          <span className="min-w-0 flex-1 truncate">
            {revertedCount === 1 ? tr('undo.revertedOne') : tr('undo.revertedCount', { n: revertedCount })}
          </span>
          <button
            type="button"
            className="press shrink-0 text-accent-fg hover:underline disabled:opacity-40"
            disabled={undo.pending}
            onClick={() =>
              undo.disabledReason ? toast(undo.disabledReason) : undo.restore(paths.filter(p => undo.reverted.has(p)))
            }
          >
            {tr('undo.restoreAll')}
          </button>
        </div>
      )}
      {error && (
        <p role="status" className="px-4 pb-3 text-meta text-danger">
          {translateMessage(error)}
        </p>
      )}
    </section>
  )
}
