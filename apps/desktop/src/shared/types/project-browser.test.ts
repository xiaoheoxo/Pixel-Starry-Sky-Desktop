import { describe, expect, it } from 'vitest'
import { CUSTOM_SIZE, browserShortcut, cleanPreview, deviceSize, fitDevice } from './project-browser'

const k = (key: string, mods: Partial<{ mod: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key,
  mod: false,
  shift: false,
  alt: false,
  ...mods,
})

describe('浏览器快捷键', () => {
  it('Windows / Linux', () => {
    expect(browserShortcut(k('l', { mod: true }), false)).toBe('address')
    expect(browserShortcut(k('L', { mod: true }), false)).toBe('address')
    expect(browserShortcut(k('F6'), false)).toBe('address')
    expect(browserShortcut(k('r', { mod: true }), false)).toBe('reload')
    expect(browserShortcut(k('F5'), false)).toBe('reload')
    expect(browserShortcut(k('R', { mod: true, shift: true }), false)).toBe('hardReload')
    expect(browserShortcut(k('t', { mod: true }), false)).toBe('newPage')
    expect(browserShortcut(k('w', { mod: true }), false)).toBe('closePage')
    expect(browserShortcut(k('ArrowLeft', { alt: true }), false)).toBe('back')
    expect(browserShortcut(k('ArrowRight', { alt: true }), false)).toBe('forward')
  })
  it('macOS：⌘[ ⌘] 前进后退，⌥← 留给网页（按词移动）', () => {
    expect(browserShortcut(k('[', { mod: true }), true)).toBe('back')
    expect(browserShortcut(k(']', { mod: true }), true)).toBe('forward')
    expect(browserShortcut(k('ArrowLeft', { alt: true }), true)).toBeNull()
  })
  it('第二批：查找、缩放、开发者工具', () => {
    expect(browserShortcut(k('f', { mod: true }), false)).toBe('find')
    expect(browserShortcut(k('=', { mod: true }), false)).toBe('zoomIn')
    expect(browserShortcut(k('+', { mod: true, shift: true }), false)).toBe('zoomIn')
    expect(browserShortcut(k('-', { mod: true }), false)).toBe('zoomOut')
    expect(browserShortcut(k('0', { mod: true }), false)).toBe('zoomReset')
    expect(browserShortcut(k('F12'), false)).toBe('devtools')
    expect(browserShortcut({ ...k('ˆ', { mod: true, alt: true }), code: 'KeyI' }, true)).toBe('devtools')
    expect(browserShortcut(k('F', { mod: true, shift: true }), false)).toBeNull()
  })
  it('其余按键交给网页', () => {
    expect(browserShortcut(k('l'), false)).toBeNull()
    expect(browserShortcut(k('c', { mod: true }), false)).toBeNull()
    expect(browserShortcut(k('w', { mod: true, shift: true }), false)).toBeNull()
    expect(browserShortcut(k('ArrowLeft', { alt: true, mod: true }), false)).toBeNull()
    expect(browserShortcut(k('F5', { shift: true }), false)).toBeNull()
  })
})

describe('设备尺寸（docs/ui/browser-v2.md §3.3）', () => {
  it('自适应 + 跟随系统不用存；坏字段用默认值', () => {
    expect(cleanPreview(null)).toBeNull()
    expect(cleanPreview({ device: 'responsive', theme: 'system' })).toBeNull()
    expect(cleanPreview({ device: 'watch' })).toBeNull()
    expect(cleanPreview({ device: 'phone', landscape: true, theme: 'dark' })).toEqual({
      device: 'phone',
      landscape: true,
      theme: 'dark',
    })
    // 自适应没有横竖；只有自定义带宽高
    expect(cleanPreview({ device: 'responsive', landscape: true, theme: 'light', width: 300 })).toEqual({
      device: 'responsive',
      theme: 'light',
    })
    expect(cleanPreview({ device: 'custom', width: 99999, height: 'x' })).toEqual({
      device: 'custom',
      width: CUSTOM_SIZE.max,
      height: CUSTOM_SIZE.height,
    })
  })
  it('设备的 CSS 尺寸：横着对调，自定义算桌面', () => {
    expect(deviceSize(undefined)).toBeNull()
    expect(deviceSize({ device: 'responsive' })).toBeNull()
    expect(deviceSize({ device: 'phone' })).toEqual({ width: 390, height: 844, kind: 'phone' })
    expect(deviceSize({ device: 'tablet', landscape: true })).toEqual({ width: 1180, height: 820, kind: 'tablet' })
    expect(deviceSize({ device: 'custom', width: 500, height: 600 })).toEqual({
      width: 500,
      height: 600,
      kind: 'desktop',
    })
  })
  it('设备框放进网页区：只缩小不放大、居中', () => {
    // 放得下：原尺寸居中
    expect(fitDevice({ x: 0, y: 100, width: 600, height: 1000 }, { width: 390, height: 844 })).toEqual({
      x: 105,
      y: 178,
      width: 390,
      height: 844,
      scale: 1,
    })
    // 高不够：按高缩小
    const fit = fitDevice({ x: 10, y: 0, width: 600, height: 422 }, { width: 390, height: 844 })
    expect(fit.scale).toBe(0.5)
    expect(fit).toMatchObject({ width: 195, height: 422, x: 213, y: 0 })
  })
})
