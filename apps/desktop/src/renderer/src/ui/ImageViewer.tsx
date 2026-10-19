// 双击图片放大查看（docs/ui/image-viewer.md）：盖住整个窗口的浮层，滚轮以鼠标为中心缩放、拖动平移、
// 双击在「适应窗口」和上次的缩放之间切换；+ / - / 0 / 1 键，Esc 或点空白处关闭，焦点还给打开前的元素。
// 缩放、像素显示、网格和代码页的图片预览共用 ./ImageStage
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Grid3x3, Minus, Plus, X } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { cn } from './cn'
import { useToast } from './ComingSoon'
import { ImageStageView, useImageStage } from './ImageStage'
import { setImagePrefs, useImagePrefs } from './imagePrefs'

export const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`

/** 把图片转成 PNG 放进剪贴板（剪贴板只认 PNG） */
async function copyImage(img: HTMLImageElement): Promise<void> {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  canvas.getContext('2d')!.drawImage(img, 0, 0)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvas')
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

export function ImageViewer({
  src,
  name,
  bytes,
  actions,
  onClose,
}: {
  src: string
  name: string
  /** 文件大小；不知道时不写 */
  bytes?: number
  /** 工具栏里额外的按钮（附件的「标注」） */
  actions?: ReactNode
  onClose: () => void
}) {
  useI18n()
  const toast = useToast()
  const prefs = useImagePrefs()
  const dialog = useRef<HTMLDivElement>(null)
  const stage = useImageStage({ inline: false })
  const close = useRef(onClose)
  close.current = onClose
  const vector = src.startsWith('data:image/svg')

  // 焦点进浮层，关掉时还回去；Esc 抢在别的快捷键（窗格、输入框）前面
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const escape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close.current()
    }
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('keydown', escape, true)
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (stage.onKey(e)) {
      e.stopPropagation()
      return
    }
    if (e.key !== 'Tab') return
    // 焦点留在浮层里
    const items = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    if (!items.length) return
    const i = items.indexOf(document.activeElement as HTMLElement)
    e.preventDefault()
    e.stopPropagation()
    items[(i + (e.shiftKey ? -1 : 1) + items.length + (i < 0 && e.shiftKey ? 1 : 0)) % items.length].focus()
  }

  const { natural } = stage
  const percent = Math.round(stage.view.scale * 100)
  const tool =
    'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg disabled:opacity-40'

  return createPortal(
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`${tr('imageViewer.label')} ${name}`}
      tabIndex={-1}
      data-image-viewer=""
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[110] flex flex-col bg-scrim outline-none"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-line-card bg-popover px-3 py-1.5 shadow-sm">
        <span className="min-w-0 flex-1 truncate px-1 text-meta text-fg-secondary" title={name}>
          <span className="font-medium text-fg">{name}</span>
          {natural && ` · ${natural.width}×${natural.height}`}
          {bytes !== undefined && ` · ${sizeText(bytes)}`}
        </span>
        <button
          type="button"
          className={tool}
          title={tr('imageViewer.zoomOut')}
          aria-label={tr('imageViewer.zoomOut')}
          onClick={() => stage.step(-1)}
        >
          <Minus size={15} />
        </button>
        <button
          type="button"
          data-image-viewer-zoom=""
          className={cn(tool, 'w-14 tabular-nums')}
          title={tr('imageViewer.zoomLevel')}
          onClick={stage.fit}
        >
          {percent}%
        </button>
        <button
          type="button"
          className={tool}
          title={tr('imageViewer.zoomIn')}
          aria-label={tr('imageViewer.zoomIn')}
          onClick={() => stage.step(1)}
        >
          <Plus size={15} />
        </button>
        <span className="mx-1 h-4 border-l border-line" />
        <button type="button" className={tool} title={tr('imageViewer.fitTitle')} onClick={stage.fit}>
          {tr('imageViewer.fit')}
        </button>
        <button type="button" className={tool} title={tr('imageViewer.actualTitle')} onClick={() => stage.zoomTo(1)}>
          {tr('imageViewer.actual')}
        </button>
        {!vector && <PixelToggles tool={tool} pixelated={prefs.pixelated} grid={prefs.grid} />}
        <button
          type="button"
          className={tool}
          disabled={!natural}
          onClick={() =>
            void copyImage(stage.img.current!)
              .then(() => toast(tr('imageViewer.copied')))
              .catch((e: Error) => toast(tr('imageViewer.copyFailed', { error: e.message })))
          }
        >
          <Copy size={14} />
          {tr('imageViewer.copy')}
        </button>
        {actions}
        <span className="mx-1 h-4 border-l border-line" />
        <button
          type="button"
          className={cn(tool, 'w-8 px-0')}
          title={tr('imageViewer.close')}
          aria-label={tr('imageViewer.close')}
          onClick={() => close.current()}
        >
          <X size={16} />
        </button>
      </div>
      <ImageStageView
        stage={stage}
        src={src}
        alt={name}
        vector={vector}
        onClick={e => {
          // 点在图片外面的空白处才关；拖完松手不算
          if (stage.moved.current || stage.onImage(e.clientX, e.clientY)) return
          close.current()
        }}
      />
    </div>,
    document.body,
  )
}

/** 「像素」「网格」两个开关（看图浮层和代码页的图片预览都用） */
export function PixelToggles({
  tool,
  pixelated,
  grid,
  compact = false,
}: {
  /** 按钮的样式类；打开时再加 bg-hover text-fg */
  tool: string
  pixelated: boolean
  grid: boolean
  /** 只显示图标 */
  compact?: boolean
}) {
  useI18n()
  return (
    <>
      <button
        type="button"
        aria-pressed={pixelated}
        data-image-pixelated=""
        className={cn(tool, pixelated && 'bg-hover text-fg')}
        title={tr('imageViewer.pixelatedTitle')}
        aria-label={tr('imageViewer.pixelated')}
        onClick={() => setImagePrefs({ pixelated: !pixelated })}
      >
        <PixelIcon />
        {!compact && tr('imageViewer.pixelated')}
      </button>
      <button
        type="button"
        aria-pressed={grid}
        data-image-grid=""
        className={cn(tool, grid && 'bg-hover text-fg')}
        title={tr('imageViewer.gridTitle')}
        aria-label={tr('imageViewer.grid')}
        onClick={() => setImagePrefs({ grid: !grid })}
      >
        <Grid3x3 size={14} />
        {!compact && tr('imageViewer.grid')}
      </button>
    </>
  )
}

/** 四个方块：按像素显示 */
export function PixelIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
    </svg>
  )
}

/** 能双击放大的图片：用法和 <img> 一样，多一个 bytes（显示在查看器的标题里） */
export function ZoomableImage({
  src,
  alt,
  bytes,
  className,
}: {
  src: string
  alt: string
  bytes?: number
  className?: string
}) {
  useI18n()
  const [open, setOpen] = useState(false)
  return (
    <>
      <img
        src={src}
        alt={alt}
        title={tr('imageViewer.hint')}
        data-zoomable-image=""
        onDoubleClick={() => setOpen(true)}
        className={cn('cursor-zoom-in', className)}
      />
      {open && <ImageViewer src={src} name={alt} bytes={bytes} onClose={() => setOpen(false)} />}
    </>
  )
}
