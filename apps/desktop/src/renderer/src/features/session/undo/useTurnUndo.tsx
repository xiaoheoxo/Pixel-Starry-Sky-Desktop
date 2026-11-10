// 改动卡片的撤回 / 恢复（docs/ui/undo-changes.md §3）：之后又被改过时先弹确认框，列出会丢掉的内容
import { useMemo, useState, type ReactNode } from 'react'
import type { RevertFilesResult } from '@pixelsky/protocol'
import { tr, translateMessage } from '@/i18n/core'
import { useToast } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { DiffView } from '@/ui/code/DiffView'
import type { CardUndo } from '../ChangedFilesCard'
import { useCheckpoints } from './checkpoints'

type Conflicts = Extract<RevertFilesResult, { kind: 'conflict' }>['conflicts']

const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/** turnKey：这一轮的用户消息 id（第一条消息之前的改动是 'start'，没有快照） */
export function useTurnUndo(turnKey: string): { undo: CardUndo | null; dialog: ReactNode } {
  const cp = useCheckpoints()
  const toast = useToast()
  const [pending, setPending] = useState(false)
  const [confirm, setConfirm] = useState<{ paths: string[]; conflicts: Conflicts } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const list = cp?.list ?? null
  const reverted = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of list?.reverted ?? []) if (r.itemId === turnKey) for (const p of r.paths) map.set(p, r.revertId)
    return map
  }, [list, turnKey])

  const report = (result: RevertFilesResult): void => {
    if (result.kind !== 'done') return
    for (const s of result.skipped)
      toast(tr('undo.skipped', { path: baseName(s.path), reason: translateMessage(s.message ?? s.reason) }))
  }
  const run = async (task: () => Promise<void>): Promise<void> => {
    setPending(true)
    try {
      await task()
    } catch (err) {
      toast(translateMessage((err as Error).message))
    } finally {
      setPending(false)
    }
  }

  const undo = useMemo<CardUndo | null>(() => {
    if (!cp || !list || turnKey === 'start') return null
    const hasTurn = list.turns.some(t => t.itemId === turnKey)
    // 快照停用（太慢等）只是不再拍新的：这一轮有快照就照样能撤回。
    // 撤回过的文件在快照被清掉后（设置 › 存储「清理检查点」）也还能恢复：恢复用的内容在宿主内存里
    const disabledReason = cp.busy
      ? tr('undo.busy')
      : hasTurn || reverted.size > 0
        ? null
        : list.disabled
          ? tr(`checkpoint.disabled.${list.disabled}`)
          : tr('undo.noCheckpoint')
    return {
      disabledReason,
      reverted: new Set(reverted.keys()),
      pending,
      revert: paths =>
        void run(async () => {
          const result = await cp.revert(turnKey, paths, false)
          if (result.kind === 'conflict') {
            setError(null)
            setConfirm({ paths, conflicts: result.conflicts })
          } else report(result)
        }),
      restore: paths =>
        void run(async () => {
          const byId = new Map<string, string[]>()
          for (const p of paths) {
            const id = reverted.get(p)
            if (id) byId.set(id, [...(byId.get(id) ?? []), p])
          }
          for (const [id, ps] of byId) await cp.restore(id, ps)
        }),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run / report 每次渲染新建，只读当时的 cp 和 toast
  }, [cp, list, turnKey, reverted, pending])

  const dialog = confirm && cp && (
    <ConfirmDialog
      title={
        confirm.conflicts.length === 1
          ? tr('undo.conflictTitle', { name: baseName(confirm.conflicts[0]!.path) })
          : tr('undo.conflictTitleMany', { n: confirm.conflicts.length })
      }
      description={
        <div className="flex flex-col gap-2">
          <p>{tr('undo.conflictDesc')}</p>
          <div className="flex max-h-72 flex-col gap-2 overflow-auto">
            {confirm.conflicts.map(c => (
              <div key={c.path} className="rounded-lg border border-line-subtle bg-subtle py-1.5" data-undo-conflict>
                {confirm.conflicts.length > 1 && (
                  <div className="truncate px-2.5 pb-1 font-mono text-code-path text-fg-secondary">{c.path}</div>
                )}
                {c.diff ? (
                  <DiffView diff={c.diff} path={c.path} commentable={false} />
                ) : (
                  <p className="px-2.5 text-meta text-fg-muted">{tr('undo.conflictBinary')}</p>
                )}
              </div>
            ))}
          </div>
          <p className="text-meta text-fg-muted">{tr('undo.conflictRestore')}</p>
        </div>
      }
      confirmLabel={tr('undo.confirm')}
      cancelLabel={tr('session.message.cancel')}
      danger
      busy={pending}
      error={error}
      onCancel={() => setConfirm(null)}
      onConfirm={() => {
        setPending(true)
        cp.revert(turnKey, confirm.paths, true)
          .then(result => {
            report(result)
            setConfirm(null)
          })
          .catch((err: Error) => setError(translateMessage(err.message)))
          .finally(() => setPending(false))
      }}
    />
  )
  return { undo, dialog }
}
