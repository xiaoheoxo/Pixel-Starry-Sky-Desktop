import { useEffect, useState } from 'react'
import { File, ImageIcon, X } from 'lucide-react'
import type { DotLocalFile } from '../../../../shared/types/dot-chat'
import { fileSize } from '@/features/session/attachments/files'
import { tr } from '@/i18n/core'
import { ImageViewer } from '@/ui/ImageViewer'
import { isDotImage } from './DotFile'

export function DotDraftAttachment({
  entryKey,
  file,
  thumbnail,
  open,
  onPreview,
  onRemove,
}: {
  entryKey: string
  file: DotLocalFile
  thumbnail?: string
  open: boolean
  onPreview: (open: boolean) => void
  onRemove: () => void
}) {
  const [attempt, setAttempt] = useState(0)
  const [original, setOriginal] = useState<string>()
  const [failed, setFailed] = useState(false)
  const image = !!thumbnail || isDotImage({ type: 'file', name: file.name })
  const preview = original ?? thumbnail
  useEffect(() => {
    if (!open) {
      setOriginal(undefined)
      setFailed(false)
      return
    }
    let active = true
    let url: string | undefined
    void window
      .pixelsky!.dotChat.previewSelectedImage(entryKey, file.id)
      .then(data => {
        if (!active) return
        const bytes = Uint8Array.from(atob(data.dataBase64), char => char.charCodeAt(0))
        url = URL.createObjectURL(new Blob([bytes], { type: data.mime }))
        setOriginal(url)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [entryKey, file.id, open, attempt])

  const close = () => {
    onPreview(false)
    setOriginal(undefined)
    setFailed(false)
  }
  const content = (
    <>
      <span className="dot-file-thumb">
        {thumbnail ? <img src={thumbnail} alt="" /> : image ? <ImageIcon size={16} /> : <File size={16} />}
      </span>
      <span className="dot-file-text">
        <b>{file.name}</b>
        <span>{fileSize(file.bytes)}</span>
      </span>
    </>
  )

  return (
    <div className="dot-file-card" title={file.name}>
      {image ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline"
          aria-label={`${tr('composer.attachment.preview')} ${file.name}`}
          onClick={() => {
            setFailed(false)
            if (open && failed) setAttempt(n => n + 1)
            onPreview(true)
          }}
        >
          {content}
        </button>
      ) : (
        content
      )}
      <button
        type="button"
        className="dot-file-remove"
        aria-label={`${tr('composer.attachment.remove')} ${file.name}`}
        onClick={onRemove}
      >
        <X size={14} />
      </button>
      {open && !preview && (
        <span className="text-label text-fg-faint" role={failed ? 'alert' : 'status'}>
          {tr(failed ? 'dot.imageUnavailable' : 'dot.loading')}
        </span>
      )}
      {open && preview && (
        <ImageViewer src={preview} name={file.name} bytes={original ? file.bytes : undefined} onClose={close} />
      )}
    </div>
  )
}
