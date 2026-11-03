import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { Markdown } from './Markdown'
import { describeSvgParseError, prepareSvg } from './svg'

const html = (text: string, streaming = false): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <Markdown text={text} streaming={streaming} />
    </I18nProvider>,
  )

describe('prepareSvg', () => {
  const root = (svg: string | null): string => /<svg\b[^>]*>/.exec(svg ?? '')?.[0] ?? ''
  it('没写 xmlns 的补上；只有 viewBox 的补上宽高；已有宽高不动', () => {
    const tag = root(prepareSvg('<svg viewBox="0 0 120 60"><rect/></svg>'))
    expect(tag).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(tag).toContain('width="120"')
    expect(tag).toContain('height="60"')
    const sized = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'
    expect(prepareSvg(sized)).toBe(sized)
  })
  it('审查补的：根上的 style 留着；单引号 viewBox；只有宽没有高时补高', () => {
    const tag = root(prepareSvg(`<svg viewBox='0,0,10.5,20' width="30" style="background:#fff">x</svg>`))
    expect(tag).toContain('style="background:#fff"')
    expect(tag).toContain('width="30"')
    expect(tag).toContain('height="20"')
    expect(tag).not.toContain('width="11"')
  })
  it('前面可以有 <?xml?>、注释（注释里带 <svg 也行）、DOCTYPE；别的东西开头、或根本没有 <svg> 的不认', () => {
    expect(prepareSvg('<?xml version="1.0"?>\n<!-- logo -->\n<svg width="1" height="1"></svg>')).toContain('xmlns=')
    expect(prepareSvg('<!-- old <svg> -->\n<svg width="1" height="1"></svg>')).toMatch(
      /^<!-- old <svg> -->\n<svg xmlns=/,
    )
    expect(prepareSvg('<!DOCTYPE svg [<!ENTITY a "b">]>\n<svg width="1" height="1"></svg>')).toContain('xmlns=')
    expect(prepareSvg('<div><svg></svg></div>')).toBeNull()
    expect(prepareSvg('<svgfoo></svgfoo>')).toBeNull()
    expect(prepareSvg('hello')).toBeNull()
  })
})

describe('describeSvgParseError', () => {
  it('Chromium 的报错取出行号和原因', () => {
    expect(
      describeSvgParseError(
        'This page contains the following errors:error on line 3 at column 1: Opening and ending tag mismatch: circle line 2 and svg\nBelow is a rendering of the page up to the first error.',
      ),
    ).toEqual({ line: 3, reason: 'Opening and ending tag mismatch: circle line 2 and svg' })
    expect(describeSvgParseError('something else')).toEqual({ line: null, reason: 'something else' })
  })
})

describe('Markdown 里的 ```svg', () => {
  const text = '```svg\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>\n```'
  it('写完了画成图（<img> + data URL，不把 SVG 插进页面），带图 / 源码切换', () => {
    const out = html(text)
    expect(out).toContain('src="data:image/svg+xml;charset=utf-8,')
    expect(out).not.toContain('<circle')
    expect(out).toContain('源码')
  })
  it('还在输出时只显示源码', () => {
    expect(html(text, true)).not.toContain('data:image/svg+xml')
  })
  it('不是 SVG 的内容：提示并显示源码', () => {
    const out = html('```svg\nnot svg at all\n```')
    expect(out).toContain('SVG 画不出来')
    expect(out).not.toContain('data:image/svg+xml')
  })
})
