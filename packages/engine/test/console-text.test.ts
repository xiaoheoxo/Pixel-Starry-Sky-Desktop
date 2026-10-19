import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  ConsoleLineDecoder,
  ConsoleStreamDecoder,
  codePageLabel,
  decodeConsoleText,
  detectOemCodePage,
  guessCodePage,
} from '../src/console-text'

// 「中文」的 GBK 编码
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4]
const win936 = { windows: true, codePage: 936 }

describe('decodeConsoleText', () => {
  it('合法 UTF-8 原样解出', () => {
    expect(decodeConsoleText(Buffer.from('中文 ok', 'utf8'), win936)).toBe('中文 ok')
  })

  it('去掉开头的 BOM', () => {
    expect(decodeConsoleText(Buffer.from('﻿hello', 'utf8'))).toBe('hello')
  })

  it('Windows 上不是 UTF-8 就按 OEM 代码页解（GBK）', () => {
    expect(decodeConsoleText(Uint8Array.from(GBK_ZHONGWEN), win936)).toBe('中文')
  })

  it('按指定的代码页解（Big5 的「中」是 a4 a4）', () => {
    expect(decodeConsoleText(Uint8Array.from([0xa4, 0xa4]), { windows: true, codePage: 950 })).toBe('中')
  })

  it('注册表查不到时按系统语言猜代码页', () => {
    expect(guessCodePage('zh-CN')).toBe(936)
    expect(guessCodePage('zh-TW')).toBe(950)
    expect(guessCodePage('zh-Hant-HK')).toBe(950)
    expect(guessCodePage('ja-JP')).toBe(932)
    expect(guessCodePage('ko')).toBe(949)
    expect(guessCodePage('en-US')).toBeNull()
  })

  it('基本是 UTF-8、只夹了个别坏字节：按宽松 UTF-8 解，中文不变乱码', () => {
    const line = Buffer.concat([Buffer.from('{"text":"你好世界"}', 'utf8'), Buffer.from([0xff, 0x0a])])
    expect(decodeConsoleText(line, win936)).toBe('{"text":"你好世界"}�\n')
  })

  it('结尾被切断的半个 UTF-8 字符：宽松 UTF-8，不解成假汉字', () => {
    expect(decodeConsoleText(Uint8Array.from([0x61, 0xe4, 0xb8]), win936)).toBe('a�')
    const d = new ConsoleStreamDecoder(win936)
    expect(d.write(Uint8Array.from([0x61, 0xe4, 0xb8]))).toBe('a')
    expect(d.end()).toBe('�')
  })

  it('一段输出里 UTF-8 行和 GBK 行混着：逐行各按各的解', () => {
    const bytes = Buffer.concat([Buffer.from('第一行\n', 'utf8'), Buffer.from([...GBK_ZHONGWEN, 0x0a])])
    expect(decodeConsoleText(bytes, win936)).toBe('第一行\n中文\n')
  })

  it('不认识的代码页退回宽松 UTF-8，不抛错', () => {
    const out = decodeConsoleText(Uint8Array.from(GBK_ZHONGWEN), { windows: true, codePage: 437 })
    expect(out).toContain('�')
    expect(codePageLabel(437)).toBeNull()
    expect(codePageLabel(936)).toBe('gb18030')
    expect(codePageLabel(1252)).toBe('windows-1252')
  })

  it('非 Windows 不尝试代码页', () => {
    expect(decodeConsoleText(Uint8Array.from(GBK_ZHONGWEN), { windows: false, codePage: 936 })).toContain('�')
  })
})

describe('ConsoleStreamDecoder', () => {
  it('UTF-8 多字节字符被块边界切开也不会坏', () => {
    const bytes = Buffer.from('a中文b', 'utf8')
    const d = new ConsoleStreamDecoder(win936)
    const out = d.write(bytes.subarray(0, 2)) + d.write(bytes.subarray(2, 5)) + d.write(bytes.subarray(5)) + d.end()
    expect(out).toBe('a中文b')
  })

  it('GBK 输出按行解，半行留到下一块', () => {
    const d = new ConsoleStreamDecoder(win936)
    const first = d.write(Buffer.from([...GBK_ZHONGWEN, 0x0a, 0xd6]))
    expect(first).toBe('中文\n')
    expect(d.write(Buffer.from([0xd0, 0x0a]))).toBe('中\n')
    expect(d.end()).toBe('')
  })

  it('结束时交出没有换行的最后半行，并只去一次 BOM', () => {
    const d = new ConsoleStreamDecoder(win936)
    expect(d.write(Buffer.from('﻿ab', 'utf8'))).toBe('ab')
    expect(d.write(Buffer.from('﻿', 'utf8'))).toBe('﻿')
    expect(d.write(Buffer.from(GBK_ZHONGWEN))).toBe('')
    expect(d.end()).toBe('中文')
  })
})

