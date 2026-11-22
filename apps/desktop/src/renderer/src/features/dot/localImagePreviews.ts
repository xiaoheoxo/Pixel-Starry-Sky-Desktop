import type { DotAttachment } from '@pixelsky/engine'
import type { DotLocalFile } from '../../../../shared/types/dot-chat'

export interface DotLocalSend {
  id: string
  text: string
  createdAt: number
  files: DotLocalFile[]
  optimistic: boolean
}

interface DotPreviewAttachment {
  key: string | number
  file: DotAttachment
  url?: string
}

/** Never match a preview across requests or guess by filename. The file order is the POST attachment order. */
export function dotPreviewAttachments(
  attachments: readonly DotAttachment[],
  local: DotLocalSend | undefined,
  native: boolean,
  urls: Readonly<Record<string, string>>,
): DotPreviewAttachment[] {
  if (local && !native)
    return local.files.map(file => ({
      key: file.id,
      file: { type: 'file', name: file.name, ...(urls[file.id] ? { mime: 'image/png' } : {}) },
      url: urls[file.id],
    }))
  const canMatch = local && attachments.filter(file => file.type === 'file').length === local.files.length
  let index = 0
  return attachments.map((file, i) => {
    const draft = canMatch && file.type === 'file' ? local.files[index++] : undefined
    return { key: draft?.id ?? file.fileId ?? i, file, url: draft ? urls[draft.id] : undefined }
  })
}
