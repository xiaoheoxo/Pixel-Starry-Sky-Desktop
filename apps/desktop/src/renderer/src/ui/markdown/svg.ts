// 回复里的 ```svg 代码块和项目里的 .svg 图片（docs/ui/svg-render-mockup.html）：
// 一律用 <img src="data:image/svg+xml,…"> 显示——浏览器不运行里面的脚本、不加载外部资源，不插进页面 DOM。
import { tr } from '@/i18n/core'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 根 <svg> 前面允许的：<?xml?>、注释、DOCTYPE（可带内部子集）、空白；连同根标签一起匹配，注释里的 <svg 不算 */
const ROOT = /^((?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>)*)(<svg\b[^>]*>)/i

/**
 * 交给 <img> 前的整理：根节点必须是 <svg>；没写 xmlns 的补上（AI 常省略，<img> 里没有它就画不出来）；
 * 宽、高缺哪个按 viewBox 补哪个（不然 <img> 里没有固有尺寸）。别的属性（含 style）原样留着。不是 SVG 返回 null
 */
export function prepareSvg(code: string): string | null {
  const text = code.trim()
  const m = ROOT.exec(text)
  if (!m) return null
  let tag = m[2]
  if (!/\sxmlns\s*=/.test(tag)) tag = tag.replace(/^<svg/i, `<svg xmlns="${SVG_NS}"`)
  const box = /\sviewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*["']/i.exec(tag)
  if (box) {
    if (!/\swidth\s*=/i.test(tag)) tag = tag.replace(/^<svg/i, `<svg width="${Math.ceil(+box[1])}"`)
    if (!/\sheight\s*=/i.test(tag)) tag = tag.replace(/^<svg/i, `<svg height="${Math.ceil(+box[2])}"`)
  }
  return m[1] + tag + text.slice(m[0].length)
}

/**
 * 浏览器 XML 解析器的报错（parsererror 元素的文字）→ 行号和原因。
 * Chromium 的写法：「This page contains the following errors:error on line 3 at column 1: Opening and ending tag mismatch…」
 */
export function describeSvgParseError(text: string): { line: number | null; reason: string } {
  const m = /line (\d+)(?: at column \d+)?:\s*([^\n]+?)(?:Below is a rendering.*)?$/s.exec(
    text.replace(/\s+/g, ' ').trim(),
  )
  if (m) return { line: Number(m[1]), reason: m[2].trim() }
  return { line: null, reason: text.replace(/\s+/g, ' ').trim().slice(0, 200) }
}

/** 用浏览器的 XML 解析器查一遍；没有 DOMParser（测试环境）当作没问题 */
export function svgParseError(svg: string): { line: number | null; reason: string } | null {
  if (typeof DOMParser === 'undefined') return null
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const err = doc.querySelector('parsererror')
  if (err) return describeSvgParseError(err.textContent ?? '')
  return doc.documentElement.localName === 'svg' ? null : { line: null, reason: tr('svg.notSvg') }
}

export type SvgBackdrop = 'check' | 'white' | 'black'

/**
 * 底色：棋盘格、白、黑。棋盘格深浅主题都用浅色（AI 画的图多半是黑线条，深色格子上看不见）；
 * 这些是给图片垫的底，不跟主题走，所以不用设计变量
 */
export const SVG_BACKDROP: Record<SvgBackdrop, string> = {
  check: 'bg-[conic-gradient(#e6e6e3_25%,#fff_0_50%,#e6e6e3_0_75%,#fff_0)] bg-[length:16px_16px]',
  white: 'bg-white',
  black: 'bg-black',
}
