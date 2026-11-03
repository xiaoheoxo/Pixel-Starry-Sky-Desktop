import { describe, expect, it } from 'vitest'
import { checkSvg, contrastRatio, parseHexColor, parseJsonc, satisfiesEngine } from './text'

describe('parseJsonc', () => {
  it('去掉行注释、块注释和结尾逗号', () => {
    const v = parseJsonc('{\n // 注释\n "a": 1, /* 块 */ "b": [1, 2,],\n}')
    expect(v).toEqual({ a: 1, b: [1, 2] })
  })
  it('字符串里的 // 和 /* 不是注释，网址不被破坏', () => {
    expect(parseJsonc('{"u": "https://x.com/a//b", "c": "/* no */"}')).toEqual({
      u: 'https://x.com/a//b',
      c: '/* no */',
    })
  })
  it('字符串里的转义引号和逗号括号不受影响', () => {
    expect(parseJsonc('{"a": "x\\",]"}')).toEqual({ a: 'x",]' })
    expect(parseJsonc('{"a": "1,"}')).toEqual({ a: '1,' })
  })
  it('去掉 BOM', () => {
    expect(parseJsonc('﻿{"a":1}')).toEqual({ a: 1 })
  })
  it('注释后面跟着逗号再换行的结尾逗号', () => {
    expect(parseJsonc('[1, // x\n 2, // y\n]')).toEqual([1, 2])
  })
  it('坏 JSON 抛 SyntaxError，块注释没结束带行号', () => {
    expect(() => parseJsonc('{"a": }')).toThrow(SyntaxError)
    expect(() => parseJsonc('{\n/* x')).toThrow(/第 2 行/)
  })
})

describe('checkSvg', () => {
  const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`
  it('普通 SVG 通过，# 内部引用和 url(#id) 通过', () => {
    expect(
      checkSvg(svg('<defs><linearGradient id="g"/></defs><path fill="url(#g)" d="M0 0h16v16z"/><use href="#g"/>')),
    ).toBeNull()
    expect(checkSvg(svg('<path style="fill:url(\'#g\')" d="M0 0"/>'))).toBeNull()
  })
  it.each([
    ['<script>', svg('<script>alert(1)</script>')],
    ['<foreignObject>', svg('<foreignObject><div/></foreignObject>')],
    ['事件属性', svg('<path onclick="x()" d="M0 0"/>')],
    ['事件属性（斜杠）', '<svg/onload=alert(1)>'],
    ['外部 href', svg('<image href="https://e.com/a.png"/>')],
    ['xlink:href', svg('<use xlink:href="a.svg#x"/>')],
    ['javascript href', svg("<a href='javascript:x'><path/></a>")],
    ['外部 url()', svg('<path fill="url(https://e.com/x)"/>')],
    ['实体', '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'],
    ['大小写混写', svg('<SCRIPT>1</SCRIPT>')],
    ['带前缀的 script', svg('<svg:script>alert(1)</svg:script>')],
    ['set 改事件属性', svg('<set attributeName="onload" to="alert(1)"/>')],
    ['animate 改 href', svg('<a><animate attributeName="href" values="javascript:alert(1)"/></a>')],
  ])('拒绝 %s', (_n, text) => {
    expect(checkSvg(text)).not.toBeNull()
  })
  it('抽样的真实 Material 图标都通过（目录在才测）', async () => {
    // @ts-expect-error 协议包没有 node 类型，只在测试里读文件
    const fs = await import('node:fs')
    // @ts-expect-error 协议包没有 node 类型
    const path = await import('node:path')
    // @ts-expect-error 协议包没有 node 类型
    const dir = path.resolve(process.cwd(), '../../extensions/official/material-icons')
    if (!fs.existsSync(dir)) return
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (files.length >= 20) return
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.svg')) files.push(p)
      }
    }
    walk(dir)
    for (const f of files) expect(checkSvg(fs.readFileSync(f, 'utf8')), f).toBeNull()
  })
})

describe('satisfiesEngine 不支持的写法', () => {
  it('区间 a - b 返回 null（不是 false）', () => {
    expect(satisfiesEngine('0.4.0 - 0.5.0', '0.4.1')).toBeNull()
  })
})

describe('satisfiesEngine', () => {
  it.each([
    ['>=0.4.0', '0.4.0', true],
    ['>=0.4.0', '0.3.14', false],
    ['>0.4.0', '0.4.0', false],
    ['<=0.4.0', '0.4.0', true],
    ['<0.4.0', '0.4.0', false],
    ['=0.4.0', '0.4.0', true],
    ['0.4.0', '0.4.1', false],
    ['^0.4.0', '0.4.9', true],
    ['^0.4.0', '0.5.0', false],
    ['^1.2.3', '1.9.0', true],
    ['^1.2.3', '2.0.0', false],
    ['^0.0.3', '0.0.4', false],
    ['~1.2.3', '1.2.9', true],
    ['~1.2.3', '1.3.0', false],
    ['*', '9.9.9', true],
    ['x', '0.0.1', true],
    ['1.x', '1.7.0', true],
    ['1.x', '2.0.0', false],
    ['1.2', '1.2.5', true],
    ['1.2', '1.3.0', false],
    ['>=0.4.0 <1.0.0', '0.9.0', true],
    ['>=0.4.0 <1.0.0', '1.0.0', false],
    ['>= 0.4.0', '0.4.0', true],
    ['>1.2', '1.2.9', false],
    ['>1.2', '1.3.0', true],
    ['<=1.2', '1.2.9', true],
    ['>=0.4.0', '0.5.0-beta.1', true],
    ['>=0.4.0-beta.1', '0.4.0', true],
  ] as const)('%s vs %s = %s', (range, version, expected) => {
    expect(satisfiesEngine(range, version)).toBe(expected)
  })
  it.each(['', 'latest', '>=abc', '1.2.3 || 2.0.0', '>=1.2.3.4', '~'])('无法解析 %j 返回 null', range => {
    expect(satisfiesEngine(range, '1.0.0')).toBeNull()
  })
  it('版本号本身解析不了也是 null', () => {
    expect(satisfiesEngine('>=1.0.0', 'dev')).toBeNull()
  })
})

describe('颜色', () => {
  it('parseHexColor 四种写法', () => {
    expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseHexColor('#f008')).toEqual({ r: 255, g: 0, b: 0, a: 0x88 / 255 })
    expect(parseHexColor('#1a1b26')).toEqual({ r: 26, g: 27, b: 38, a: 1 })
    expect(parseHexColor('#1a1b2680')?.a).toBeCloseTo(0.502, 2)
  })
  it.each(['', 'fff', '#ff', '#ggg', '#12345', 'red', '#1234567'])('拒绝 %j', v => {
    expect(parseHexColor(v)).toBeNull()
  })
  it('contrastRatio：黑白 21，同色 1，写法错 null', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    expect(contrastRatio('red', '#fff')).toBeNull()
  })
  it('带透明度的前景先叠到背景上', () => {
    expect(contrastRatio('#00000000', '#ffffff')).toBeCloseTo(1, 5)
  })
})
