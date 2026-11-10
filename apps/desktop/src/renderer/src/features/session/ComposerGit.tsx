// 输入框上方那一行里的 Git（docs/ui/composer-git.md）：分支 ▾、N 个改动、↑↓ 拉取 / 推送、提交…
// 原来要点右上角的 Git 图标打开面板才能做；逐个文件暂存、对比、历史、冲突处理仍在 Git 面板里。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, GitCommitHorizontal, RefreshCw } from 'lucide-react'
import { Button, cn, Popover, PopoverItem, useToast } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { isDemo } from '@/data'
import { refKey } from '@/features/editor/target'
import { openRightTab } from '@/features/panel/workspaceStore'
import { requestGitAction } from '@/features/panel/git/GitPanel'
import { AI_COMMIT_PAD, AiCommitButton, AiCommitNote, useAiCommit } from '@/features/panel/git/AiCommit'
import { changeCount, failureHint, failureTitle, needsCommitAll, syncState } from '@/features/panel/git/gitModel'
import { applyDemoGit, publishGitStatus, useGitStatus } from '@/features/panel/git/summary'
import type { GitFailure, GitResult, GitStatus } from '../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { HeaderBranch } from './HeaderBranch'

const CHIP =
  'press no-drag inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1 text-fg-faint hover:bg-hover hover:text-fg'

/** 关掉提交框后写了一半的提交信息还在（每个工作区一份，只在内存里） */
const drafts = new Map<string, string>()

/** compact：极简模式并进输入框下面一排（docs/ui/minimal-mode.md §12 A），只留分支和改动数；拉取推送、提交在概况和 Git 面板里 */
export function ComposerGit({ target, compact }: { target: WorkspaceRef; compact?: boolean }) {
  useI18n()
  const status = useGitStatus(target)
  if (!status?.repo) return null
  const branch = status.detached ? (status.head ?? '').slice(0, 7) : status.branch
  const changed = changeCount(status)
  return (
    <>
      {branch && <HeaderBranch workspace={target} label={branch} variant="composer" />}
      {changed > 0 && (
        <button
          type="button"
          data-composer-changes
          title={compact ? tr('git.composer.changes', { n: changed }) : tr('git.composer.changesTitle')}
          onClick={openChanges}
          className={CHIP}
        >
          {compact ? changed : tr('git.composer.changes', { n: changed })}
        </button>
      )}
      {!compact && <SyncButton target={target} status={status} />}
      {!compact && changed > 0 && <CommitButton target={target} status={status} />}
    </>
  )
}

export function openChanges(): void {
  openRightTab('git')
  requestGitAction('changes')
}

/** 跑一个 Git 操作：结果带回最新状态，失败给出原因 */
function useGitRun(target: WorkspaceRef) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<GitFailure | null>(null)
  const run = async (fn: () => Promise<GitResult>, demo: [string, unknown?]): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setFailure(null)
    try {
      if (isDemo) {
        applyDemoGit(demo[0], demo[1])
        return true
      }
      const result = await fn()
      if (result.status) publishGitStatus(target, result.status)
      if (!result.ok) setFailure(result.failure)
      return result.ok
    } catch (e) {
      setFailure({ kind: 'invalid', action: 'operation', detail: (e as Error).message, remedies: [] })
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, failure, setFailure, run }
}

function FailureNote({ failure, onClose }: { failure: GitFailure; onClose(): void }) {
  return (
    <div role="alert" data-composer-git-failure={failure.kind} className="mt-2 rounded-md bg-subtle p-2.5">
      <p className="text-list font-medium text-danger">{failureTitle(failure.kind)}</p>
      <p className="mt-0.5 text-meta text-fg-muted">{failureHint(failure.kind, failure.action)}</p>
      {failure.detail && (
        <p className="mt-1 line-clamp-3 font-mono text-meta break-words text-fg-muted">{failure.detail}</p>
      )}
      <button
        type="button"
        onClick={() => {
          onClose()
          openChanges()
        }}
        className="mt-1.5 text-meta text-accent-fg hover:underline"
      >
        {tr('git.header.openPanel')}
      </button>
    </div>
  )
}

