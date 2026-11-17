import { useEffect, useRef, useState } from 'react'
import { Download, File, ImageIcon, RefreshCw } from 'lucide-react'
import type { DotAttachment } from '@pixelsky/engine'
import { ImageViewer } from '@/ui/ImageViewer'
import { Spinner } from '@/ui'
import { tr, translateMessage } from '@/i18n/core'
import { useDotKey } from './context'

export const isDotImage = (file: DotAttachment): boolean =>
  /^image\/(png|jpeg|webp|gif)$/i.test(file.mime ?? '') || /\.(png|jpe?g|webp|gif)$/i.test(file.name)

/** 只按当前房间的文件 ID 取图；不使用历史消息里的过期公开 URL。 */
export function DotFile({ file, compact = false }: { file: DotAttachment; compact?: boolean }) {
  const key = useDotKey()
  const image = isDotImage(file)
  const [url, setUrl] = useState('')
  const [near, setNear] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const tile = useRef<HTMLButtonElement>(null)
  const name = file.name || tr('dot.attachment')
  const wanted = near || open
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
    let objectUrl = ''
    setBusy(true)
    setError('')
    void window
      .pixelsky!.dotChat.file(key, file.fileId)
      .then(data => {
        if (gone) return
        const bytes = Uint8Array.from(atob(data.dataBase64), char => char.charCodeAt(0))
        const mime = /^image\/(png|jpeg|webp|gif)$/i.test(data.mime)
          ? data.mime
          : file.mime ||
            `image/${/\.jpe?g$/i.test(name) ? 'jpeg' : /\.webp$/i.test(name) ? 'webp' : /\.gif$/i.test(name) ? 'gif' : 'png'}`
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }))
        setUrl(objectUrl)
      })
      .catch(e => {
        if (!gone) setError(String(e))
      })
      .finally(() => {
        if (!gone) setBusy(false)
      })
    return () => {
      gone = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
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
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={compact ? 'min-w-0' : image ? 'dot-image-file' : 'min-w-0'}>
      <button
        ref={tile}
        type="button"
        className={compact ? 'dot-output-row w-full text-left' : image ? 'dot-image-tile' : 'dot-file-chip'}
        title={name}
        aria-label={`${tr(image ? 'composer.attachment.preview' : 'dot.download')} ${name}`}
        disabled={!file.fileId || (busy && !image)}
        onClick={() => (image ? (error ? setAttempt(v => v + 1) : setOpen(true)) : void save())}
      >
        {!compact && image ? (
          <>
            {url && !error ? (
              <img src={url} alt={name} onError={() => setError(tr('dot.imageUnavailable'))} />
            ) : busy ? (
              <Spinner />
            ) : error ? (
              <RefreshCw size={20} />
            ) : (
              <ImageIcon size={24} />
            )}
            <span className="dot-image-caption">{name}</span>
          </>
        ) : (
          <>
            <File size={17} />
            <span className="truncate">{name}</span>
            {busy ? <Spinner /> : !image && <Download size={13} />}
          </>
        )}
      </button>
      {error && (
        <p role="alert" className="mt-1 max-w-56 text-label text-warn">
          {translateMessage(error)}
        </p>
      )}
      {open && url && !error && <ImageViewer src={url} name={name} onClose={() => setOpen(false)} />}
    </div>
  )
}
