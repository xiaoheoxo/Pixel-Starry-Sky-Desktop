// 云端生图（docs/ui/image-gen.md §6）
import { describe, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import {
  cloudImageArgs,
  cloudImageBody,
  estimateCost,
  imageTier,
  parseImageEvent,
  runCloudImage,
  type CloudImageRequest,
} from './cloud-image'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaPj/HwAEggJ/59habAAAAABJRU5ErkJggg=='
const req = (over: Partial<CloudImageRequest> = {}): CloudImageRequest => ({
  sessionId: 's1',
  groupId: '41',
  groupName: '生图分组',
  prompt: '夜空',
  size: '1024x1024',
  n: 2,
  quality: 'medium',
  references: [],
  ...over,
})
const ref = { id: 'r', name: 'a.png', mediaType: 'image/png' as const, bytes: 1, width: 0, height: 0, dataBase64: PNG }

describe('计费档位和估算（和 Sub2api 的算法一致）', () => {
  it('按最长边分档', () => {
    expect(imageTier('1024x1024')).toBe('1k')
    expect(imageTier('1536x1024')).toBe('2k')
    expect(imageTier('2048x1152')).toBe('2k')
    expect(imageTier('3840x2160')).toBe('4k')
  })
  it('张数 × 单价 × 倍率；这一档没配单价估不出来', () => {
    const prices = { '1k': 0.1, '2k': 0.15, '4k': 0 }
    expect(estimateCost(prices, 1, '1024x1024', 2)).toBeCloseTo(0.2)
    expect(estimateCost(prices, 0.5, '2048x2048', 4)).toBeCloseTo(0.3)
    expect(estimateCost(prices, 1, '3840x2160', 1)).toBeNull()
    expect(estimateCost(undefined, 1, '1024x1024', 1)).toBeNull()
  })
})

describe('参数校验', () => {
  const ok = {
    sessionId: 's1',
    groupId: '41',
    groupName: 'g',
    prompt: ' 夜空 ',
    size: '1024x1024',
    n: 2,
    quality: 'high',
  }
  it('合法的照收（提示词去掉首尾空白）', () => {
    expect(cloudImageArgs(ok)).toMatchObject({ prompt: '夜空', n: 2, references: [] })
  })
  it('尺寸、张数、质量、分组、提示词不对都拒绝', () => {
    for (const bad of [
      { ...ok, size: '999x999' },
      { ...ok, n: 3 },
      { ...ok, quality: 'ultra' },
      { ...ok, groupId: '../x' },
      { ...ok, prompt: '  ' },
      null,
    ])
      expect(() => cloudImageArgs(bad)).toThrow()
  })
  it('有参考图时一次一张', () => {
    expect(() => cloudImageArgs({ ...ok, references: [ref] })).toThrow('一次一张')
    expect(cloudImageArgs({ ...ok, n: 1, references: [ref] }).references).toHaveLength(1)
  })
})

describe('请求体', () => {
  it('文生图走 generations，带 stream 和一张预览', () => {
    const { path, body } = cloudImageBody(req())
    expect(path).toBe('/v1/platform/images/generations')
    expect(JSON.parse(body)).toEqual({
      prompt: '夜空',
      n: 2,
      size: '1024x1024',
      quality: 'medium',
      stream: true,
      partial_images: 1,
    })
  })
  it('有参考图走 edits，图用 data URL', () => {
    const { path, body } = cloudImageBody(req({ n: 1, references: [ref] }))
    expect(path).toBe('/v1/platform/images/edits')
    expect(JSON.parse(body).images).toEqual([{ image_url: `data:image/png;base64,${PNG}` }])
  })
})

describe('SSE 事件', () => {
  it('预览、成图、错误', () => {
    expect(
      parseImageEvent(
        'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"AA=="}',
      ),
    ).toEqual({ kind: 'partial', b64: 'AA==' })
    expect(parseImageEvent('data: {"type":"image_edit.completed","b64_json":"AQ=="}')).toEqual({
      kind: 'image',
      b64: 'AQ==',
    })
    expect(parseImageEvent('event: error\ndata: {"error":{"message":"额度不足"}}')).toEqual({
      kind: 'error',
      message: '额度不足',
    })
    expect(parseImageEvent('data: [DONE]')).toBeNull()
    expect(parseImageEvent(': keepalive')).toBeNull()
  })
})

const sse = (chunks: string[]): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk))
        c.close()
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream', 'X-Client-Request-ID': 'charge-1' } },
  )

