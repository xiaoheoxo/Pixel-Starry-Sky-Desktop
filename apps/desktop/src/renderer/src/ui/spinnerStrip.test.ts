import { describe, expect, it } from 'vitest'
import { STRIP_FRAMES, frame, sample, splitAlpha, stripMask, stripRules } from './spinnerStrip'

// 原来的画法：方块透明度 a 里盖一层透明度 b 的领头，整体跟着 a 变淡；在底色 bg 上叠出来的颜色（单通道）
const original = (a: number, b: number, gray: number, lead: number, bg: number) =>
  a * (b * lead + (1 - b) * gray) + (1 - a) * bg
// 帧条：灰色层 g、领头层 l 依次盖在底色上
const layered = (g: number, l: number, gray: number, lead: number, bg: number) =>
  l * lead + (1 - l) * (g * gray + (1 - g) * bg)

describe('运行中图标的帧条', () => {
  it('拆成灰色、领头两层后，叠出来和原来一样（任意颜色、底色）', () => {
    for (const a of [0.18, 0.28, 0.5, 0.78, 1])
      for (const b of [0, 0.2, 0.35, 0.6, 1]) {
        const [g, l] = splitAlpha(a, b)
        for (const [gray, lead, bg] of [
          [0.47, 0.85, 1],
          [0.6, 0.94, 0.14],
          [0, 1, 0.5],
        ])
          expect(layered(g, l, gray, lead, bg)).toBeCloseTo(original(a, b, gray, lead, bg), 9)
      }
  })

  it('mono（领头也用文字色）叠出来正好是只有灰色方块、透明度 a 的样子', () => {
    for (const a of [0.18, 0.5, 1])
      for (const b of [0, 0.6, 1]) {
        const [g, l] = splitAlpha(a, b)
        expect(layered(g, l, 0.47, 0.47, 1)).toBeCloseTo(a * 0.47 + (1 - a), 9)
      }
  })

  it('照原来的关键帧取值：省电档每段跳 3 步，流畅档线性', () => {
    const flow: [number, number][] = [
      [0, 1],
      [0.1, 0.78],
      [0.25, 0.5],
    ]
    expect(sample(flow, 0, true)).toBe(1)
    expect(sample(flow, 0.05, true)).toBeCloseTo(1 - 0.22 / 3, 9) // 第 2 步
    expect(sample(flow, 0.05, false)).toBeCloseTo(0.89, 9)
    expect(sample(flow, 1.05, false)).toBeCloseTo(0.89, 9) // 超过一圈接着转
  })

  it('第一帧左上是领头；最后一帧是动画关时停的那一拍', () => {
    const [tl] = frame(0, STRIP_FRAMES.save, true)
    expect(tl[1]).toBeGreaterThan(0.9)
    const still = frame(STRIP_FRAMES.save, STRIP_FRAMES.save, true)
    expect(still.map(([g, l]) => [+g.toFixed(3), +l.toFixed(3)])).toEqual([
      [0, 1],
      [0.18, 0],
      [0.55, 0],
      [0.18, 0],
    ])
  })

  it('亮度顺时针流：每过 1/4 圈，左上的样子挪到右上', () => {
    const n = 100
    for (const k of [0, 13, 40]) {
      const [g, l] = frame(k + n / 4, n, false)[1]
      expect(g).toBeCloseTo(frame(k, n, false)[0][0], 9)
      expect(l).toBeCloseTo(frame(k, n, false)[0][1], 9)
    }
  })

  it('遮罩是 n + 1 帧横排的 SVG，方格按边长排、间隔 1px，帧与帧之间空 2px', () => {
    const mask = decodeURIComponent(stripMask(5, 48, true, 'lead'))
    expect(mask).toContain('width="637" height="11"') // 49 帧 × (11 + 2)px
    expect(mask).toContain('<rect x="0" y="0" width="5" height="5" rx="1" fill-opacity="1.000"/>')
    // 最后一帧只有左上的领头
    expect(mask).toContain('<rect x="624" y="0"')
    expect(mask).not.toContain('x="630" y="0"')
    // 第二帧从 13px 起，前一帧的方格到 11px 为止
    expect(mask).toMatch(/<rect x="13" y="0"/)
  })

  it('两档各一套规则，流畅档挂在 data-perf=smooth 下', () => {
    const css = stripRules(4)
    expect(css.match(/\.pixel-spinner\[data-cell='4'\]/g)).toHaveLength(2)
    expect(css).toContain(":root[data-perf='smooth'] .pixel-spinner[data-cell='4']")
    expect(css).toContain('--pixel-gray:url(')
    expect(css).toContain('--pixel-lead:url(')
  })
})
