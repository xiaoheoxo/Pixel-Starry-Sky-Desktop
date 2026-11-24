import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { enableUnicode11, unicode11Provider } from './unicode11'
import {
  bindTerminalProtocol,
  buildCprReply,
  buildDa1Reply,
  buildKittyKeyboardReply,
  clearAnsweredSeq,
  getAnsweredSeq,
  isProtocolReplyData,
  isUnrequestedFocusReport,
  markAnsweredSeq,
  MINIMUM_CONTRAST_RATIO,
  parseCssRgb,
  resolveOscColor,
} from './protocol'
import { attachTuiWheel, consumeWheelSteps, createWheelCarry } from './tuiWheel'
import { remeasureCharSize, watchTerminalFont, type FontSetLike } from './fontMeasure'

let XtermTerminal: typeof Terminal

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>
  g.self ??= globalThis
  g.window ??= globalThis
  const mod = await import('@xterm/xterm')
  XtermTerminal = mod.Terminal
})

function writeAsync(term: Terminal, data: string): Promise<void> {
  return new Promise(resolve => term.write(data, resolve))
}

function makeWheelEvent(opts: {
  deltaY: number
  deltaMode?: number
  shiftKey?: boolean
  ctrlKey?: boolean
  target?: EventTarget
}): WheelEvent {
  const ev = Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), {
    deltaX: 0,
    deltaY: opts.deltaY,
    deltaZ: 0,
    deltaMode: opts.deltaMode ?? 0,
    shiftKey: opts.shiftKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: false,
    altKey: false,
    clientX: 40,
    clientY: 60,
  })
  if (opts.target) Object.defineProperty(ev, 'target', { value: opts.target })
  return ev as unknown as WheelEvent
}

describe('Unicode 11+ 字符宽度提供器', () => {
  it('现代 Emoji、变体选择符 FE0F、肤色修饰符与 ZWJ 连字在真实 xterm 缓冲区按正确格宽推进光标', async () => {
    const term = new XtermTerminal({ cols: 80, rows: 10, allowProposedApi: true })
    try {
      enableUnicode11(term)
      expect(term.unicode.activeVersion).toBe('11')

      for (const [sample, expectedCols] of [
        ['✨', 2],
        ['✅', 2],
        ['❌', 2],
        ['🔎', 2],
        ['🟢', 2],
        ['🚀', 2],
        ['🤖', 2],
        ['⚠', 1],
        ['⚠️', 2],
        ['👍🏽', 2],
        ['👨‍💻', 2],
        ['👨🏽‍💻', 2],
        ['👩‍❤️‍👨', 2],
        ['\u{1F441}\u200D\u{1F5E8}', 2],
        ['1️⃣', 2],
        ['#️⃣', 2],
        ['1\uFE0F', 1],
        ['1\u20E3', 1],
        ['🇦', 1],
        ['🇨🇳', 2],
        ['🇨🇳🇺🇸', 4],
        ['a\u200db', 2],
        ['中文', 4],
        ['╭──╮', 4],
        ['abc', 3],
        ['e\u0301', 1],
      ] as const) {
        term.reset()
        await writeAsync(term, sample)
        expect(term.buffer.active.cursorX, `sample: ${sample}`).toBe(expectedCols)
      }

      // 跨换行或 reset 后区域指示符互不串扰：上一行末尾单枚 🇦 不会污染下一行开头的 🇨🇳 宽度
      term.reset()
      await writeAsync(term, '🇦\r\n🇨🇳')
      expect(term.buffer.active.cursorY).toBe(1)
      expect(term.buffer.active.cursorX).toBe(2)
    } finally {
      term.dispose()
    }
  })

  it('非法码点安全返回 0', () => {
    expect(unicode11Provider.wcwidth(-1)).toBe(0)
    expect(unicode11Provider.wcwidth(0x110000)).toBe(0)
  })
})