describe('runCloudImage', () => {
  it('先放运行中的，预览换上，成图收齐后放完成的；事件切在两块里也能拼好', async () => {
    const items: Item[] = []
    const ev = (type: string) => `data: {"type":"${type}","b64_json":"${PNG}"}\n\n`
    const all =
      ev('image_generation.partial_image') + ev('image_generation.completed') + ev('image_generation.completed')
    const sent: RequestInit[] = []
    const r = await runCloudImage('it1', 'pixelsky-x', req(), {
      fetch: async (_p, init) => {
        sent.push(init)
        return sse([all.slice(0, 50), all.slice(50)])
      },
      put: item => items.push(item),
      signal: new AbortController().signal,
    })
    expect(r.chargeId).toBe('charge-1')
    expect(r.images).toHaveLength(2)
    expect(new Headers(sent[0].headers).get('X-PixelSky-Group')).toBe('41')
    expect(items[0]).toMatchObject({ id: 'it1', name: 'cloudImage', status: 'running', title: '夜空' })
    expect(items.at(-1)).toMatchObject({ status: 'completed', output: '生图分组 · 1024x1024 · 2 张' })
    const last = items.at(-1)!
    expect(last.kind === 'tool' && last.images?.map(i => i.id)).toEqual(['it1-img0', 'it1-img1'])
    // 回归（审查）：条目每更新一次就把全部图片再写一遍会话文件，只在开始、第一张预览、收齐时放
    expect(items.map(i => (i.kind === 'tool' ? `${i.status}:${i.images?.length ?? 0}` : ''))).toEqual([
      'running:0',
      'running:1',
      'completed:2',
    ])
  })

  it('云端拒绝：放失败的，带上原因', async () => {
    const items: Item[] = []
    await expect(
      runCloudImage('it2', 'pixelsky-x', req(), {
        fetch: async () => new Response(JSON.stringify({ error: { message: '分组不支持生图' } }), { status: 403 }),
        put: item => items.push(item),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('分组不支持生图')
    expect(items.at(-1)).toMatchObject({ status: 'failed', output: expect.stringContaining('分组不支持生图') })
  })

  it('停止：放中断的，写明可能照常扣费', async () => {
    const items: Item[] = []
    const abort = new AbortController()
    await expect(
      runCloudImage('it3', 'pixelsky-x', req(), {
        fetch: async () => {
          abort.abort()
          throw new Error('aborted')
        },
        put: item => items.push(item),
        signal: abort.signal,
      }),
    ).rejects.toThrow()
    expect(items.at(-1)).toMatchObject({ status: 'interrupted', output: expect.stringContaining('照常扣费') })
  })

  it('收到的图交给 fit 整理（补宽高、超限转小）；fit 丢掉的不算', async () => {
    const items: Item[] = []
    const ev = (type: string) => `data: {"type":"${type}","b64_json":"${PNG}"}\n\n`
    let n = 0
    const r = await runCloudImage('it5', 'pixelsky-x', req(), {
      fetch: async () => sse([ev('image_generation.completed') + ev('image_generation.completed')]),
      put: item => items.push(item),
      signal: new AbortController().signal,
      fit: image => (n++ === 0 ? { ...image, width: 1, height: 1 } : null),
    })
    expect(r.images).toHaveLength(1)
    expect(r.images[0]).toMatchObject({ id: 'it5-img0', width: 1, height: 1 })
  })

  it('流里一张图都没有：算失败', async () => {
    const items: Item[] = []
    await expect(
      runCloudImage('it4', 'pixelsky-x', req(), {
        fetch: async () => sse(['data: {"type":"image_generation.completed"}\n\n']),
        put: item => items.push(item),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('没有返回图片')
    expect(items.at(-1)).toMatchObject({ status: 'failed' })
  })
})
