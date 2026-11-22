import { dotError } from './errors'
import { useEffect, useRef, useState } from 'react'
import { Download, File, RefreshCw } from 'lucide-react'
import type { DotAttachment } from '@pixelsky/engine'
import { ImageViewer } from '@/ui/ImageViewer'
import { Spinner } from '@/ui'
import { tr, translateMessage } from '@/i18n/core'
import { useDotKey } from './context'

export const isDotImage = (file: DotAttachment): boolean =>
  /^image\/(png|jpeg|webp|gif)$/i.test(file.mime ?? '') || /\.(png|jpe?g|webp|gif)$/i.test(file.name)

/** 文件卡片第二行：扩展名大写（Dot 的附件没带大小）；没有扩展名写「附件」 */
export function dotFileKind(name: string): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]
  return ext ? ext.toUpperCase() : tr('dot.attachment')
}

/** 同一张图在对话里和详情栏各画一次：共用一次下载，都不用了再收回对象地址；下载失败的不留，重试时重新下 */
const shared = new Map<string, { url: Promise<string>; users: number }>()
function acquireImage(
  key: string,
  fileId: string,
  fallbackMime: string | undefined,
  name: string,
): { url: Promise<string>; release: () => void } {
  const id = `${key}\n${fileId}`
  let hit = shared.get(id)
  if (!hit) {
    const made = {
      users: 0,
      url: window.pixelsky!.dotChat.file(key, fileId).then(data => {
        const bytes = Uint8Array.from(atob(data.dataBase64), char => char.charCodeAt(0))
        const mime = /^image\/(png|jpeg|webp|gif)$/i.test(data.mime)
          ? data.mime
          : fallbackMime ||
            `image/${/\.jpe?g$/i.test(name) ? 'jpeg' : /\.webp$/i.test(name) ? 'webp' : /\.gif$/i.test(name) ? 'gif' : 'png'}`
        return URL.createObjectURL(new Blob([bytes], { type: mime }))
      }),
    }
    made.url.catch(() => {
      if (shared.get(id) === made) shared.delete(id)
    })
    shared.set(id, made)
    hit = made
  }
  const entry = hit
  entry.users++
  return {
    url: entry.url,
    release: () => {
      if (--entry.users > 0) return
      if (shared.get(id) === entry) shared.delete(id)
      void entry.url.then(
        url => URL.revokeObjectURL(url),
        () => undefined,
      )
    },
  }
}

/**
 * 只按当前房间的文件 ID 取图；不使用历史消息里的过期公开 URL。
 * compact：详情栏的一行；thumb：详情栏的缩略图（只给图片用）；都不传是对话里的图片 / 文件卡片
 */
export function DotFile({
  file,
  compact = false,
  thumb = false,
  localUrl,
}: {
  file: DotAttachment
  compact?: boolean
  thumb?: boolean
  localUrl?: string
}) {
  const key = useDotKey()
  const image = !!localUrl || isDotImage(file)
  const [url, setUrl] = useState('')
  const [localFailed, setLocalFailed] = useState<string>()
  const [decoded, setDecoded] = useState<string>()
  const [near, setNear] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const tile = useRef<HTMLButtonElement>(null)
  const name = file.name || tr('dot.attachment')
  const local = localUrl && localUrl !== localFailed ? localUrl : undefined
  const wanted = (!local && near) || open
  const source = local || (error ? '' : url)
  const retryImage = (): void => {
    setError('')
    setAttempt(v => v + 1)
  }
  useEffect(() => {
    const el = tile.current
    if (!el || !image || compact) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '300px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [image, compact])
  useEffect(() => {
    if (!image || !wanted || !file.fileId) return
    let gone = false
    setBusy(true)
    setError('')
    const loading = acquireImage(key, file.fileId, file.mime, name)
    void loading.url
      .then(objectUrl => {
        if (!gone) setUrl(objectUrl)
      })
      .catch(e => {
        if (!gone) setError(dotError(e))
      })
      .finally(() => {
        if (!gone) setBusy(false)
      })
    return () => {
      gone = true
      loading.release()
      setUrl('')
    }
  }, [key, file.fileId, file.mime, image, name, wanted, attempt])
  const save = async () => {
    if (!file.fileId || busy) return
    setBusy(true)
    setError('')
    try {
      await window.pixelsky!.dotChat.saveFile(key, file.fileId)
    } catch (e) {
      setError(dotError(e))
    } finally {
      setBusy(false)
    }
  }
  const picture = image && !compact
  return (
    <div className={picture && !thumb ? 'dot-image-file' : 'min-w-0'}>
      <button
        ref={tile}
        type="button"
        className={
          compact
            ? 'dot-output-row w-full text-left'
            : image
              ? thumb
                ? 'dot-image-tile dot-thumb'
                : 'dot-image-tile'
              : 'dot-file-card'
        }
        title={thumb && error ? translateMessage(error) : name}
        aria-label={`${tr(image ? 'composer.attachment.preview' : 'dot.download')} ${name}`}
        disabled={(!file.fileId && !local) || (busy && !image)}
        onClick={() => (image ? (error && !local ? retryImage() : setOpen(true)) : void save())}
      >
        {picture ? (
          <>
            {!source && error ? (
              <RefreshCw size={thumb ? 16 : 20} />
            ) : (
              <>
                {(!source || decoded !== source) && <span className="dot-image-skeleton" aria-hidden />}
                {source && (
                  <img
                    src={source}
                    alt={name}
                    data-decoded={decoded === source || undefined}
                    onLoad={() => setDecoded(source)}
                    onError={() => {
                      if (local) setLocalFailed(local)
                      else setError(tr('dot.imageUnavailable'))
                    }}
                  />
                )}
              </>
            )}
            {!thumb && <span className="dot-image-caption">{name}</span>}
          </>
        ) : compact ? (
          <>
            <File size={17} />
            <span className="truncate">{name}</span>
            {busy ? <Spinner /> : !image && <Download size={13} />}
          </>
        ) : (
          <>
            <span className="dot-file-thumb">
              <File size={16} />
            </span>
            <span className="dot-file-text">
              <b>{name}</b>
              <span>{dotFileKind(name)}</span>
            </span>
            <span className="dot-file-remove">{busy ? <Spinner /> : <Download size={14} />}</span>
          </>
        )}
      </button>
      {error && !thumb && !local && (
        <p role="alert" className="mt-1 max-w-56 text-label text-warn">
          {translateMessage(error)}
        </p>
      )}
      {open && source && <ImageViewer src={(!error && url) || source} name={name} onClose={() => setOpen(false)} />}
    </div>
  )
}
