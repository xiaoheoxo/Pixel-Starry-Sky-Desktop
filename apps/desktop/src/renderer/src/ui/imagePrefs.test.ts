import { describe, expect, it } from 'vitest'
import { DEFAULT_IMAGE_PREFS, nextBackground, parseImagePrefs } from './imagePrefs'
import { pixelColor } from './ImageStage'
import { imageFormat } from '../features/editor/ImagePreview'

describe('看图的开关', () => {
  it('读存下的值：坏的、缺的字段用默认值', () => {
    expect(parseImagePrefs(null)).toEqual(DEFAULT_IMAGE_PREFS)
    expect(parseImagePrefs('不是 JSON')).toEqual(DEFAULT_IMAGE_PREFS)
    expect(parseImagePrefs('{"background":"inverse","pixelated":false}')).toEqual({
      background: 'inverse',
      pixelated: false,
      grid: true,
    })
    expect(parseImagePrefs('{"background":"pink","grid":"yes"}')).toEqual(DEFAULT_IMAGE_PREFS)
  })
  it('背景轮换：棋盘格 → 纯色 → 反色 → 棋盘格', () => {
    expect(nextBackground('checker')).toBe('plain')
    expect(nextBackground('plain')).toBe('inverse')
    expect(nextBackground('inverse')).toBe('checker')
  })
})

describe('底栏', () => {
  it('像素颜色：不透明是 #RRGGBB，半透明是 rgba，全透明是 null', () => {
    expect(pixelColor(240, 167, 100, 255)).toBe('#F0A764')
    expect(pixelColor(0, 0, 0, 128)).toBe('rgba(0, 0, 0, 0.50)')
    expect(pixelColor(1, 2, 3, 0)).toBeNull()
  })
  it('格式取自 data URL 的类型', () => {
    expect(imageFormat('data:image/png;base64,AAA')).toBe('PNG')
    expect(imageFormat('data:image/svg+xml;base64,AAA')).toBe('SVG')
    expect(imageFormat('data:image/x-icon;base64,AAA')).toBe('ICO')
    expect(imageFormat('data:image/jpeg;base64,AAA')).toBe('JPEG')
  })
})
