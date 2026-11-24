// 截图标注窗口（docs/ui/rewind-fork-sidechat.md §6）：框、箭头、文字；颜色、粗细；撤销、用原图；完成后替换输入框里的图
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, ImageOff, Square, Type, Undo2, X } from 'lucide-react'
import { MAX_IMAGE_BYTES, type ImageAttachment } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Button, IconButton, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import {
  COLOR_NAMES,
  colorVar,
  drawShapes,
  fontSize,
  tooSmall,
  type ColorName,
  type Shape,
  type Size,
  type Tool,
} from './annotate'
import { imageBlob } from './images'

/** 标注过的图 → 原图（这次运行期间保留，再次打开时可以「用原图」）；只留最近 10 张，原图可能很大 */
const originals = new Map<string, ImageAttachment>()
const MAX_ORIGINALS = 10
function rememberOriginal(id: string, original: ImageAttachment): void {
  originals.delete(id)
  originals.set(id, original)
  while (originals.size > MAX_ORIGINALS) originals.delete(originals.keys().next().value!)
}

const TOOLS: { id: Tool; icon: typeof Square; label: 'annotate.box' | 'annotate.arrow' | 'annotate.text' }[] = [
  { id: 'box', icon: Square, label: 'annotate.box' },
  { id: 'arrow', icon: ArrowUpRight, label: 'annotate.arrow' },
  { id: 'text', icon: Type, label: 'annotate.text' },
]
const SIZES: Size[] = ['small', 'medium', 'large']

