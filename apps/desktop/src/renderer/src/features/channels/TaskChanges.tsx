import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { DiffStat, Spinner } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import type { GitCompareResult } from '../../../../shared/types/project-tools'

/**
 * 单卡副本相对分出时的改动（docs/ui/channels-local-rest.md §3.1）。
 * shortcut: 只列文件和增删行数，不显示逐行差异；要看细节打开会话用 Git 面板，有人要再接 GitDiffView
 */
export function TaskChanges({ sessionId, base, onClose }: { sessionId: string; base: string; onClose: () => void }) {
  useI18n()
  const [result, setResult] = useState<GitCompareResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const api = window.pixelsky?.projectTools
    if (!api) {
      setError(tr('channels.land.changesDemo'))
      return
    }
    api
      .gitCompare({ sessionId }, { from: base || 'HEAD', to: 'HEAD' })
      .then(setResult, (e: Error) => setError(translateMessage(e.message)))
  }, [sessionId, base])
  return (
    <ConfirmDialog
      wide
      hideConfirm
      title={tr('channels.land.changes')}
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : !result ? (
          <Spinner size={14} />
        ) : result.files.length === 0 ? (
          tr('channels.land.noChanges')
        ) : (
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {result.files.map(f => (
              <li key={f.path} className="flex items-center gap-2 text-meta">
                <span className="selectable min-w-0 flex-1 truncate font-mono text-fg">{f.path}</span>
                {f.insertions !== null && <DiffStat added={f.insertions} removed={f.deletions ?? 0} />}
              </li>
            ))}
          </ul>
        )
      }
      confirmLabel=""
      cancelLabel={tr('channels.dialog.cancel')}
      busy={false}
      onConfirm={onClose}
      onCancel={onClose}
    />
  )
}
