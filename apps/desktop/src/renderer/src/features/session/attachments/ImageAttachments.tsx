import { useContext, useEffect, useRef, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import { ImageAnnotator } from './ImageAnnotator'
import type { ImageAttachment } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { imageBlob, imageSize } from './images'
import { fullImage, ImageSessionContext } from './imageSource'
import { cn } from '@/ui'
import { ImageViewer } from '@/ui/ImageViewer'

function ImageTile({
  image,
  itemId,
  onRemove,
  onReplace,
  compact = false,
  caption = true,
  thumb = false,
  more = 0,
}: {
  image: ImageAttachment
  /** 对话里的图：所在条目（图片不带数据时按需取原图，imageSource.ts） */
  itemId?: string
  /** 小缩略图、不显示文件名（消息队列里用；文件名在悬停提示里） */
  compact?: boolean
  /** 图下面写文件名；关掉时只有缩略图（文件名在悬停提示和 alt 里） */
  caption?: boolean
  /** 对话里「模型看过的图」那一行下面的横条缩略图（132×84，不写文件名） */
  thumb?: boolean
  /** 没显示出来的张数：盖在这张上写「+N」 */
  more?: number
  onRemove?: (id: string) => void
  /** 标注后替换这张图（docs/ui/rewind-fork-sidechat.md §6） */
  onReplace?: (id: string, next: ImageAttachment) => void
}) {
  useI18n()
  const [url, setUrl] = useState(''),
    [missing, setMissing] = useState(false),
    [open, setOpen] = useState(false),
    [annotating, setAnnotating] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const sessionId = useContext(ImageSessionContext)
  // 横条缩略图常驻在对话里（行不卸载，只是 content-visibility 不画）：快到屏幕上才取原图，离开就放掉，
  // 否则长会话一打开就把所有看过的图都从主进程取一遍（docs/perf-audit-2026-10-18.md B1）
  const [near, setNear] = useState(!thumb)
  useEffect(() => {
    const el = trigger.current
    if (!thumb || !el) return
    const io = new IntersectionObserver(([e]) => setNear(!!e?.isIntersecting), { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [thumb])
  useEffect(() => {
    if (!near) return
    let url = '',
      gone = false
    setMissing(false)
    void fullImage(image, sessionId, itemId).then(full => {
      if (gone) return
      // 读不到（文件删了、在远程机器上）：缩略图位置写文件名，不空着
      if (!full) return setMissing(true)
      url = URL.createObjectURL(imageBlob(full))
      setUrl(url)
    })
    return () => {
      gone = true
      if (url) URL.revokeObjectURL(url)
      setUrl('')
    }
  }, [near, image.id, image.dataBase64, image.mediaType, sessionId, itemId])
  const description = `${image.name} · ${image.width}×${image.height} · ${imageSize(image.bytes)}`
  return (
    <>
      <div
        data-image-attachment={image.id}
        className={cn(
          'group relative overflow-hidden border border-line-card bg-subtle',
          compact ? 'size-10 rounded-md' : thumb ? 'h-[84px] w-[132px] rounded-lg' : 'h-24 w-24 rounded-lg',
        )}
      >
        <button
          ref={trigger}
          type="button"
          className="block size-full"
          aria-label={`${tr('composer.attachment.preview')} ${image.name}`}
          title={description}
          onClick={() => setOpen(true)}
        >
          {url && <img src={url} alt={image.name} className="size-full object-cover" />}
          {missing && !url && (
            <span className="block truncate px-1.5 text-label text-fg-faint" title={image.name}>
              {image.name}
            </span>
          )}
          {more > 0 && (
            <span className="absolute inset-0 grid place-items-center bg-(--scrim) text-meta font-semibold text-white">
              +{more}
            </span>
          )}
        </button>
        {onReplace && (
          <button
            type="button"
            aria-label={`${tr('annotate.open')} ${image.name}`}
            title={tr('annotate.open')}
            onClick={() => setAnnotating(true)}
            className="absolute top-1 left-1 inline-flex size-5 items-center justify-center rounded-full border border-line-card bg-popover text-fg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-hover"
          >
            <Pencil size={11} />
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            aria-label={`${tr('composer.attachment.remove')} ${image.name}`}
            title={tr('composer.attachment.remove')}
            onClick={() => onRemove(image.id)}
            className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full border border-line-card bg-popover text-fg hover:bg-hover"
          >
            <X size={12} />
          </button>
        )}
        {!compact && !thumb && caption && (
          <span className="pointer-events-none absolute right-0 bottom-0 left-0 truncate border-t border-line-card bg-popover px-1 py-0.5 text-label text-fg-secondary">
            {image.name}
          </span>
        )}
      </div>
      {open && url && (
        <ImageViewer
          src={url}
          name={image.name}
          bytes={image.bytes}
          onClose={() => setOpen(false)}
          actions={
            onReplace && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  setAnnotating(true)
                }}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg"
              >
                <Pencil size={13} />
                {tr('annotate.open')}
              </button>
            )
          }
        />
      )}
      {annotating && onReplace && (
        <ImageAnnotator
          image={image}
          onClose={() => setAnnotating(false)}
          onDone={next => {
            setAnnotating(false)
            onReplace(image.id, next)
          }}
        />
      )}
    </>
  )
}
export function ImageAttachments({
  images,
  itemId,
  onRemove,
  onReplace,
  compact,
  caption,
}: {
  images: ImageAttachment[]
  /** 对话里的图所在条目：图片不带数据时按需取原图 */
  itemId?: string
  compact?: boolean
  /** 图下面写文件名（默认写）；频道消息里只放缩略图 */
  caption?: boolean
  onRemove?: (id: string) => void
  onReplace?: (id: string, next: ImageAttachment) => void
}) {
  return (
    <div data-image-attachments className="flex max-h-56 min-w-0 flex-wrap gap-2 overflow-y-auto">
      {images.map(image => (
        <ImageTile
          key={image.id}
          image={image}
          itemId={itemId}
          onRemove={onRemove}
          onReplace={onReplace}
          compact={compact}
          caption={caption}
        />
      ))}
    </div>
  )
}

/** 模型看过的图：一排横条缩略图，最多 3 张，多的在最后一张上写「+N」，点了放大（docs/ui/image-view-thumbnail-mockup.html）。
 *  图可能来自不同条目（「执行」收起时汇总里面几行看过的图），所以每张带自己的条目 id */
export function ImageThumbs({
  entries,
  max = 3,
}: {
  entries: { image: ImageAttachment; itemId: string }[]
  max?: number
}) {
  const shown = entries.slice(0, max)
  return (
    <div data-image-thumbs className="flex min-w-0 flex-wrap gap-1.5">
      {shown.map((e, i) => (
        <ImageTile
          key={e.image.id}
          image={e.image}
          itemId={e.itemId}
          thumb
          more={i === shown.length - 1 ? entries.length - shown.length : 0}
        />
      ))}
    </div>
  )
}