describe('终端转义协议应答与焦点过滤', () => {
  const palette = {
    foreground: '#20211f',
    background: '#ffffff',
    ansi: ['#20211f', '#b8463f', '#2f7d4f', '#946a0e'],
  }

  it('保底对比度固定为 WCAG AA 4.5', () => {
    expect(MINIMUM_CONTRAST_RATIO).toBe(4.5)
  })

  it('未开启 ?1004h 时过滤焦点进出序列，开启后放行，普通字母不受影响', () => {
    expect(isUnrequestedFocusReport('\x1b[I', false)).toBe(true)
    expect(isUnrequestedFocusReport('\x1b[O', false)).toBe(true)
    expect(isUnrequestedFocusReport('\x1b[I', true)).toBe(false)
    expect(isUnrequestedFocusReport('I', false)).toBe(false)
  })

  it('解析 #rgb / #rrggbb / rgb() 并按 XParseColor 四位十六进制回复 OSC 10/11/4', () => {
    expect(parseCssRgb('#abc')).toEqual([0xaa, 0xbb, 0xcc])
    expect(parseCssRgb('rgb(32, 33, 31)')).toEqual([32, 33, 31])
    expect(resolveOscColor(10, '?', palette, false)).toEqual({
      handled: true,
      reply: '\x1b]10;rgb:2020/2121/1f1f\x1b\\',
    })
    expect(resolveOscColor(11, '?', palette, false)).toEqual({
      handled: true,
      reply: '\x1b]11;rgb:ffff/ffff/ffff\x1b\\',
    })
    expect(resolveOscColor(4, '1;?', palette, false)).toEqual({
      handled: true,
      reply: '\x1b]4;1;rgb:b8b8/4646/3f3f\x1b\\',
    })
    // 多对 OSC 4 批量查询应逐一拼装回复，非法空索引交给下层忽略而非误当 0 号色
    expect(resolveOscColor(4, '0;?;2;?', palette, false)).toEqual({
      handled: true,
      reply: '\x1b]4;0;rgb:2020/2121/1f1f\x1b\\\x1b]4;2;rgb:2f2f/7d7d/4f4f\x1b\\',
    })
    expect(resolveOscColor(4, ';?', palette, false)).toEqual({ handled: false, reply: null })
  })

  it('壁纸或毛玻璃开启时拦截非查询的 OSC 11 写背景操作，查询照常回复', () => {
    expect(resolveOscColor(11, '#000000', palette, true)).toEqual({ handled: true, reply: null })
    expect(resolveOscColor(11, '#000000', palette, false)).toEqual({ handled: false, reply: null })
    expect(resolveOscColor(11, '?', palette, true)).toEqual({
      handled: true,
      reply: '\x1b]11;rgb:ffff/ffff/ffff\x1b\\',
    })
  })

  it('CPR / DA1 / Kitty 键盘查询应答符合规范，真实 xterm parser 端到端触发并消费 >u / <u', async () => {
    expect(buildCprReply([6], undefined, 4, 2)).toBe('\x1b[3;5R')
    expect(buildCprReply([6], '?', 0, 0)).toBe('\x1b[?1;1R')
    expect(buildCprReply([5], undefined, 0, 0)).toBeNull()
    expect(buildDa1Reply([])).toBe('\x1b[?1;2c')
    expect(buildDa1Reply([0])).toBe('\x1b[?1;2c')
    expect(buildDa1Reply([0], '>')).toBeNull()
    expect(buildKittyKeyboardReply([], '?')).toBe('\x1b[?0u')

    const replies: string[] = []
    const term = new XtermTerminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sub = bindTerminalProtocol(term, {
      getPalette: () => palette,
      isTransparent: () => false,
      sendReply: r => replies.push(r),
    })
    try {
      await writeAsync(term, 'AB\x1b[6n\x1b[?6n\x1b[c\x1b[?u\x1b[>1u\x1b[=1u\x1b[<u\x1b]11;?\x07')
      expect(replies).toEqual(['\x1b[1;3R', '\x1b[?1;3R', '\x1b[?1;2c', '\x1b[?0u', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
    } finally {
      sub.dispose()
      term.dispose()
    }
  })

  it('历史回放应答水线同时拦截自定义协议与 xterm 内置 onData 自动应答（DA2 / DSR / ?1004），不误伤普通输入', async () => {
    expect(isProtocolReplyData('\x1b[>0;276;0c')).toBe(true)
    expect(isProtocolReplyData('\x1b[0n')).toBe(true)
    expect(isProtocolReplyData('\x1b[O')).toBe(true)
    expect(isProtocolReplyData('\x1b]12;rgb:ffff/ffff/ffff\x1b\\')).toBe(true)
    expect(isProtocolReplyData('ls -la\r')).toBe(false)
    expect(isProtocolReplyData('\x1b[A')).toBe(false)

    clearAnsweredSeq('t1')
    expect(getAnsweredSeq('t1', 1)).toBe(0)
    markAnsweredSeq('t1', 1, 5)
    expect(getAnsweredSeq('t1', 1)).toBe(5)
    // 新一轮重启（generation 变大）从 0 重新算
    expect(getAnsweredSeq('t1', 2)).toBe(0)
    markAnsweredSeq('t1', 2, 3)
    expect(getAnsweredSeq('t1', 2)).toBe(3)

    // 模拟真实 TerminalView：同时接 bindTerminalProtocol 与 term.onData，验证历史里的 DA2 (\x1b[>c)、DSR (\x1b[5n)、?1004h 也不会在回放时漏出
    const sent: string[] = []
    let replayPending = 0
    const term = new XtermTerminal({ cols: 80, rows: 24, allowProposedApi: true })
    const sub = bindTerminalProtocol(term, {
      getPalette: () => palette,
      isTransparent: () => false,
      sendReply: r => {
        if (replayPending === 0) sent.push(r)
      },
    })
    const dataSub = term.onData(d => {
      if (isUnrequestedFocusReport(d, !!term.modes?.sendFocusMode)) return
      if (replayPending > 0 && isProtocolReplyData(d)) return
      sent.push(d)
    })
    try {
      const feed = (seq: number, data: string): Promise<void> =>
        new Promise(resolve => {
          if (seq <= getAnsweredSeq('t1', 2)) {
            replayPending++
            term.write(data, () => {
              replayPending = Math.max(0, replayPending - 1)
              resolve()
            })
            return
          }
          markAnsweredSeq('t1', 2, seq)
          term.write(data, resolve)
        })

      await Promise.all([
        feed(1, '\x1b]11;?\x07\x1b[>c\x1b[5n'),
        feed(2, '\x1b[?1004h\x1b[6n'),
        feed(4, 'OK\x1b[>c\x1b[6n'),
      ])
      // seq=1..2 旧历史零泄漏；只有 seq=4 新输出的 DA2 与 CPR 会触发回复
      expect(sent).toEqual(['\x1b[>0;276;0c', '\x1b[1;3R'])
    } finally {
      dataSub.dispose()
      sub.dispose()
      term.dispose()
      clearAnsweredSeq('t1')
    }
    expect(getAnsweredSeq('t1', 2)).toBe(0)
  })
})

describe('TUI 滚轮距离补偿', () => {
  it('按行高折算像素滚轮、平滑累积触控板小增量并在反向时清零余数', () => {
    const carry = createWheelCarry()
    expect(consumeWheelSteps(carry, 100, 0, 20, 24)).toEqual({ steps: 5, dir: 1 })
    expect(consumeWheelSteps(carry, 8, 0, 20, 24)).toEqual({ steps: 0, dir: 1 })
    expect(consumeWheelSteps(carry, 8, 0, 20, 24)).toEqual({ steps: 0, dir: 1 })
    expect(consumeWheelSteps(carry, 8, 0, 20, 24)).toEqual({ steps: 1, dir: 1 })
    // 反向滚动立刻清掉正向余数
    expect(consumeWheelSteps(carry, -10, 0, 20, 24)).toEqual({ steps: 0, dir: -1 })
    // 超大惯性限制单次最多 12 行
    expect(consumeWheelSteps(carry, 800, 0, 20, 24).steps).toBe(12)
  })

  it('仅在 mouseTrackingMode 开启且无修饰键时拦截并补发单行 WheelEvent，重放事件直通不递归', () => {
    let handler: ((e: WheelEvent) => boolean) | null = null
    const target = new EventTarget() as unknown as HTMLElement
    let mode: 'none' | 'vt200' = 'none'
    const fakeTerm = {
      element: target,
      rows: 24,
      get modes() {
        return { mouseTrackingMode: mode } as Terminal['modes']
      },
      attachCustomWheelEventHandler(fn: (e: WheelEvent) => boolean) {
        handler = fn
      },
    }
    attachTuiWheel(fakeTerm, () => 20)
    expect(handler).toBeTypeOf('function')

    // 未开启鼠标上报：原样放行
    expect(handler!(makeWheelEvent({ deltaY: 80 }))).toBe(true)

    // 开启鼠标上报：按住 Shift 绕过、按住 Ctrl 缩放均放行
    mode = 'vt200'
    expect(handler!(makeWheelEvent({ deltaY: 80, shiftKey: true }))).toBe(true)
    expect(handler!(makeWheelEvent({ deltaY: 80, ctrlKey: true }))).toBe(true)

    // 普通滚轮 80px / 20px = 4 个 line-mode 事件，且重放事件经过 handler 时返回 true
    const seen: WheelEvent[] = []
    ;(target as unknown as EventTarget).addEventListener('wheel', ev => {
      const we = ev as WheelEvent
      seen.push(we)
      expect(handler!(we)).toBe(true)
    })
    expect(handler!(makeWheelEvent({ deltaY: 80, target: target as unknown as EventTarget }))).toBe(false)
    expect(seen).toHaveLength(4)
    expect(seen.every(e => e.deltaMode === 1 && e.deltaY === 1 && e.bubbles === false)).toBe(true)
  })
})

describe('字体晚加载重测格宽', () => {
  it('调用内部 _charSizeService.measure 并刷新 _renderService 字形宽度缓存，缺少内部结构时安全返回 false', () => {
    const measure = vi.fn()
    const handleDevicePixelRatioChange = vi.fn()
    const fake = {
      _core: {
        _charSizeService: { measure },
        _renderService: { handleDevicePixelRatioChange },
      },
    } as unknown as Terminal
    expect(remeasureCharSize(fake)).toBe(true)
    expect(measure).toHaveBeenCalledTimes(1)
    expect(handleDevicePixelRatioChange).toHaveBeenCalledTimes(1)
    expect(remeasureCharSize({} as Terminal)).toBe(false)
  })

  it('目标字体未就绪时监听 loadingdone，无关字体完成时不摘除，目标字体就绪后自动解绑', () => {
    let ready = false
    const listeners = new Set<() => void>()
    const fonts: FontSetLike = {
      check: () => ready,
      addEventListener: (_t, fn) => listeners.add(fn),
      removeEventListener: (_t, fn) => listeners.delete(fn),
    }
    const measure = vi.fn()
    const onReady = vi.fn()
    const fake = {
      options: { fontFamily: 'JetBrains Mono', fontSize: 13 },
      _core: { _charSizeService: { measure } },
    } as unknown as Terminal

    const stop = watchTerminalFont(fake, onReady, fonts)
    expect(listeners.size).toBe(1)

    // 第一次是界面字体加载完，终端字体仍未就绪：重测但保留监听
    for (const fn of [...listeners]) fn()
    expect(measure).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(1)

    // 第二次终端字体就绪：重测并自动移除监听
    ready = true
    for (const fn of [...listeners]) fn()
    expect(measure).toHaveBeenCalledTimes(2)
    expect(onReady).toHaveBeenCalledTimes(2)
    expect(listeners.size).toBe(0)
    stop()
  })
})
