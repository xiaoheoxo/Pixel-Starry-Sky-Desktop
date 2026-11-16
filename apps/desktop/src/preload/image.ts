import type { ImageAttachment } from '@pixelsky/protocol'

/** 云端生图的请求（main/core/image/cloud-image.ts 的 CloudImageRequest） */
export interface CloudImageInput {
  sessionId: string
  groupId: string
  groupName: string
  prompt: string
  size: string
  n: 1 | 2 | 4
  quality: 'low' | 'medium' | 'high'
  /** 有参考图时按参考图改（一次一张） */
  references: ImageAttachment[]
}

/** 云端生图（docs/ui/image-gen.md §6）：生成在后台跑，结果作为一条条目出现在对话里 */
export interface ImageBridge {
  generate(request: CloudImageInput): Promise<{ itemId: string }>
  /** 停止这次生成（已经开始生成的可能照常扣费） */
  cancel(itemId: string): Promise<void>
}
