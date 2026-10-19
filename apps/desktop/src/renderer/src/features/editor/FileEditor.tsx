import { translateMessage } from '../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Extension } from '@codemirror/state'
import { Eye, FileText, Globe, RefreshCw, Save, FolderTree, WrapText, Columns2 } from 'lucide-react'
import { IconButton, Spinner } from '@/ui'
import {
  activateFile,
  checkFile,
  dirtyFile,
  ensureFile,
  loadFile,
  refreshHead,
  saveFile,
  updateFile,
  useFiles,
} from '@/features/files/store'
import { confirmFiles } from '@/features/files/FileConfirm'
import { CodeEditor } from './code/CodeEditor'
import { fileLanguage } from './code/languages'
import { fileIndent } from './code/positions'
import { MarkdownPreview } from './MarkdownPreview'
import { ImagePreview } from './ImagePreview'
import { ExternalFileButton } from './ExternalFileButton'
import { FileBreadcrumbs } from './FileBreadcrumbs'
import { isDemo } from '@/data'
import { isHtmlPath, previewHtml } from '@/features/files/htmlPreview'
import { machineOf } from '@/features/machines/store'
import { usePacksRevision } from '@/features/extpacks/store'
import { onStoredChange, readStoredFlag } from '@/features/settings/storedValue'

/** 自动换行开关（设置云同步也会写它，desktop.editorWrap） */
const WRAP_KEY = 'pixelsky.editor.wrap'

