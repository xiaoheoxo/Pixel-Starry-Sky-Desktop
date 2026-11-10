import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, GitBranch, GitMerge } from 'lucide-react'
import { cn, useComingSoon } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { isDemo } from '@/data'
import { demo as demoData } from '@/data/demo'
import { isLive } from '@/features/engine'
import { BranchMenu, type BranchMenuAction } from '@/features/panel/git/BranchMenu'
import {
  branchParent,
  branchReadOnly,
  canBranch,
  mergeLabel,
  openBranchDialog,
  openMergeDialog,
  sessionBusy,
  sessionRecord,
} from './branch/store'
import { failureHint, failureTitle } from '@/features/panel/git/gitModel'
import { publishGitStatus } from '@/features/panel/git/summary'
import { beforeSwitch, type SwitchCheck } from '@/features/panel/git/summarize'
import { openRightTab } from '@/features/panel/workspaceStore'
import type { GitBranch as Branch, GitFailure, GitResult } from '../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../shared/types/workspace'

/**
 * 分支名按钮（GitHub #21，docs/ui/context-settings-branch-switch.md §3）：
 * 点开是 Git 面板同一个分支菜单；有没提交的改动时先确认；失败时写原因，可以去 Git 面板处理。
 * 2026-10-13 起放在输入框上方那一行（composer，往上弹，docs/ui/composer-git.md）
 */