describe('ConsoleLineDecoder', () => {
  it('只交完整的行，一行分两块到也不会漏出半行', () => {
    const d = new ConsoleLineDecoder(win936)
    expect(d.write(Buffer.from('token=ab'))).toBe('')
    expect(d.write(Buffer.from('cd\nnext'))).toBe('token=abcd\n')
    expect(d.end()).toBe('next')
  })

  it('多字节字符被切开：UTF-8 和 GBK 都能还原', () => {
    const utf8 = Buffer.from('中文\n', 'utf8')
    const a = new ConsoleLineDecoder(win936)
    expect(a.write(utf8.subarray(0, 4)) + a.write(utf8.subarray(4)) + a.end()).toBe('中文\n')
    const gbk = Buffer.from([...GBK_ZHONGWEN, 0x0a])
    const b = new ConsoleLineDecoder(win936)
    expect(b.write(gbk.subarray(0, 1)) + b.write(gbk.subarray(1)) + b.end()).toBe('中文\n')
  })

  it('同一块里 UTF-8 行和 GBK 行混着也各按各的解', () => {
    const d = new ConsoleLineDecoder(win936)
    const chunk = Buffer.concat([Buffer.from('好\n', 'utf8'), Buffer.from(GBK_ZHONGWEN), Buffer.from('\n')])
    expect(d.write(chunk)).toBe('好\n中文\n')
  })

  it('一行太长丢掉并给提示，这一行剩下的部分一直丢到换行', () => {
    const d = new ConsoleLineDecoder(win936, 10)
    expect(d.write(Buffer.from('xxxxxxxxsk-SEC'))).toBe('[long output omitted]\n')
    expect(d.write(Buffer.from('RET123'))).toBe('')
    expect(d.write(Buffer.from('456\nok\n'))).toBe('ok\n')
  })

  it('mask：解码前在字节里遮掉密钥，坏字节紧挨着密钥也不会让它躲过', () => {
    const d = new ConsoleLineDecoder({ ...win936, mask: ['sk-ABCDEF123456', 'abc'] })
    // Latin-1 的 é（0xE9）后面紧跟密钥：按 GB18030 解会把 s 并进一个汉字
    const line = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from('sk-ABCDEF123456 abc\n')])
    const out = d.write(line)
    expect(out).toContain('[redacted]')
    expect(out).not.toContain('ABCDEF123456')
    // 少于 4 个字符的不遮（和文字脱敏一致）
    expect(out).toContain('abc')
  })
})

describe.skipIf(process.platform !== 'win32')('Windows 真实子进程', () => {
  it('cmd 的 OEM 输出经解码器没有乱码', async () => {
    const oem = await detectOemCodePage()
    // 先把控制台代码页设成系统的 OEM 代码页：跑测试的终端可能 chcp 过（例如 65001），cmd 会照着它输出
    const command = oem ? `chcp ${oem} >nul & echo 中文测试` : 'echo 中文测试'
    const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const decoder = new ConsoleLineDecoder()
    let text = ''
    child.stdout.on('data', (c: Buffer) => (text += decoder.write(c)))
    await new Promise(r => child.on('close', r))
    text += decoder.end()
    // 参数经 CreateProcess 以 UTF-16 传入，cmd 再按 OEM 代码页回显；代码页放不下的字符本身就显示不出，
    // 所以只在能表示中文的代码页（936 / 950 / 932）上断言
    const cp = await detectOemCodePage()
    if (cp === 936) expect(text.trim()).toBe('中文测试')
    else expect(text).not.toContain('���')
  })
})
