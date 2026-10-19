import { describe, expect, it } from 'vitest'
import { colorAlpha, isModalOverlay, overlayHidesBrowser, type OverlayCandidate } from './browserOverlay'

const placeholder = { x: 800, y: 100, width: 400, height: 600 }
const popover = (x: number, y: number, width = 200, height = 150, modal = false): OverlayCandidate => ({
  rect: { x, y, width, height },
  modal,
})

describe('overlayHidesBrowser', () => {
  it('没有弹出层不藏', () => {
    expect(overlayHidesBrowser(placeholder, [])).toBe(false)
  })
  it('不重叠不藏', () => {
    expect(overlayHidesBrowser(placeholder, [popover(500, 600)])).toBe(false)
  })
  it('重叠就藏', () => {
    expect(overlayHidesBrowser(placeholder, [popover(700, 600)])).toBe(true)
  })
  it('余量内算重叠，余量外不算', () => {
    expect(overlayHidesBrowser(placeholder, [popover(598, 300)])).toBe(true)
    expect(overlayHidesBrowser(placeholder, [popover(590, 300)])).toBe(false)
  })
  it('模态一律藏，哪怕不重叠', () => {
    expect(overlayHidesBrowser(placeholder, [popover(0, 0, 100, 100, true)])).toBe(true)
  })
  it('零尺寸不算，模态也不算', () => {
    expect(overlayHidesBrowser(placeholder, [popover(900, 200, 0, 0)])).toBe(false)
    expect(overlayHidesBrowser(placeholder, [popover(900, 200, 0, 50, true)])).toBe(false)
  })
  it('多个里有一个重叠就藏', () => {
    expect(overlayHidesBrowser(placeholder, [popover(0, 0), popover(900, 200)])).toBe(true)
  })
})

describe('isModalOverlay', () => {
  const plain = { settings: false, fullScreen: false, backdrops: [] }
  const backdrop = (alpha: number, fullScreen = true, fixed = true) => ({ fixed, fullScreen, alpha })
  it('设置对话框、接近全屏的浮层算模态', () => {
    expect(isModalOverlay({ ...plain, settings: true })).toBe(true)
    expect(isModalOverlay({ ...plain, fullScreen: true })).toBe(true)
  })
  it('外面套着有颜色的全屏遮罩算模态（确认框、设置浮层）', () => {
    expect(isModalOverlay({ ...plain, backdrops: [backdrop(0.38)] })).toBe(true)
  })
  it('透明的全屏点击层不算（命令中心），不铺满、不是 fixed 的也不算', () => {
    expect(isModalOverlay({ ...plain, backdrops: [backdrop(0)] })).toBe(false)
    expect(isModalOverlay({ ...plain, backdrops: [backdrop(0.5, false)] })).toBe(false)
    expect(isModalOverlay({ ...plain, backdrops: [backdrop(0.5, true, false)] })).toBe(false)
    expect(isModalOverlay(plain)).toBe(false)
  })
})

describe('colorAlpha', () => {
  it('认得各种写法', () => {
    expect(colorAlpha('transparent')).toBe(0)
    expect(colorAlpha('rgba(0, 0, 0, 0)')).toBe(0)
    expect(colorAlpha('rgba(20, 20, 18, 0.38)')).toBe(0.38)
    expect(colorAlpha('rgb(255, 255, 255)')).toBe(1)
    expect(colorAlpha('color(srgb 0.1 0.1 0.1 / 0.5)')).toBe(0.5)
    expect(colorAlpha('oklab(0.2 0 0 / 40%)')).toBe(0.4)
    expect(colorAlpha('')).toBe(0)
  })
})
