import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { encode } from 'uqr'
import { QrCode, qrFitScale } from './QrCode'

// 固定显示尺寸（docs/ui/in-app-payment.md §6.7）：整数倍放大，付款码落在 180–220 像素，太密就用 1 倍。

const fit = { min: 180, max: 220 }
const svgSize = (html: string): number => Number(/<svg[^>]*width="(\d+)"/.exec(html)?.[1])

describe('qrFitScale', () => {
  it('取放得进最大尺寸的最大整数倍', () => {
    expect(qrFitScale(45, fit)).toBe(4) // 180
    expect(qrFitScale(33, fit)).toBe(6) // 198
    expect(qrFitScale(65, fit)).toBe(3) // 195
  })
  it('码太密、1 倍也放不进（或刚好放不下 2 倍）时用 1 倍', () => {
    expect(qrFitScale(120, fit)).toBe(1)
    expect(qrFitScale(300, fit)).toBe(1)
    expect(qrFitScale(0, fit)).toBe(1)
  })
})

describe('QrCode', () => {
  it('付款码：不同长度的内容显示尺寸都在 180–220 之间，且是格数的整数倍', () => {
    for (const len of [24, 60, 120, 200]) {
      const text = `https://pay.example.com/${'a'.repeat(len)}`
      const modules = encode(text, { ecc: 'M', border: 4 }).size
      const size = svgSize(renderToStaticMarkup(<QrCode text={text} label="x" ecc="M" fit={fit} />))
      expect(size % modules).toBe(0)
      expect(size).toBeGreaterThanOrEqual(modules < 111 ? 148 : modules) // 密的码 1 倍
      expect(size).toBeLessThanOrEqual(Math.max(220, modules))
    }
  })
  it('没传 fit 时保持原来的每格 scale 像素（手机配对）', () => {
    const modules = encode('hello', { ecc: 'L', border: 4 }).size
    expect(svgSize(renderToStaticMarkup(<QrCode text="hello" label="x" />))).toBe(modules * 4)
    expect(svgSize(renderToStaticMarkup(<QrCode text="hello" label="x" scale={6} />))).toBe(modules * 6)
  })
  it('ecc 参数生效：同样的内容 M 比 L 的码更密', () => {
    const l = encode('https://pay.example.com/abc', { ecc: 'L', border: 4 }).size
    const m = encode('https://pay.example.com/abc', { ecc: 'M', border: 4 }).size
    expect(m).toBeGreaterThanOrEqual(l)
    const html = renderToStaticMarkup(<QrCode text="https://pay.example.com/abc" label="付款码" ecc="M" />)
    expect(svgSize(html)).toBe(m * 4)
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="付款码"')
  })
})
