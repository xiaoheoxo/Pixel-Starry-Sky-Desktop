import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileSpreadsheet, FileText, Presentation, X, type LucideIcon } from 'lucide-react'
import { fileShownLines, type FileAttachment, type FileSource } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { estimateTokens, fileSize, looksSecret } from './files'

const count = (n: number): string => n.toLocaleString()
const sourceName = (source: FileSource): string => tr(`composer.file.source.${source}`)
const ICON: Partial<Record<FileSource, LucideIcon>> = {
  xlsx: FileSpreadsheet,
  ods: FileSpreadsheet,
  pptx: Presentation,
  odp: Presentation,
}
const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

/** 预览：发给智能体的正文，截断处标出省略了多少行 */
function FilePreview({ file, onClose }: { file: FileAttachment; onClose: () => void }) {
  const popup = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    popup.current?.focus()
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close.current()
      }
    }
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('keydown', escape, true)
      if (before?.isConnected) before.focus()
    }
  }, [])
  return createPortal(
    <div
      ref={popup}
      role="dialog"
      aria-modal="true"
      aria-label={`${tr('composer.file.preview')} ${file.name}`}
      tabIndex={-1}
      className="fixed inset-0 z-[110] flex items-center justify-center bg-scrim p-6 outline-none"
      onClick={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-full w-[min(900px,90vw)] flex-col overflow-hidden rounded-xl border border-line-card bg-popover shadow-popover">
        <div className="flex shrink-0 items-center gap-3 px-4 py-2 text-meta text-fg-secondary">
          <span className="min-w-0 flex-1 truncate">
            <span className="text-fg">{file.name}</span> ·{' '}
            {file.pathOnly
              ? tr('composer.file.referencePreviewHint')
              : `${tr('composer.file.previewHint')} · ${
                  file.source
                    ? tr('composer.file.textOnlyHint', { p0: sourceName(file.source) })
                    : tr('composer.file.encoding', { p0: file.encoding.toUpperCase() })
                }`}
          </span>
          <button
            type="button"
            aria-label={tr('composer.file.closePreview')}
            onClick={onClose}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-hover"
          >
            <X size={16} />
          </button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto border-t border-line-card px-4 py-3 font-mono text-meta whitespace-pre-wrap break-words text-fg">
          {file.pathOnly ? (
            <span>{tr('composer.file.referencePreview', { p0: file.path ?? '' })}</span>
          ) : (
            <>
              {file.text}
              {file.tail !== undefined && (
                <span className="my-1 block text-center text-fg-muted select-none">
                  {tr(file.tail ? 'composer.file.omitted' : 'composer.file.headOnly', { p0: count(file.omitted ?? 0) })}
                </span>
              )}
              {file.tail}
            </>
          )}
        </pre>
      </div>
    </div>,
    document.body,
  )
}

function FileCard({ file, onRemove }: { file: FileAttachment; onRemove?: (id: string) => void }) {
  useI18n()
  const [open, setOpen] = useState(false)
  const pathOnly = file.pathOnly === true
  const truncated = file.tail !== undefined
  const byPath = !!file.path && (pathOnly || (truncated && !file.source))
  const shown = pathOnly ? { head: 0, tail: 0 } : fileShownLines(file)
  // 只在输入框里提醒；已经发出去的不再标
  const secret = !!onRemove && looksSecret(file.name)
  const estimate = pathOnly ? 0 : estimateTokens(file.text) + estimateTokens(file.tail ?? '')
  const meta = [fileSize(file.bytes)]
  if (!pathOnly) meta.push(tr('composer.file.lines', { p0: count(file.lines) }))
  if (onRemove && !pathOnly) meta.push(tr('composer.file.tokens', { p0: tokens(estimate) }))
  const hint = pathOnly
    ? tr('composer.file.referenceHint', { p0: file.path ?? '' })
    : !truncated
      ? undefined
      : file.tail
        ? tr('composer.file.truncatedHint', {
            p0: count(shown.head),
            p1: count(shown.tail),
            p2: count(file.omitted ?? 0),
          })
        : tr('composer.file.headOnlyHint', { p0: count(shown.head), p1: count(file.omitted ?? 0) })
  const Icon = (file.source && ICON[file.source]) ?? FileText
  return (
    <div
      data-file-attachment={file.id}
      className={cn(
        'group relative flex h-12 max-w-72 min-w-40 items-center gap-2 rounded-lg border border-line-card bg-subtle pl-2',
        onRemove ? 'pr-7' : 'pr-3',
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        aria-label={`${tr('composer.file.preview')} ${file.name}`}
        title={[
          file.name,
          file.source && tr('composer.file.textOnlyHint', { p0: sourceName(file.source) }),
          hint,
          pathOnly
            ? tr('composer.file.referenceHint', { p0: file.path ?? '' })
            : byPath
              ? tr('composer.file.byPathHint', { p0: file.path! })
              : file.path && tr('composer.file.path', { p0: file.path }),
          secret && tr('composer.file.secretHint'),
        ]
          .filter(Boolean)
          .join('\n')}
        onClick={() => setOpen(true)}
      >
        <Icon size={18} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-list text-fg">{file.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-label text-fg-muted">
            <span className="truncate">{meta.join(' · ')}</span>
            {file.source && <span className="shrink-0">{tr('composer.file.textOnly')}</span>}
            {pathOnly ? (
              <span data-file-by-path className="shrink-0">
                {tr(file.staged ? 'composer.file.staged' : 'composer.file.pathOnly')}
              </span>
            ) : byPath ? (
              <span data-file-by-path className="shrink-0">
                {tr('composer.file.byPath')}
              </span>
            ) : (
              truncated && <span className="shrink-0 text-warn">{tr('composer.file.truncated')}</span>
            )}
            {secret && <span className="shrink-0 text-warn">{tr('composer.file.secret')}</span>}
          </span>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`${tr('composer.file.remove')} ${file.name}`}
          title={tr('composer.file.remove')}
          onClick={() => onRemove(file.id)}
          className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full border border-line-card bg-popover text-fg hover:bg-hover"
        >
          <X size={12} />
        </button>
      )}
      {open && <FilePreview file={file} onClose={() => setOpen(false)} />}
    </div>
  )
}

export function FileAttachments({ files, onRemove }: { files: FileAttachment[]; onRemove?: (id: string) => void }) {
  return (
    <div data-file-attachments className="flex max-h-40 min-w-0 flex-wrap gap-2 overflow-y-auto">
      {files.map(file => (
        <FileCard key={file.id} file={file} onRemove={onRemove} />
      ))}
    </div>
  )
}
