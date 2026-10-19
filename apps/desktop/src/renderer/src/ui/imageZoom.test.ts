import { describe, expect, it } from 'vitest'
import { clampPan, fitScale, fitView, MAX_SCALE, MIN_SCALE, pixelAt, stepScale, wheelFactor, zoomAt } from './imageZoom'

const viewport = { width: 800, height: 600 }

describe('看图缩放', () => {
  it('适应窗口：大图等比缩小；小图放大到占约一半的整数倍，本来合适的按原始大小', () => {
    expect(fitScale({ width: 1600, height: 600 }, viewport)).toBe(0.5)
    expect(fitScale({ width: 400, height: 1200 }, viewport)).toBe(0.5)
    expect(fitScale({ width: 300, height: 200 }, viewport)).toBe(1)
    expect(fitScale({ width: 200, height: 100 }, viewport)).toBe(2)
    // 16×16：一半是 400×300 → 18 倍
    expect(fitScale({ width: 16, height: 16 }, viewport)).toBe(18)
    expect(fitScale({ width: 1, height: 1 }, viewport)).toBe(MAX_SCALE)
    expect(fitScale({ width: 0, height: 0 }, viewport)).toBe(1)
    expect(fitView({ width: 1600, height: 1200 }, viewport)).toEqual({ scale: 0.5, x: 0, y: 0 })
  })

  it('以鼠标点为中心缩放：那个点在图上的位置不变', () => {
    const image = { width: 2000, height: 2000 }
    const before = { scale: 1, x: 0, y: 0 }
    const point = { x: 100, y: -50 }
    const after = zoomAt(before, 2, point, image, viewport)
    // 屏幕上的点 → 图上的坐标：(point - offset) / scale
    expect((point.x - after.x) / after.scale).toBeCloseTo((point.x - before.x) / before.scale)
    expect((point.y - after.y) / after.scale).toBeCloseTo((point.y - before.y) / before.scale)
  })

  it('档位：按档跳，不在档上的跳到相邻的档，两头停住', () => {
    expect(stepScale(1, 1)).toBe(1.5)
    expect(stepScale(1, -1)).toBe(0.75)
    expect(stepScale(14, 1)).toBe(16)
    expect(stepScale(14, -1)).toBe(12)
    expect(stepScale(MAX_SCALE, 1)).toBe(MAX_SCALE)
    expect(stepScale(MIN_SCALE, -1)).toBe(MIN_SCALE)
  })

  it('鼠标下的像素：以视口中心为原点换算，图外是 null', () => {
    const image = { width: 16, height: 16 }
    const view = { scale: 10, x: 0, y: 0 }
    expect(pixelAt(view, { x: 0, y: 0 }, image)).toEqual({ x: 8, y: 8 })
    expect(pixelAt(view, { x: -80, y: -80 }, image)).toEqual({ x: 0, y: 0 })
    expect(pixelAt(view, { x: 79.9, y: -1 }, image)).toEqual({ x: 15, y: 7 })
    expect(pixelAt(view, { x: 80, y: 0 }, image)).toBeNull()
    expect(pixelAt({ scale: 10, x: 50, y: 0 }, { x: 0, y: 0 }, image)).toEqual({ x: 3, y: 8 })
  })

  it('缩放范围 10%–3200%', () => {
    const image = { width: 100, height: 100 }
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 100, { x: 0, y: 0 }, image, viewport).scale).toBe(MAX_SCALE)
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0.001, { x: 0, y: 0 }, image, viewport).scale).toBe(MIN_SCALE)
  })

  it('平移：图比视口小的方向居中，大的方向边不进视口', () => {
    const image = { width: 1000, height: 300 }
    // 宽 1000 > 800：最多偏 100；高 300 < 600：居中
    expect(clampPan({ scale: 1, x: 500, y: 200 }, image, viewport)).toEqual({ scale: 1, x: 100, y: 0 })
    expect(clampPan({ scale: 1, x: -500, y: 0 }, image, viewport)).toEqual({ scale: 1, x: -100, y: 0 })
  })

  it('滚轮：向上放大、向下缩小，单次幅度有上限', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1)
    expect(wheelFactor(100)).toBeLessThan(1)
    expect(wheelFactor(-10000)).toBe(wheelFactor(-100))
  })
})
