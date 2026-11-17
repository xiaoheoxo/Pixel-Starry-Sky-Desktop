// 开分支弹窗（docs/ui/branch-merge.md §3）：名字、代码放哪（副本 / 同一个目录）、Git 分支、带不带没提交的改动
import { useEffect, useMemo, useState } from 'react'
import { GitBranch, Info } from 'lucide-react'
import { tr, translateMessage } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { cn, useToast } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { bridge } from '@/features/engine'
import { getEngineState } from '@/features/engine/store'
import { appendComposerDraft, composerDraft, removeComposerDraftTail } from '@/features/engine/drafts'
import { updateFiles, updateImages } from '@/features/session/attachments/drafts'
import { paneActions } from '@/features/panes/store'
import type { BranchPrepare } from '../../../../../shared/types/branch'
import { closeBranchDialog, sessionRecord } from './store'
import { copyName, defaultBranch } from './naming'

const INPUT =
  'w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-composer-ring'

const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/
const BAD_COPY = /[\\/:*?"<>|]/

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

export function BranchDialog({
  sessionId,
  itemId,
  mode: initialMode,
}: {
  sessionId: string
  itemId: string | null
  mode: 'copy' | 'shared'
}) {
  useI18n()
  const toast = useToast()
  const record = sessionRecord(sessionId)
  const snapshot = getEngineState().snapshots[sessionId] ?? null
  const up = tr(record?.branch && record.forkedFrom ? 'branch.up.origin' : 'branch.up.main')
  // 带过去的内容：从某条消息开分支是那条之前的对话和那条原文；整个会话是全部对话和输入框里的草稿
  const { carried, chars, carryText } = useMemo(() => {
    const items = snapshot?.items ?? []
    const index = itemId ? items.findIndex(i => i.id === itemId) : items.length
    const kept = items.slice(0, index < 0 ? items.length : index)
    const target = itemId ? items[index] : null
    return {
      carried: kept.filter(i => i.kind === 'user' || i.kind === 'assistant').length,
      chars: kept.reduce((n, i) => n + (i.kind === 'user' || i.kind === 'assistant' ? i.text.length : 0), 0),
      carryText: (target && target.kind === 'user' ? target.text : composerDraft(sessionId)).trim(),
    }
  }, [snapshot, itemId, sessionId])

  const [info, setInfo] = useState<BranchPrepare | null>(null)
  const [mode, setMode] = useState<'copy' | 'shared'>(initialMode)
  const [name, setName] = useState(() =>
    carryText ? cut(carryText.replace(/\s+/g, ' '), 24) : `${record?.title ?? ''}${tr('fork.titleSuffix')}`,
  )
  const [branch, setBranch] = useState('')
  const [carry, setCarry] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void bridge
      ?.branchPrepare(sessionId)
      .then(next => {
        if (!live) return
        setInfo(next)
        setBranch(b => b || defaultBranch(name, next.branches))
        if (!next.git) setMode('shared')
      })
      .catch(e => live && setError(translateMessage((e as Error).message)))
    return () => {
      live = false
    }
    // 只在打开时读一次；名字之后改了不跟着换分支名
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const copy = mode === 'copy' && !!info?.git
  const trimmedBranch = branch.trim()
  const copyDir = info ? copyName(trimmedBranch, info.copies) : ''
  const branchError = !copy
    ? null
    : !trimmedBranch || !BRANCH_NAME.test(trimmedBranch) || /^\/|\/$|\.\./.test(trimmedBranch)
      ? tr('branch.dialog.errBranchFormat')
      : info?.branches.includes(trimmedBranch)
        ? tr('branch.dialog.errBranchTaken', { name: trimmedBranch })
        : BAD_COPY.test(copyDir)
          ? tr('branch.dialog.errCopyName')
          : null
  const sep = info?.copyRoot?.includes('\\') ? '\\' : '/'

  const submit = async (): Promise<void> => {
    if (!bridge || !record) return
    setBusy(true)
    setError(null)
    try {
      const result = await bridge.branch(sessionId, itemId, {
        title: name.trim(),
        copy: copy ? { name: copyDir, branch: trimmedBranch, carry: carry && (info?.dirty ?? 0) > 0 } : null,
      })
      const key = result.record.id
      if (itemId === null) {
        // 整个会话开分支：输入框里的草稿跟着过去
        const draft = composerDraft(sessionId)
        if (draft.trim()) {
          appendComposerDraft(key, draft)
          removeComposerDraftTail(sessionId, draft)
        }
      } else {
        appendComposerDraft(key, result.text)
        if (result.attachments?.length) await updateImages(key, () => result.attachments!).catch(() => undefined)
        if (result.files?.length) await updateFiles(key, () => result.files!).catch(() => undefined)
      }
      closeBranchDialog()
      paneActions.open(key)
      toast(
        copy
          ? tr('branch.created', { title: result.record.title, branch: trimmedBranch })
          : tr('branch.createdShared', { title: result.record.title }),
      )
    } catch (e) {
      setError(translateMessage((e as Error).message) || String(e))
      setBusy(false)
    }
  }

  const option = (value: 'copy' | 'shared', title: string, desc: string, badge?: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      data-branch-mode={value}
      disabled={busy || (value === 'copy' && !info?.git)}
      onClick={() => setMode(value)}
      className={cn(
        'press flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left disabled:opacity-50',
        mode === value ? 'border-accent-line bg-accent-soft' : 'border-line bg-surface hover:bg-hover',
      )}
    >
      <span
        className={cn(
          'mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px]',
          mode === value ? 'border-accent' : 'border-fg-faint',
        )}
      >
        {mode === value && <span className="size-1.5 rounded-full bg-accent" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-ui font-medium text-fg">
          {title}
          {badge && <span className="rounded bg-subtle px-1 text-label font-normal text-fg-muted">{badge}</span>}
        </span>
        <span className="text-meta text-fg-muted">{desc}</span>
      </span>
    </button>
  )

  return (
    <ConfirmDialog
      title={tr(itemId ? 'branch.dialog.titleHere' : 'branch.dialog.title')}
      focusInput
      busy={busy}
      error={error}
      confirmDisabled={!info || !name.trim() || !!branchError || !record}
      confirmLabel={
        busy ? tr(copy ? 'branch.dialog.creatingCopy' : 'branch.dialog.forking') : tr('branch.dialog.submit')
      }
      cancelLabel={tr('branch.dialog.cancel')}
      onConfirm={() => void submit()}
      onCancel={closeBranchDialog}
      description={
        <div data-branch-dialog className="flex flex-col gap-4 text-fg">
          <p className="text-meta text-fg-muted">
            {tr(itemId ? 'branch.dialog.introHere' : 'branch.dialog.introAll', { up })}
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-meta text-fg-secondary">{tr('branch.dialog.name')}</span>
            <input
              data-branch-name
              value={name}
              maxLength={80}
              disabled={busy}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && info && name.trim() && !branchError)
                  void submit()
              }}
              className={INPUT}
            />
          </label>
          <div role="radiogroup" aria-label={tr('branch.dialog.code')} className="flex flex-col gap-2">
            <span className="text-meta text-fg-secondary">{tr('branch.dialog.code')}</span>
            {option(
              'copy',
              tr('branch.dialog.copy'),
              tr('branch.dialog.copyDesc', { up }),
              tr('branch.dialog.recommended'),
            )}
            {option(
              'shared',
              tr('branch.dialog.shared', { up }),
              tr('branch.dialog.sharedDesc', { dir: record?.cwd ?? '' }),
            )}
            {info && !info.git && <p className="text-meta text-fg-muted">{tr('branch.dialog.noGit')}</p>}
            {!info && !error && <p className="text-meta text-fg-faint">{tr('branch.dialog.loading')}</p>}
          </div>
          {copy && (
            <div className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1.5 text-meta text-fg-secondary">
                <GitBranch size={12} strokeWidth={1.75} />
                {tr('branch.dialog.gitBranch')}
              </span>
              <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 focus-within:border-accent-line focus-within:ring-2 focus-within:ring-composer-ring">
                <span className="shrink-0 whitespace-nowrap text-meta text-fg-faint">
                  {info?.baseBranch
                    ? tr('branch.dialog.from', { base: info.baseBranch })
                    : tr('branch.dialog.fromHead')}
                </span>
                <input
                  data-branch-git
                  value={branch}
                  spellCheck={false}
                  disabled={busy}
                  onChange={e => setBranch(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent py-2 font-mono text-meta text-fg outline-none"
                />
              </div>
              {branchError && <p className="text-meta text-danger">{branchError}</p>}
              {info?.copyRoot && (
                <p className="break-all text-meta text-fg-muted">
                  {tr('branch.dialog.copyDir', { path: `${info.copyRoot}${sep}${copyDir}` })}
                </p>
              )}
              {(info?.dirty ?? 0) > 0 && (
                <label className="mt-1 flex items-start gap-2">
                  <input
                    type="checkbox"
                    data-branch-carry
                    className="mt-0.5"
                    checked={carry}
                    disabled={busy}
                    onChange={e => setCarry(e.target.checked)}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-list text-fg">{tr('branch.dialog.carry', { n: info!.dirty })}</span>
                    <span className="text-meta text-fg-muted">{tr('branch.dialog.carryHint')}</span>
                  </span>
                </label>
              )}
            </div>
          )}
          <div className="flex items-start gap-2 rounded-md bg-subtle px-3 py-2 text-meta text-fg-secondary">
            <Info size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg-muted" />
            <span>
              {snapshot && tr('branch.dialog.context', { n: carried, k: Math.max(1, Math.round(chars / 2000)) })}
              {carryText
                ? tr('branch.dialog.contextDraft', { text: cut(carryText.replace(/\s+/g, ' '), 30) })
                : tr('branch.dialog.contextEmpty')}
            </span>
          </div>
        </div>
      }
    />
  )
}