/** ↑2 ↓1：点开拉取 / 推送 / 检查远端；没有远端或都同步了就不显示。chip 换按钮的样子（概况里） */
export function SyncButton({
  target,
  status,
  chip = CHIP,
}: {
  target: WorkspaceRef
  status: GitStatus
  chip?: string
}) {
  const api = window.pixelsky?.projectTools
  const [open, setOpen] = useState(false)
  const git = useGitRun(target)
  const sync = syncState(status)
  if (!sync) return null
  const { unpublished } = sync
  const close = (): void => {
    setOpen(false)
    git.setFailure(null)
  }
  const act = (fn: () => Promise<GitResult>, demo: [string]) =>
    void git.run(fn, demo).then(ok => {
      if (ok) setOpen(false)
    })
  const label = [
    status.ahead > 0 && `↑${status.ahead}`,
    status.behind > 0 && `↓${status.behind}`,
    unpublished && `↑ ${tr('git.composer.unpublished')}`,
  ]
    .filter(Boolean)
    .join(' ')
  const busyReason = status.busySessions > 0 ? tr('git.busy') : undefined
  return (
    <span data-composer-sync-wrap className="relative inline-flex shrink-0">
      <button
        type="button"
        data-composer-sync
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${tr('git.composer.sync')} · ${label}`}
        title={
          [
            status.ahead > 0 && tr('git.ahead', { n: status.ahead }),
            status.behind > 0 && tr('git.behind', { n: status.behind }),
          ]
            .filter(Boolean)
            .join('，') || tr('git.composer.unpublished')
        }
        onMouseDown={e => open && e.stopPropagation()}
        onClick={() => (open ? close() : setOpen(true))}
        className={cn(chip, 'font-mono', (open || git.busy) && 'bg-hover text-fg')}
      >
        {label}
      </button>
      <Popover open={open} onClose={close} side="top" offset={8} className="w-60">
        <PopoverItem
          icon={<ArrowDown size={15} strokeWidth={1.5} className="text-fg-secondary" />}
          hint={status.behind > 0 ? `↓${status.behind}` : undefined}
          disabled={git.busy || !status.upstream || !!busyReason}
          title={busyReason}
          onClick={() => act(() => api!.gitPull(target, 'ff-only'), ['pull'])}
        >
          {tr('git.pull')}
        </PopoverItem>
        <PopoverItem
          icon={<ArrowUp size={15} strokeWidth={1.5} className="text-fg-secondary" />}
          hint={status.ahead > 0 ? `↑${status.ahead}` : undefined}
          disabled={git.busy || (!unpublished && status.ahead === 0)}
          onClick={() => act(() => api!.gitPush(target, { publish: unpublished }), ['push'])}
        >
          {tr(unpublished ? 'git.publish' : 'git.push')}
        </PopoverItem>
        <PopoverItem
          icon={<RefreshCw size={15} strokeWidth={1.5} className="text-fg-secondary" />}
          disabled={git.busy}
          onClick={() => act(() => api!.gitFetch(target), ['fetch'])}
        >
          {tr('git.fetch')}
        </PopoverItem>
        {git.failure && <FailureNote failure={git.failure} onClose={close} />}
      </Popover>
    </span>
  )
}

/** 提交…：弹出提交框；有冲突时灰掉。chip 换按钮的样子（概况里） */
export function CommitButton({
  target,
  status,
  chip = cn(CHIP, 'text-fg-muted'),
}: {
  target: WorkspaceRef
  status: GitStatus
  chip?: string
}) {
  const [open, setOpen] = useState(false)
  const conflicts = status.conflicted.length > 0
  return (
    <span data-composer-commit-wrap className="relative inline-flex shrink-0">
      <button
        type="button"
        data-composer-commit
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={conflicts}
        title={conflicts ? tr('git.composer.conflicts') : undefined}
        onMouseDown={e => open && e.stopPropagation()}
        onClick={() => setOpen(v => !v)}
        className={cn(chip, 'disabled:opacity-40 disabled:hover:bg-transparent', open && 'bg-hover text-fg')}
      >
        <GitCommitHorizontal size={13} strokeWidth={1.5} />
        {tr('git.composer.commit')}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} side="top" offset={8} className="w-80 p-3">
        {open && <CommitBox target={target} status={status} onDone={() => setOpen(false)} />}
      </Popover>
    </span>
  )
}

function CommitBox({ target, status, onDone }: { target: WorkspaceRef; status: GitStatus; onDone(): void }) {
  const api = window.pixelsky?.projectTools
  const toast = useToast()
  const key = refKey(target)
  const [message, setMessageState] = useState(() => drafts.get(key) ?? '')
  const setMessage = (value: string): void => {
    drafts.set(key, value)
    setMessageState(value)
  }
  const ai = useAiCommit({ target, demo: isDemo, message, setMessage })
  const git = useGitRun(target)
  const input = useRef<HTMLTextAreaElement>(null)
  const all = needsCommitAll(status)
  const changed = changeCount(status)
  const scope = all ? 'all' : 'staged'
  const canCommit = !!message.trim() && !ai.running && !git.busy && changed > 0 && !status.conflicted.length
  const canPush = canCommit && status.remotes.length > 0 && !status.detached

  // 打开时：AI 写提交信息开着、还没写过，就直接让 AI 写（费用写在下面那一行）
  const started = useRef(false)
  useEffect(() => {
    input.current?.focus()
    if (started.current) return
    started.current = true
    if (ai.enabled && !message.trim()) ai.start(scope)
    // 只在打开时做一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 关掉提交框时还在写：停掉，不再扣费
  const stop = useRef(ai.stop)
  stop.current = ai.running ? ai.stop : () => undefined
  useEffect(() => () => stop.current(), [])

  const commit = (push: boolean): void => {
    if (!(push ? canPush : canCommit)) return
    let result: GitResult | undefined
    void git
      .run(async () => (result = await api!.gitCommit(target, { message, all, push })), ['commit', { all, push }])
      .then(ok => {
        if (!ok) {
          // 提交成了、推送失败：改动已经是 0，提交框跟着「N 个改动」一起收起，失败原因就看不到了，改用提示说
          if (push && result && !result.ok && result.status && changeCount(result.status) === 0) {
            drafts.delete(key)
            toast(tr('git.composer.pushFailedAfterCommit', { p0: failureTitle(result.failure.kind) }))
          }
          return
        }
        drafts.delete(key)
        toast(tr(push ? 'git.composer.committedPushed' : 'git.composer.committed'))
        onDone()
      })
  }

  let note: ReactNode = null
  if (status.busySessions > 0) note = <p className="text-warn">{tr('git.composer.running')}</p>
  return (
    <div data-composer-commit-box>
      <div className="mb-2 flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-meta text-fg-muted">
          {tr('git.composer.commitTo', { branch: status.branch ?? (status.head ?? '').slice(0, 7) })}
        </p>
        <button
          type="button"
          onClick={() => {
            onDone()
            openChanges()
          }}
          className="shrink-0 text-meta text-accent-fg hover:underline"
        >
          {tr('git.composer.viewChanges')}
        </button>
      </div>
      <div className="relative">
        <textarea
          ref={input}
          value={message}
          onChange={e => setMessage(e.target.value)}
          rows={Math.min(7, Math.max(3, message.split('\n').length))}
          readOnly={ai.running}
          aria-label={tr('git.commit.label')}
          placeholder={tr(ai.running ? 'aiCommit.writing' : 'git.commit.placeholderShort')}
          title={tr('git.commit.placeholder')}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
              e.preventDefault()
              commit(false)
            }
          }}
          className={cn(
            'block max-h-40 min-h-16 w-full resize-none rounded-md border border-line bg-surface px-2.5 py-2 text-list text-fg outline-none placeholder:text-fg-faint focus-visible:border-accent',
            ai.enabled && AI_COMMIT_PAD,
          )}
        />
        {ai.enabled && <AiCommitButton ai={ai} scope={scope} disabled={git.busy || changed === 0} />}
      </div>
      <AiCommitNote ai={ai} />
      <div className="mt-1.5 space-y-1 text-meta text-fg-muted">
        <p>
          {all
            ? tr('git.composer.allNote', { n: changed })
            : tr('git.composer.stagedNote', { n: status.staged.length })}
        </p>
        {note}
      </div>
      <div className="mt-2 flex gap-1.5">
        <Button
          variant="primary"
          className="h-7 flex-1 justify-center px-2.5 text-meta"
          disabled={!canCommit}
          onClick={() => commit(false)}
        >
          {tr(all ? 'git.commitAll' : 'git.commit')}
        </Button>
        <Button className="h-7 flex-1 justify-center px-2.5 text-meta" disabled={!canPush} onClick={() => commit(true)}>
          {tr(all ? 'git.commitAllPush' : 'git.commitPush')}
        </Button>
      </div>
      {git.failure && <FailureNote failure={git.failure} onClose={onDone} />}
    </div>
  )
}
