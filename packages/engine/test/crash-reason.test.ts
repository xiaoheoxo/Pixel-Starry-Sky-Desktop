// 引擎进程崩溃时给用户看的原因：只要「Error: …」那句，不要 Node 印出来的压缩源码和调用栈
import { describe, expect, it } from 'vitest'
import { crashReason, startupReason } from '../src/exec'

const minified =
  'Path}/`:relPath;if(ig.ignores(ignorePath))continue;' + 'let x=loadSkillFromFile(fullPath,source);'.repeat(80)
const STALE =
  'Error: This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().'
// 用户日志里的样子：TailBuffer 截掉了开头，压缩源码行、空白的 ^ 标记行、报错、调用栈、Node 版本
const nodeCrash = [
  minified,
  ' '.repeat(400) + '^',
  '',
  STALE,
  '    at Object.assertActive (file:///E:/Program/PixelSky/resources/pixel-cli/pixel.mjs:1537:7874)',
  '    at Timeout._onTimeout (file:///E:/Program/PixelSky/resources/pixel-cli/pixel.mjs:2359:2699)',
  '    at listOnTimeout (node:internal/timers:685:17)',
  '',
  'Node.js v24.21.0',
].join('\r\n')

describe('crashReason', () => {
  it('Node 未捕获的异常：只留报错那句，去掉压缩源码、^ 标记和调用栈', () => {
    expect(crashReason(nodeCrash)).toBe(STALE)
  })

  it('报错带说明行时一起带上，到调用栈为止；带颜色的去掉颜色', () => {
    const text = '\x1b[31mTypeError [ERR_INVALID_ARG]: bad value\x1b[0m\n  received: 42\n    at foo (a.js:1:1)'
    expect(crashReason(text)).toBe('TypeError [ERR_INVALID_ARG]: bad value\nreceived: 42')
  })

  it('认不出报错行：去掉超长的源码行和调用栈，取最后几行', () => {
    expect(crashReason([minified, 'fatal: something broke', '    at x (y.js:1:1)'].join('\n'))).toBe(
      'fatal: something broke',
    )
    expect(crashReason(minified)).toBe('')
  })

  it('超长的报错行截断', () => {
    const long = 'Error: ' + 'x'.repeat(2000)
    const out = crashReason(long)
    expect(out.length).toBeLessThan(510)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('startupReason', () => {
  it('启动时就崩（Node 报错格式）：和 crashReason 一样只取报错那句', () => {
    expect(startupReason(nodeCrash)).toBe(STALE)
  })

  it('普通的启动失败（不认识的参数）照旧取开头两行', () => {
    expect(startupReason('error: unknown option --foo\nUsage: pixel [options]\nmore')).toBe(
      'error: unknown option --foo\nUsage: pixel [options]',
    )
  })
})
