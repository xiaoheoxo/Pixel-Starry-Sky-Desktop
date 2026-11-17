import { useRef, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { EditorView } from '@codemirror/view'
import { goToNextChunk, goToPreviousChunk } from '@codemirror/merge'
import { IconButton, Segmented, cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { DiffEditor } from '@/features/editor/code/DiffEditor'
import { aiBusyFor } from '@/features/editor/autoSaveModel'
import { getEngineState, subscribeEngine } from '@/features/engine/store'
import { isMac } from '@/features/layout/keybindings'
import type { OpenFile } from '@/features/files/store'
import type { DiffBase } from '../types'

/**
 * 中栏的「变更」和「并排」视图：左边是基准（HEAD 或这一轮开始前），只读；当前内容能直接改，AI 运行时变回只读（docs/ui/desktop-parity.md）。
 */
export function DiffPane({
  tab,
  mode,
  base,
  turnBaseline,
  fellBack = false,
  aiRunning = false,
  onBase,
  onShowCode,
}: {
  tab: OpenFile
  mode: 'diff' | 'split'
  /** 已经按能不能算出这一轮的基准处理过的基准 */
  base: DiffBase
  /** 这一轮开始前的内容；算不出来是 null */
  turnBaseline: string | null
  /** 想看「只看这一轮」但算不出基准，已退回 HEAD */
  fellBack?: boolean
  /** 这一轮的 AI 正在运行（演示数据只有这个来源）；引擎里正在跑的会话在下面另外判断 */
  aiRunning?: boolean
  onBase(base: DiffBase): void
  onShowCode(): void
}) {
  useI18n()
  const nav = useRef<EditorView | null>(null)
  const original = (base === 'turn' ? turnBaseline : tab.head) ?? tab.head ?? ''
  // 这个文件所在的地方有 AI 在跑就不让改，免得互相覆盖；判断和自动保存同一处，刚开始一轮、还没改文件时也算
  const aiBusy =
    useSyncExternalStore(subscribeEngine, () =>
      aiBusyFor(tab, getEngineState().sessions, (window.pixelsky?.platform ?? 'win32') !== 'linux'),
    ) || aiRunning
  const readOnly = aiBusy || (tab.document?.kind === 'text' && !!tab.document.readonly)
  const jump = (delta: 1 | -1): void => {
    const view = nav.current
    if (!view) return
    if (delta > 0) goToNextChunk(view)
    else goToPreviousChunk(view)
    view.focus()
  }
  return (
    <div data-coding-diffpane className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
        {turnBaseline !== null && (
          <Segmented
            label={tr('coding.editor.base')}
            value={base}
            onChange={onBase}
            options={[
              { value: 'head', label: tr('coding.editor.base.head') },
              { value: 'turn', label: tr('coding.editor.base.turn') },
            ]}
          />
        )}
        <span className="flex-1" />
        {(aiBusy || !readOnly) && (
          <span data-coding-diff-hint className="truncate text-meta text-fg-faint">
            {aiBusy
              ? tr('coding.editor.diff.aiRunning')
              : tr('coding.editor.diff.editable', { keys: isMac ? '⌘S' : 'Ctrl+S' })}
          </span>
        )}
        <IconButton icon={ChevronUp} label={tr('git.diff.prev')} size={26} iconSize={14} onClick={() => jump(-1)} />
        <IconButton icon={ChevronDown} label={tr('git.diff.next')} size={26} iconSize={14} onClick={() => jump(1)} />
      </div>
      {fellBack && (
        <p role="status" className="shrink-0 border-b border-line-subtle bg-subtle px-3 py-1 text-meta text-fg-muted">
          {tr('coding.editor.base.fallback')}
        </p>
      )}
      {(tab.external || tab.error) && (
        <div
          role="status"
          className={cn(
            'flex shrink-0 items-center gap-2 border-b border-line-subtle bg-subtle px-3 py-1 text-meta',
            tab.error ? 'text-danger' : 'text-fg',
          )}
        >
          <span className="min-w-0 flex-1">
            {tab.error ? translateMessage(tab.error) : tr('editor.FileEditor.fileChangedExternallyYour')}
          </span>
          <button type="button" className="shrink-0 text-accent-fg hover:underline" onClick={onShowCode}>
            {tr('coding.editor.diff.showCode')}
          </button>
        </div>
      )}
      <DiffEditor
        tabId={tab.id}
        path={tab.path}
        original={original}
        modified={tab.draft}
        mode={mode === 'split' ? 'split' : 'inline'}
        readOnly={readOnly}
        navRef={nav}
        marker="coding-diff"
      />
    </div>
  )
}