export function HeaderBranch({
  workspace: target,
  label,
  variant = 'header',
}: {
  workspace: WorkspaceRef
  label: string
  variant?: 'header' | 'composer'
}) {
  const up = variant === 'composer'
  useI18n()
  const comingSoon = useComingSoon()
  const api = window.pixelsky?.projectTools
  const [menu, setMenu] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ branch: Branch; changed: number } | null>(null)
  const [failure, setFailure] = useState<GitFailure | null>(null)

  const open = async () => {
    setFailure(null)
    // 不显示上次读到的列表：当前分支可能已经变了，点上去会点错
    setBranches([])
    setMenu(true)
    if (isDemo) {
      setBranches(demoData().git.branches)
      return
    }
    if (!api) return
    setLoading(true)
    try {
      setBranches(await api.gitBranches(target))
    } catch (e) {
      setMenu(false)
      setFailure({ kind: 'invalid', action: 'switch', detail: (e as Error).message, remedies: [] })
    } finally {
      setLoading(false)
    }
  }

  const perform = async (fn: () => Promise<GitResult>) => {
    setBusy(true)
    try {
      const result = await fn()
      if (result.status) publishGitStatus(target, result.status)
      if (!result.ok) setFailure(result.failure)
    } catch (e) {
      setFailure({ kind: 'invalid', action: 'switch', detail: (e as Error).message, remedies: [] })
    } finally {
      setBusy(false)
    }
  }

  const switchTo = (branch: Branch) =>
    perform(() => api!.gitSwitch(target, { branch: branch.name, remote: branch.remote }))

  /** 切换前读一次最新状态：AI 在运行时直接说明，有改动时先确认 */
  const choose = async (branch: Branch) => {
    setMenu(false)
    if (isDemo || !api) return
    setBusy(true)
    let check: SwitchCheck = { kind: 'go' }
    try {
      const status = await api.gitStatus(target)
      publishGitStatus(target, status)
      check = beforeSwitch(status)
    } catch {
      // 读不到状态时交给切换本身报错
    } finally {
      setBusy(false)
    }
    if (check.kind === 'busy') setFailure({ kind: 'busy', action: 'switch', detail: '', remedies: [] })
    else if (check.kind === 'confirm') setConfirm({ branch, changed: check.changed })
    else await switchTo(branch)
  }

  // 新分支从当前提交建，改动原样带过去，不会冲突，不用确认
  const create = (name: string) => {
    setMenu(false)
    if (isDemo || !api) return
    void perform(() => api.gitCreateBranch(target, { name }))
  }

  const openGit = () => {
    setConfirm(null)
    setFailure(null)
    openRightTab('git')
  }
  const close = useCallback(() => setMenu(false), [])

  // 失败提示：Esc 或点外面关掉
  useEffect(() => {
    if (!failure) return
    const down = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('[data-header-branch-failure]')) setFailure(null)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFailure(null)
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [failure])

  return (
    <span className="relative inline-flex min-w-0 shrink-[2]">
      <button
        ref={trigger}
        type="button"
        data-header-branch
        aria-haspopup="dialog"
        aria-expanded={menu}
        aria-label={`${tr('git.branch.menu')} · ${label}`}
        title={tr('git.branch.menu')}
        disabled={busy}
        onClick={() => (menu ? setMenu(false) : void open())}
        className={cn(
          'press no-drag inline-flex min-w-0 items-center gap-1 rounded-md hover:bg-hover hover:text-fg',
          up ? 'h-6 px-1 text-fg-faint' : 'h-7 px-1.5 text-fg-muted',
          menu && 'bg-hover text-fg',
          busy && 'opacity-60',
        )}
      >
        <GitBranch size={13} strokeWidth={1.5} className="shrink-0" />
        <span data-branch-label className="truncate font-mono text-meta">
          {label}
        </span>
        <ChevronDown size={12} strokeWidth={1.5} className="shrink-0" />
      </button>
      {menu && (
        <BranchMenu
          actions={branchActions(target, comingSoon)}
          branches={branches}
          loading={loading}
          onClose={close}
          anchor={trigger}
          side={up ? 'top' : 'bottom'}
          onSwitch={b => void choose(b)}
          onCreate={create}
        />
      )}
      {failure && (
        <div
          role="alert"
          data-header-branch-failure={failure.kind}
          className={cn(
            'pop-in no-drag absolute left-0 z-40 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line-card bg-popover p-3 shadow-menu',
            up ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          <p className="text-meta text-fg-faint">{tr('git.action.switch')}</p>
          <p className="text-list font-medium text-danger">{failureTitle(failure.kind)}</p>
          <p className="mt-0.5 text-meta text-fg-muted">{failureHint(failure.kind, failure.action)}</p>
          {failure.detail && (
            <p className="mt-1.5 line-clamp-3 font-mono text-meta break-words text-fg-muted">{failure.detail}</p>
          )}
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setFailure(null)}
              className="press rounded-md border border-line px-2.5 py-1 text-meta hover:bg-hover"
            >
              {tr('git.failure.dismiss')}
            </button>
            <button
              type="button"
              onClick={openGit}
              className="press rounded-md bg-primary px-2.5 py-1 text-meta font-medium text-primary-fg"
            >
              {tr('git.header.openPanel')}
            </button>
          </div>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={tr('git.header.dirtyTitle', { n: confirm.changed })}
          description={tr('git.header.dirtyBody', { branch: confirm.branch.name })}
          confirmLabel={tr('git.header.switchAnyway')}
          cancelLabel={tr('git.header.cancel')}
          busy={busy}
          extra={{ label: tr('git.header.openPanel'), onClick: openGit }}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const branch = confirm.branch
            setConfirm(null)
            void switchTo(branch)
          }}
        />
      )}
    </span>
  )
}

/** 会话输入框上方的分支菜单：顶部多两项「开分支…」「合并回主会话…」（docs/ui/branch-merge.md §2） */
function branchActions(target: WorkspaceRef, comingSoon: (what: string) => void): BranchMenuAction[] {
  const id = target.sessionId
  if (!id) return []
  const record = sessionRecord(id)
  if (!canBranch(record) || branchReadOnly(record)) return []
  const busy = sessionBusy(id)
  const actions: BranchMenuAction[] = [
    {
      key: 'branch',
      icon: GitBranch,
      label: tr('branch.menu.fork'),
      desc: busy ? tr('branch.menu.busy') : tr('branch.menu.forkDesc'),
      disabled: busy,
      onClick: () => openBranchDialog(id),
    },
  ]
  const parent = branchParent(record)
  if (record && parent)
    actions.push({
      key: 'merge',
      icon: GitMerge,
      label: tr(mergeLabel(record, 'menu')),
      desc: busy ? tr('branch.menu.busy') : tr('branch.menu.mergeDesc', { title: parent.title }),
      disabled: busy,
      // 演示模式没有引擎：合并弹窗会一直加载，和侧栏、分支横条一样提示「敬请期待」
      onClick: () => (isLive ? openMergeDialog(id) : comingSoon(tr(mergeLabel(record, 'menu')))),
    })
  return actions
}