export function FileEditor({
  id,
  active,
  explorer,
  onMoveToChat,
  extensions,
  footer = true,
  crumbExtra,
  preview: controlledPreview,
  onExitPreview,
}: {
  id: string
  active: boolean
  explorer?: ReactNode
  onMoveToChat?: () => void
  /** 代码模式的审查、透镜等扩展，原样传给 CodeEditor */
  extensions?: readonly Extension[]
  /** 为 false 时隐藏页脚（代码模式由状态栏代替） */
  footer?: boolean
  /** 面包屑后面的附加内容（代码模式的符号和问题计数） */
  crumbExtra?: ReactNode
  /** 受控的预览开关（代码模式由视图切换决定）；传了就不显示眼睛按钮、不用内部状态 */
  preview?: boolean
  /** 受控时双击预览里的块：退出预览并定位到源码行 */
  onExitPreview?: (line: number) => void
}) {
  useI18n()
  usePacksRevision()
  const [treeOpen, setTreeOpen] = useState(() => localStorage.getItem('pixelsky.editor.tree') !== 'false')
  const [narrow, setNarrow] = useState(false),
    [drawerOpen, setDrawerOpen] = useState(false)
  const container = useRef<HTMLElement>(null)
  const treeVisible = treeOpen && (!narrow || drawerOpen)
  const [wordWrap, setWordWrap] = useState(() => readStoredFlag(WRAP_KEY))
  // 另一个窗口或云同步改了自动换行：跟着变
  useEffect(() => onStoredChange(WRAP_KEY, () => setWordWrap(readStoredFlag(WRAP_KEY))), [])
  const files = useFiles(),
    tab = files.tabs.find(t => t.id === id),
    // 不受控时预览开没开记在标签上（没设过时 Markdown 默认开）；打开时指名了行会被设成关（files/store openFile）
    innerPreview = tab?.preview ?? (!!tab && fileLanguage(tab.path) === 'Markdown'),
    controlled = controlledPreview !== undefined,
    preview = controlled ? controlledPreview : innerPreview
  useEffect(() => {
    void ensureFile(id)
  }, [id])
  useEffect(() => {
    if (active) {
      activateFile(id)
      void checkFile(id)
      // 切回这个标签：「变更」的基准跟上这期间换掉的 HEAD
      void refreshHead(id)
    }
  }, [active, id])
  useLayoutEffect(() => {
    const el = container.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      const small = el.clientWidth < 660
      setNarrow(small)
      if (!small) setDrawerOpen(false)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [id, !!tab?.document])
  if (!tab || (tab.loading && !tab.document))
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-meta text-fg-muted">
        <Spinner size={14} />
        {tr('editor.FileEditor.loadingFile')}
      </div>
    )
  const doc = tab.document,
    readonly = doc?.kind === 'text' && doc.readonly
  return (
    <section
      ref={container}
      data-file-editor={id}
      className="@container/filepane flex min-h-0 min-w-0 flex-1 flex-col"
      onFocusCapture={() => {
        if (active) void checkFile(id)
      }}
    >
      <div
        data-file-editor-bar
        className="flex min-h-10 shrink-0 flex-wrap items-start gap-1 border-b border-line-layout px-3 py-1"
      >
        <FileBreadcrumbs tab={tab}>{crumbExtra}</FileBreadcrumbs>
        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-1">
          {!controlled && fileLanguage(tab.path) === 'Markdown' && (
            <IconButton
              icon={Eye}
              size={28}
              iconSize={15}
              label={preview ? tr('editor.FileEditor.backToMarkdownEditor') : tr('editor.FileEditor.previewMarkdown')}
              active={preview}
              onClick={() => {
                updateFile(id, { preview: !preview })
              }}
            />
          )}
          {isHtmlPath(tab.path) && !isDemo && machineOf(tab.ref.projectId ?? tab.ref.sessionId) === 'local' && (
            <IconButton
              icon={Globe}
              size={28}
              iconSize={15}
              label={tr('htmlPreview.open')}
              onClick={() => void previewHtml(tab.ref, tab.path)}
            />
          )}
          {doc?.kind === 'text' && (
            <IconButton
              icon={Save}
              size={28}
              iconSize={15}
              label={tr('editor.FileEditor.saveFileCtrlS')}
              disabled={!!readonly || !dirtyFile(tab) || tab.saving || isDemo}
              onClick={() => void saveFile(id)}
            />
          )}
          <IconButton
            icon={RefreshCw}
            size={28}
            iconSize={15}
            label={tr('editor.FileEditor.reloadFile')}
            disabled={tab.loading || tab.saving}
            onClick={() => {
              void confirmFiles([id], tr('editor.FileEditor.loadNewVersion')).then(ok => {
                if (ok) void loadFile(id)
              })
            }}
          />
          <ExternalFileButton tab={tab} />
          {doc?.kind === 'text' && (
            <IconButton
              icon={WrapText}
              size={28}
              iconSize={15}
              label={tr('workspace.wrap')}
              active={wordWrap}
              aria-pressed={wordWrap}
              onClick={() => {
                setWordWrap(v => !v)
                localStorage.setItem(WRAP_KEY, String(!wordWrap))
              }}
            />
          )}
          {onMoveToChat && (
            <IconButton
              icon={Columns2}
              size={28}
              iconSize={15}
              label={tr('workspace.moveChat')}
              onClick={onMoveToChat}
            />
          )}
          {explorer && (
            <IconButton
              icon={FolderTree}
              size={28}
              iconSize={15}
              label={tr(treeVisible ? 'workspace.hideTree' : 'workspace.tree')}
              active={treeVisible}
              aria-expanded={treeVisible}
              onClick={() => {
                if (narrow) {
                  setTreeOpen(true)
                  setDrawerOpen(v => !v)
                } else {
                  setTreeOpen(v => !v)
                  localStorage.setItem('pixelsky.editor.tree', String(!treeOpen))
                }
              }}
            />
          )}
        </div>
      </div>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {tab.external && (
            <div
              role="status"
              className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-subtle px-3 py-2 text-meta text-fg"
            >
              <span className="flex-1">{tr('editor.FileEditor.fileChangedExternallyYour')}</span>
              <button
                className="text-accent-fg hover:underline"
                onClick={() => {
                  void confirmFiles([id], tr('editor.FileEditor.loadNewVersion')).then(ok => {
                    if (ok) void loadFile(id)
                  })
                }}
              >
                {tr('editor.FileEditor.loadNewVersion')}
              </button>
              <button
                className="text-fg-secondary hover:underline"
                onClick={() =>
                  updateFile(id, {
                    ignoredVersion: tab.external?.kind === 'text' ? tab.external.version : null,
                    external: null,
                  })
                }
              >
                {tr('editor.FileEditor.keepMyChanges')}
              </button>
            </div>
          )}
          {tab.error && (
            <div role="status" className="flex shrink-0 items-start gap-2 px-3 py-2 text-meta text-danger">
              <span className="flex-1">{translateMessage(tab.error)}</span>
              <button
                aria-label={tr('editor.FileEditor.dismissFileNotice')}
                onClick={() => updateFile(id, { error: null })}
              >
                {tr('editor.code.theme.close')}
              </button>
            </div>
          )}
          {readonly && (
            <p className="shrink-0 bg-subtle px-3 py-2 text-meta text-fg-muted">
              {tr('editor.FileEditor.thisFileExceeds2')}
            </p>
          )}
          {doc?.kind === 'text' ? (
            <>
              <div className={preview ? 'hidden' : 'flex min-h-0 flex-1'} inert={preview}>
                <CodeEditor tab={tab} active={active && !preview} wordWrap={wordWrap} extensions={extensions} />
              </div>
              {preview && (
                <MarkdownPreview
                  text={tab.draft}
                  onJump={line => {
                    if (controlled) return onExitPreview?.(line)
                    updateFile(id, {
                      preview: false,
                      reveal: { line, column: 1, seq: (tab.reveal?.seq ?? 0) + 1 },
                    })
                  }}
                />
              )}
              {footer && (
                <footer className="flex min-h-7 shrink-0 flex-wrap items-center justify-end gap-x-3 border-t border-line-layout px-3 py-1 text-label text-fg-muted">
                  {tab.saving && <span className="mr-auto">{tr('editor.FileEditor.saving')}</span>}
                  {dirtyFile(tab) && !tab.saving && <span className="mr-auto">{tr('editor.FileEditor.unsaved')}</span>}
                  <span>
                    {tr('editor.FileEditor.ln')} {tab.cursor.line}
                    {tr('editor.FileEditor.col')} {tab.cursor.column}
                  </span>
                  <span>{fileLanguage(tab.path)}</span>
                  <span>UTF-8{doc.bom ? ' BOM' : ''}</span>
                  <span>{doc.newline.toUpperCase()}</span>
                  <span>{fileIndent(tab.draft).label}</span>
                </footer>
              )}
            </>
          ) : doc?.kind === 'image' ? (
            <ImagePreview key={id} id={id} name={tab.name} src={doc.dataUrl} bytes={doc.bytes} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-ui text-fg-muted">
              <FileText size={24} />
              <p>{doc?.kind === 'unsupported' ? doc.reason : tr('editor.FileEditor.couldNotReadThis')}</p>
              <p className="text-meta">{tr('editor.FileEditor.useExternalEditorButton')}</p>
            </div>
          )}
        </div>
        {explorer && treeVisible && (
          <aside
            data-editor-explorer
            className="flex w-[32%] min-w-52 max-w-72 shrink-0 flex-col border-l border-line-layout bg-panel @max-[660px]/filepane:absolute @max-[660px]/filepane:inset-y-0 @max-[660px]/filepane:right-0 @max-[660px]/filepane:z-20 @max-[660px]/filepane:w-60 @max-[660px]/filepane:shadow-menu"
          >
            {explorer}
          </aside>
        )}
      </div>
    </section>
  )
}
