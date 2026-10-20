import { FILE_STAGE_CHUNK_BYTES, MAX_STAGED_FILE_BYTES } from '@pixelsky/protocol'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { tr } from '@/i18n/core'

const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)))
  return btoa(binary)
}

export interface StageOptions {
  /** 每传完一块报一次：已传的字节数 */
  onProgress?: (sent: number) => void
  /** 取消：停在下一块之前，删掉半截文件，抛 AbortError */
  signal?: AbortSignal
}

const aborted = (): DOMException => new DOMException(tr('composer.file.uploadCancelled'), 'AbortError')

/** 将文件分块传到当前工作区所属机器的私有临时路径。 */
export async function stageFile(file: File, ref: WorkspaceRef, options: StageOptions = {}): Promise<string> {
  if (file.size > MAX_STAGED_FILE_BYTES) throw new Error(tr('composer.file.remoteTooLarge', { p0: file.name }))
  const files = window.pixelsky?.files
  if (!files) throw new Error(tr('composer.file.stageUnavailable'))
  const { onProgress, signal } = options
  if (signal?.aborted) throw aborted()
  const id = crypto.randomUUID()
  let begun = false
  try {
    await files.stage(ref, { action: 'begin', id, name: file.name || 'attachment', bytes: file.size })
    begun = true
    for (let offset = 0; offset < file.size; offset += FILE_STAGE_CHUNK_BYTES) {
      if (signal?.aborted) throw aborted()
      const end = Math.min(file.size, offset + FILE_STAGE_CHUNK_BYTES)
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer())
      await files.stage(ref, { action: 'chunk', id, offset, dataBase64: base64(bytes) })
      onProgress?.(end)
    }
    if (signal?.aborted) throw aborted()
    const result = await files.stage(ref, { action: 'finish', id })
    if (!result.path) throw new Error(tr('composer.file.stageUnavailable'))
    return result.path
  } catch (error) {
    if (begun) await files.stage(ref, { action: 'cancel', id }).catch(() => undefined)
    throw error
  }
}

/** 从输入框移除附件时删掉它的暂存副本；删不掉（机器断开）不报错，30 天后照样清理 */
export async function discardStaged(path: string, ref: WorkspaceRef | null): Promise<void> {
  if (!ref) return
  await window.pixelsky?.files.stage(ref, { action: 'remove', path }).catch(() => undefined)
}
