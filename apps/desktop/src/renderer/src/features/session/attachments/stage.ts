import { FILE_STAGE_CHUNK_BYTES, MAX_STAGED_FILE_BYTES } from '@pixelsky/protocol'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { tr } from '@/i18n/core'

const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)))
  return btoa(binary)
}

/** 将文件分块传到当前工作区所属机器的私有临时路径。 */
export async function stageFile(file: File, ref: WorkspaceRef): Promise<string> {
  if (file.size > MAX_STAGED_FILE_BYTES) throw new Error(tr('composer.file.remoteTooLarge', { p0: file.name }))
  const files = window.pixelsky?.files
  if (!files) throw new Error(tr('composer.file.stageUnavailable'))
  const id = crypto.randomUUID()
  let begun = false
  try {
    await files.stage(ref, { action: 'begin', id, name: file.name || 'attachment', bytes: file.size })
    begun = true
    for (let offset = 0; offset < file.size; offset += FILE_STAGE_CHUNK_BYTES) {
      const end = Math.min(file.size, offset + FILE_STAGE_CHUNK_BYTES)
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer())
      await files.stage(ref, { action: 'chunk', id, offset, dataBase64: base64(bytes) })
    }
    const result = await files.stage(ref, { action: 'finish', id })
    if (!result.path) throw new Error(tr('composer.file.stageUnavailable'))
    return result.path
  } catch (error) {
    if (begun) await files.stage(ref, { action: 'cancel', id }).catch(() => undefined)
    throw error
  }
}
