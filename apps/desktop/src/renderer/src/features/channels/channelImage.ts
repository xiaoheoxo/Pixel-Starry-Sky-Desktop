// 频道里云端生图（docs/ui/channel-image-gen.md §3.1）：发起、重试、停止、关掉那一行。
// 「重试」要原来的参数：发起时按返回的 id 记在这个窗口里（重启后失败的那一行只能关掉）
import type { ChannelImageInput } from '../../../../preload/channels'

const requests = new Map<string, ChannelImageInput>()

export async function generateChannelImage(input: ChannelImageInput): Promise<string> {
  const { id } = await window.pixelsky!.channels.generateImage(input)
  requests.set(id, input)
  return id
}

/** 失败那一行能不能重试（这个窗口发起的才记得参数） */
export const canRetryChannelImage = (id: string): boolean => requests.has(id)

/** 用原来的参数再来一次，失败的那一行换成新的 */
export async function retryChannelImage(id: string): Promise<void> {
  const input = requests.get(id)
  if (!input) return
  await dismissChannelImage(id)
  await generateChannelImage(input)
}

export async function cancelChannelImage(id: string): Promise<void> {
  requests.delete(id)
  await window.pixelsky!.channels.cancelImage(id)
}

export async function dismissChannelImage(id: string): Promise<void> {
  requests.delete(id)
  await window.pixelsky!.channels.dismissImage(id)
}
