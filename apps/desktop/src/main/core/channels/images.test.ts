// 生成的图放进频道（docs/ui/channel-image-gen.md）
import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_BYTES, MAX_IMAGE_COUNT, type ImageAttachment } from '@pixelsky/protocol'
import { fitForChannel } from './images'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const img = (id: string, bytes = 70, width = 1): ImageAttachment => ({
  id,
  name: `${id}.png`,
  mediaType: 'image/png',
  bytes,
  width,
  height: width,
  dataBase64: PNG,
})

describe('fitForChannel', () => {
  it('放得下的原样收；张数超了的算丢掉', () => {
    const list = Array.from({ length: MAX_IMAGE_COUNT + 1 }, (_, i) => img(`a${i}`))
    const r = fitForChannel(list)
    expect(r.images).toHaveLength(MAX_IMAGE_COUNT)
    expect(r.dropped).toBe(1)
  })

  it('没有 fit：宽高不知道的、太大的不收', () => {
    expect(fitForChannel([img('w', 70, 0), img('big', MAX_IMAGE_BYTES + 1)])).toEqual({ images: [], dropped: 2 })
  })

  it('回归（审查）：fit 解不开的图（宽高还是 0）只丢它自己，别的照放', () => {
    const r = fitForChannel([img('webp', 70, 0), img('ok')], image => image)
    expect(r.images.map(i => i.id)).toEqual(['ok'])
    expect(r.dropped).toBe(1)
  })

  it('有 fit：每张给的上限是单张上限和剩余总量里小的那个；fit 返回 null 的丢掉', () => {
    const asked: number[] = []
    const r = fitForChannel([img('a'), img('b'), img('c')], (image, max) => {
      asked.push(max)
      return image.id === 'b' ? null : { ...image, width: 2, height: 2 }
    })
    expect(asked[0]).toBe(MAX_IMAGE_BYTES)
    expect(r.images.map(i => [i.id, i.width])).toEqual([
      ['a', 2],
      ['c', 2],
    ])
    expect(r.dropped).toBe(1)
  })
})
