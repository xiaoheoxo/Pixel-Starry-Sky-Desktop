import { describe, expect, it } from 'vitest'
import { trimOldImages } from './codex-images'

const img = (n: number) => ({ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(n) })

describe('trimOldImages', () => {
  it('从最早的图片开始换成文字，放得下就停；工具输出里的图也算', () => {
    const body = {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, img(1000)] },
        { type: 'function_call_output', output: [img(1000)] },
        { type: 'message', role: 'user', content: [img(1000)] },
      ],
    }
    const size = Buffer.byteLength(JSON.stringify(body))
    expect(trimOldImages(body, size, size - 1500)).toBe(2)
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(size - 1500)
    expect(JSON.stringify(body.input[0])).not.toContain('base64')
    expect(JSON.stringify(body.input[1])).not.toContain('base64')
    expect(JSON.stringify(body.input[2])).toContain('base64')
  })
  it('全换掉还放不下返回 null；不是内嵌数据的图不动', () => {
    const body = { input: [{ type: 'message', content: [{ type: 'input_text', text: 'x'.repeat(500) }, img(100)] }] }
    expect(trimOldImages(body, Buffer.byteLength(JSON.stringify(body)), 10)).toBeNull()
    const url = { input: [{ type: 'input_image', image_url: 'https://x/y.png' }] }
    expect(trimOldImages(url, 9999, 10)).toBeNull()
  })
})
