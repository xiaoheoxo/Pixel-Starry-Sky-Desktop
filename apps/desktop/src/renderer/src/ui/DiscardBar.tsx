import { useEffect, useRef } from 'react'
import { tr } from '../i18n/core'

/** 弹窗 / 表单里就地问一句「放弃改动？」：出现时焦点落在「继续编辑」上，回车、空格不会误丢 */
export function DiscardBar({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => keep.current?.focus({ preventScroll: true }), [])
  return (
    <div
      role="alert"
      className="mt-4 flex flex-wrap items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-meta text-fg-secondary"
    >
      <span className="min-w-0 flex-1">{tr('ui.ConfirmDialog.unsaved')}</span>
      <button
        ref={keep}
        type="button"
        onClick={onKeep}
        className="press rounded-md border border-line px-2.5 py-1 text-meta hover:bg-hover"
      >
        {tr('ui.ConfirmDialog.keepEditing')}
      </button>
      <button
        type="button"
        onClick={onDiscard}
        className="press rounded-md bg-danger px-2.5 py-1 text-meta text-accent-on"
      >
        {tr('ui.ConfirmDialog.discard')}
      </button>
    </div>
  )
}
