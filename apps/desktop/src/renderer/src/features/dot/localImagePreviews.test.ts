import { describe, expect, it } from 'vitest'
import type { DotChatMessage } from '@pixelsky/engine'
import { dotTranscript } from './conversation'
import { dotPreviewAttachments, type DotLocalSend } from './localImagePreviews'

const request: DotLocalSend = {
  id: 'request-7',
  text: 'here',
  createdAt: 10,
  files: [
    { id: 'first', name: 'same.png', bytes: 10 },
    { id: 'second', name: 'same.png', bytes: 20 },
  ],
  optimistic: true,
}
const echo: DotChatMessage = {
  id: 'server-8',
  requestId: request.id,
  text: request.text,
  role: 'user',
  createdAt: 11,
  attachments: [
    { type: 'file', name: 'same.png', fileId: 'uploaded-a' },
    { type: 'file', name: 'same.png', fileId: 'uploaded-b' },
  ],
}
const urls = { first: 'blob:first', second: 'blob:second' }

describe('Dot local image previews', () => {
  it('renders immediately, preserves stable attachment keys once the exact request is echoed, and keeps remote IDs', () => {
    const [pending] = dotTranscript([], [], [request])
    expect(pending?.id).toBe(request.id)
    expect(dotPreviewAttachments(pending!.attachments, request, false, urls).map(({ key, url }) => [key, url])).toEqual(
      [
        ['first', 'blob:first'],
        ['second', 'blob:second'],
      ],
    )
    const [native] = dotTranscript([echo], [], [request])
    expect(native?.id).toBe(request.id)
    expect(
      dotPreviewAttachments(native!.attachments, request, true, urls).map(({ key, file, url }) => [
        key,
        file.fileId,
        url,
      ]),
    ).toEqual([
      ['first', 'uploaded-a', 'blob:first'],
      ['second', 'uploaded-b', 'blob:second'],
    ])
  })

  it('falls back to remote loading for unrelated requests or incomplete native attachment lists', () => {
    expect(dotPreviewAttachments(echo.attachments, undefined, true, urls).every(item => !item.url)).toBe(true)
    expect(dotPreviewAttachments(echo.attachments.slice(1), request, true, urls).every(item => !item.url)).toBe(true)
  })
})
