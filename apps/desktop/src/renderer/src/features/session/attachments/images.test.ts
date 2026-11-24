import { describe, expect, it } from 'vitest'
import { translateMessage } from '../../../../../shared/i18n/translate'
import { imageBlob } from './images'

const image = (dataBase64: string) => ({
  id: 'a',
  name: '',
  mediaType: 'image/png' as const,
  bytes: 3,
  width: 0,
  height: 0,
  dataBase64,
})

describe('图片数据', () => {
  it('是 base64 就转成图片；不是（中文、残缺）时为 null，不抛错', async () => {
    const blob = imageBlob(image('AAEC'))!
    expect(blob.type).toBe('image/png')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0, 1, 2])
    expect(imageBlob(image('图片'))).toBeNull()
    expect(imageBlob(image('A'))).toBeNull()
  })
})

describe('请求太大的超时报错（docs/ui/pixel-request-size.md §7）', () => {
  const raw =
    'Request timed out.: This operation was aborted (20) — the request was 39.4 MB and may be too large to upload in time. Compact the conversation or start a new one.'
  it('中文界面译成中文、写明大小并留着原文；英文界面不变', () => {
    const zh = translateMessage(raw, 'zh-CN')
    expect(zh).toContain('39.4 MB')
    expect(zh).toContain('来不及传完')
    expect(zh).toContain('Request timed out.: This operation was aborted (20)')
    expect(translateMessage(raw, 'en-US')).toBe(raw)
  })
})