export function ImageAnnotator({
  image,
  onDone,
  onClose,
}: {
  image: ImageAttachment
  onDone: (next: ImageAttachment) => void
  onClose: () => void
}) {
  useI18n()
  const original = originals.get(image.id) ?? null
  const canvas = useRef<HTMLCanvasElement>(null)
  const [bitmap, setBitmap] = useState<HTMLImageElement | null>(null)
  const [tool, setTool] = useState<Tool>('box')
  const [color, setColor] = useState<ColorName>('red')
  const [size, setSize] = useState<Size>('medium')
  const [shapes, setShapes] = useState<Shape[]>([])
  const [draft, setDraft] = useState<Shape | null>(null)
  const [typing, setTyping] = useState<{ x: number; y: number; left: number; top: number; text: string } | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dirty = shapes.length > 0 || !!typing?.text

  useEffect(() => {
    const blob = imageBlob(image)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => setBitmap(img)
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [image])

  useEffect(() => {
    const c = canvas.current
    if (!c || !bitmap) return
    c.width = bitmap.naturalWidth
    c.height = bitmap.naturalHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    drawShapes(ctx, draft ? [...shapes, draft] : shapes, c.width, c.height)
  }, [bitmap, shapes, draft])

  const close = (): void => (dirty ? setDiscarding(true) : onClose())
  const undo = (): void => setShapes(s => s.slice(0, -1))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (discarding || typing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  /** 鼠标位置 → 图片像素 */
  const point = (e: ReactPointerEvent): { x: number; y: number; left: number; top: number } => {
    const rect = canvas.current!.getBoundingClientRect()
    const scale = canvas.current!.width / rect.width
    return {
      x: (e.clientX - rect.left) * scale,
      y: (e.clientY - rect.top) * scale,
      left: e.clientX - rect.left,
      top: e.clientY - rect.top,
    }
  }

  const commitText = (): void => {
    if (typing?.text.trim())
      setShapes(s => [...s, { kind: 'text', x: typing.x, y: typing.y, text: typing.text.trim(), color, size }])
    setTyping(null)
  }

  const finish = async (): Promise<void> => {
    const c = canvas.current
    if (!c) return
    setSaving(true)
    setError(null)
    try {
      const blob = await toBlob(c)
      if (blob.size > MAX_IMAGE_BYTES) throw new Error(tr('annotate.tooLarge'))
      const next = await toAttachment(blob, image.name, c.width, c.height)
      rememberOriginal(next.id, original ?? image)
      onDone(next)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const scale = bitmap && canvas.current ? canvas.current.getBoundingClientRect().width / bitmap.naturalWidth : 1

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={tr('annotate.title')}
      data-image-annotator
      className="fixed inset-0 z-[120] flex items-center justify-center bg-scrim p-6"
      onPointerDown={e => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="flex max-h-full max-w-full flex-col overflow-hidden rounded-xl border border-line-card bg-popover shadow-popover">
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line-subtle px-3 py-2">
          {TOOLS.map(t => (
            <IconButton
              key={t.id}
              icon={t.icon}
              label={tr(t.label)}
              active={tool === t.id}
              aria-pressed={tool === t.id}
              onClick={() => setTool(t.id)}
            />
          ))}
          <span className="mx-1 h-5 w-px bg-line" />
          <span role="radiogroup" aria-label={tr('annotate.color')} className="flex items-center gap-1">
            {COLOR_NAMES.map(name => (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={color === name}
                aria-label={tr(`annotate.${name}`)}
                title={tr(`annotate.${name}`)}
                onClick={() => setColor(name)}
                className={cn(
                  'size-5 rounded-full border-2',
                  color === name ? 'border-fg' : 'border-transparent hover:border-line-strong',
                )}
                style={{ background: colorVar(name) }}
              />
            ))}
          </span>
          <span className="mx-1 h-5 w-px bg-line" />
          <span role="radiogroup" aria-label={tr('annotate.size')} className="flex items-center gap-0.5">
            {SIZES.map((s, i) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={size === s}
                aria-label={tr(`annotate.${s}`)}
                title={tr(`annotate.${s}`)}
                onClick={() => setSize(s)}
                className={cn(
                  'inline-flex size-7 items-center justify-center rounded-md hover:bg-hover',
                  size === s && 'bg-hover',
                )}
              >
                <span className="rounded-full bg-fg" style={{ width: 4 + i * 3, height: 4 + i * 3 }} />
              </button>
            ))}
          </span>
          <span className="mx-1 h-5 w-px bg-line" />
          <IconButton icon={Undo2} label={tr('annotate.undo')} disabled={shapes.length === 0} onClick={undo} />
          {original && (
            <Button variant="ghost" icon={ImageOff} className="h-8 px-2 text-meta" onClick={() => onDone(original)}>
              {tr('annotate.original')}
            </Button>
          )}
          <span className="flex-1" />
          {error && <span className="mr-2 text-meta text-danger">{error}</span>}
          <Button variant="ghost" className="h-8 px-3 text-meta" onClick={close}>
            {tr('annotate.cancel')}
          </Button>
          <Button
            variant="primary"
            className="h-8 px-3 text-meta"
            disabled={saving || !bitmap}
            onClick={() => void finish()}
          >
            {tr('annotate.done')}
          </Button>
          <IconButton icon={X} label={tr('annotate.cancel')} onClick={close} />
        </div>
        <div className="relative min-h-0 overflow-auto bg-subtle p-3">
          <div className="relative">
            <canvas
              ref={canvas}
              className={cn(
                'block max-h-[72vh] max-w-[86vw] touch-none',
                tool === 'text' ? 'cursor-text' : 'cursor-crosshair',
              )}
              onPointerDown={e => {
                if (!bitmap) return
                const p = point(e)
                if (tool === 'text') {
                  commitText()
                  setTyping({ ...p, text: '' })
                  return
                }
                e.currentTarget.setPointerCapture(e.pointerId)
                setDraft({ kind: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, size })
              }}
              // 文字工具：按下鼠标默认会把焦点移走，刚出现的输入框会马上失焦关掉
              onMouseDown={e => tool === 'text' && e.preventDefault()}
              onPointerMove={e => {
                if (!draft || draft.kind === 'text') return
                const p = point(e)
                setDraft({ ...draft, x2: p.x, y2: p.y })
              }}
              onPointerUp={() => {
                if (draft && !tooSmall(draft)) setShapes(s => [...s, draft])
                setDraft(null)
              }}
            />
            {typing && bitmap && (
              <input
                autoFocus
                value={typing.text}
                placeholder={tr('annotate.textPlaceholder')}
                aria-label={tr('annotate.text')}
                onChange={e => setTyping({ ...typing, text: e.target.value })}
                onKeyDown={e => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitText()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    setTyping(null)
                  }
                }}
                onBlur={commitText}
                className="absolute min-w-40 rounded-sm border border-dashed border-line-strong bg-transparent px-0.5 font-semibold outline-none"
                style={{
                  left: typing.left,
                  top: typing.top,
                  color: colorVar(color),
                  fontSize: Math.max(12, fontSize(bitmap.naturalWidth, bitmap.naturalHeight, size) * scale),
                }}
              />
            )}
          </div>
        </div>
      </div>
      {discarding && (
        <ConfirmDialog
          title={tr('annotate.discard')}
          description=""
          confirmLabel={tr('annotate.discardConfirm')}
          cancelLabel={tr('annotate.keep')}
          danger
          busy={false}
          onCancel={() => setDiscarding(false)}
          onConfirm={onClose}
        />
      )}
    </div>,
    document.body,
  )
}

/** PNG；超过 10 MiB 改用 JPEG */
async function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  const as = (type: string, quality?: number): Promise<Blob> =>
    new Promise((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('canvas'))), type, quality))
  const png = await as('image/png')
  return png.size <= MAX_IMAGE_BYTES ? png : as('image/jpeg', 0.9)
}

async function toAttachment(blob: Blob, name: string, width: number, height: number): Promise<ImageAttachment> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error(tr('composer.attachment.readError')))
    reader.readAsDataURL(blob)
  })
  return {
    id: crypto.randomUUID(),
    name,
    mediaType: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    bytes: blob.size,
    width,
    height,
    dataBase64,
  }
}
