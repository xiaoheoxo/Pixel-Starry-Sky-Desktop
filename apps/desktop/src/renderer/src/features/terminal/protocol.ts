// 现代 CLI 终端协议应答与输入杂讯过滤（docs/ui/terminal-batch1-tui-hardening.md）：
// 1. 浅色保底对比度阈值 4.5（WCAG AA）；
// 2. Codex 0.154+ Kitty 键盘协议兜底：回复 CSI ? u → \x1b[?0u，消费 CSI > u / < u 维持 legacy 编码，保护中文 IME；
// 3. 应答 OSC 10 / 11 / 4 颜色查询，壁纸 / 毛玻璃透明底时拦截非查询的 OSC 11 写背景；
// 4. 应答 CSI 6n（光标位置 CPR）与 CSI c（主设备属性 DA1）；
// 5. 未开启 CSI ?1004h 时过滤误发的焦点报告 \x1b[I / \x1b[O。
import type { IDisposable, Terminal } from '@xterm/xterm'

/** xterm 文字对背景的最低对比度（WCAG AA 正文标准；达标颜色原样不动，过浅/过暗自动推离背景） */
export const MINIMUM_CONTRAST_RATIO = 4.5

export interface TerminalPalette {
  foreground: string
  background: string
  ansi: readonly string[]
}

/** 未开启焦点上报模式（CSI ?1004h）时，丢弃 xterm 产生的焦点进入/离开序列 */
export function isUnrequestedFocusReport(data: string, sendFocusMode: boolean): boolean {
  return !sendFocusMode && (data === '\x1b[I' || data === '\x1b[O')
}

/** 识别 xterm 解析器自动产生的查询应答（含 DA1/DA2、DSR/CPR、焦点报告、窗口尺寸与 OSC 颜色应答），供历史回放期间拦截 */
const RE_PROTOCOL_REPLY =
  // eslint-disable-next-line no-control-regex -- 匹配 ESC 引导的终端自动应答序列
  /^\x1b(?:\[(?:[IO]|0n|\??\d+;\d+R|[?>]?[\d;]*c|\?\d+u|[468];[\d;]+t)|\](?:4;\d+|1[012]);rgb:[0-9a-f/]+(?:\x07|\x1b\\))$/i

export function isProtocolReplyData(data: string): boolean {
  return RE_PROTOCOL_REPLY.test(data)
}

/** 解析 #rgb / #rrggbb / rgb(...) 为 0..255 三元组 */
export function parseCssRgb(raw: string): [number, number, number] | null {
  const s = raw.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(s)
  if (hex) {
    const h =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map(c => c + c)
            .join('')
        : hex[1]
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[\s,]\s*(\d{1,3})\s*[\s,]\s*(\d{1,3})/i.exec(s)
  if (!rgb) return null
  const nums = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums as [number, number, number]
}

function formatOscRgb(color: string): string | null {
  const rgb = parseCssRgb(color)
  if (!rgb) return null
  const hex4 = (n: number) => {
    const h = n.toString(16).padStart(2, '0').toLowerCase()
    return h + h
  }
  return `rgb:${hex4(rgb[0])}/${hex4(rgb[1])}/${hex4(rgb[2])}`
}

export function resolveOscColor(
  ident: 4 | 10 | 11,
  data: string,
  palette: TerminalPalette,
  transparentSurface: boolean,
): { handled: boolean; reply: string | null } {
  const trimmed = data.trim()
  // 壁纸 / 毛玻璃开启时：允许 CLI 查询逻辑底色（?），但拦截 CLI 改写终端背景色遮住透明底
  if (ident === 11 && trimmed !== '?' && transparentSurface) return { handled: true, reply: null }

  if (ident === 10 && trimmed === '?') {
    const c = formatOscRgb(palette.foreground)
    return { handled: c !== null, reply: c ? `\x1b]10;${c}\x1b\\` : null }
  }
  if (ident === 11 && trimmed === '?') {
    const c = formatOscRgb(palette.background)
    return { handled: c !== null, reply: c ? `\x1b]11;${c}\x1b\\` : null }
  }
  if (ident === 4) {
    const parts = trimmed.split(';')
    if (parts.length < 2 || parts.length % 2 !== 0) return { handled: false, reply: null }
    let replies = ''
    for (let i = 0; i < parts.length; i += 2) {
      const rawIdx = parts[i]!.trim()
      const rawQuery = parts[i + 1]!.trim()
      if (!/^\d+$/.test(rawIdx) || rawQuery !== '?') return { handled: false, reply: null }
      const idx = Number(rawIdx)
      if (idx < 0 || idx >= palette.ansi.length) return { handled: false, reply: null }
      const c = formatOscRgb(palette.ansi[idx] ?? '')
      if (!c) return { handled: false, reply: null }
      replies += `\x1b]4;${idx};${c}\x1b\\`
    }
    return { handled: true, reply: replies }
  }
  return { handled: false, reply: null }
}

const firstScalar = (params: readonly (number | number[])[], fallback = 0): number =>
  params.length === 0 ? fallback : typeof params[0] === 'number' ? params[0] : (params[0][0] ?? fallback)

/** CSI 6n / CSI ? 6n：光标位置报告（1-based） */
export function buildCprReply(
  params: readonly (number | number[])[],
  prefix: string | undefined,
  cursorX: number,
  cursorY: number,
): string | null {
  if (params.length !== 1 || firstScalar(params, -1) !== 6) return null
  const row = Math.max(1, cursorY + 1)
  const col = Math.max(1, cursorX + 1)
  if (!prefix) return `\x1b[${row};${col}R`
  if (prefix === '?') return `\x1b[?${row};${col}R`
  return null
}

/** CSI c / CSI 0c：主设备属性（VT100 + AVO） */
export function buildDa1Reply(params: readonly (number | number[])[], prefix?: string): string | null {
  if (prefix || params.length > 1 || firstScalar(params, 0) !== 0) return null
  return '\x1b[?1;2c'
}

/** CSI ? u：Kitty 键盘协议查询，固定回复不支持扩展位（0），防止切换编码破坏中文 IME */
export function buildKittyKeyboardReply(params: readonly (number | number[])[], prefix?: string): string | null {
  if (prefix !== '?' || params.length > 1 || firstScalar(params, 0) !== 0) return null
  return '\x1b[?0u'
}

/** 记录每个终端已实时处理过的最大 (generation, seq)，重挂视图回放历史时不再重复向 PTY 发送旧查询应答 */
const answeredSeqs = new Map<string, { generation: number; seq: number }>()

export function getAnsweredSeq(terminalId: string, generation: number): number {
  const prev = answeredSeqs.get(terminalId)
  return prev?.generation === generation ? prev.seq : 0
}

export function markAnsweredSeq(terminalId: string, generation: number, seq: number): void {
  const prev = answeredSeqs.get(terminalId)
  if (!prev || prev.generation !== generation || seq > prev.seq) {
    if (answeredSeqs.size >= 256 && !answeredSeqs.has(terminalId)) {
      const oldest = answeredSeqs.keys().next().value
      if (oldest !== undefined) answeredSeqs.delete(oldest)
    }
    answeredSeqs.set(terminalId, { generation, seq })
  }
}

export function clearAnsweredSeq(terminalId: string): void {
  answeredSeqs.delete(terminalId)
}

export function bindTerminalProtocol(
  term: Pick<Terminal, 'parser' | 'buffer'>,
  deps: {
    getPalette: () => TerminalPalette
    isTransparent: () => boolean
    sendReply: (data: string) => void
  },
): IDisposable {
  const cpr = (prefix?: string) => (params: (number | number[])[]) => {
    const reply = buildCprReply(params, prefix, term.buffer.active.cursorX, term.buffer.active.cursorY)
    if (!reply) return false
    deps.sendReply(reply)
    return true
  }
  const osc = (ident: 4 | 10 | 11) => (data: string) => {
    const res = resolveOscColor(ident, data, deps.getPalette(), deps.isTransparent())
    if (!res.handled) return false
    if (res.reply) deps.sendReply(res.reply)
    return true
  }
  const disposables: IDisposable[] = [
    term.parser.registerCsiHandler({ final: 'n' }, cpr()),
    term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, cpr('?')),
    term.parser.registerCsiHandler({ final: 'c' }, params => {
      const reply = buildDa1Reply(params)
      if (!reply) return false
      deps.sendReply(reply)
      return true
    }),
    term.parser.registerCsiHandler({ prefix: '?', final: 'u' }, params => {
      const reply = buildKittyKeyboardReply(params, '?')
      if (!reply) return false
      deps.sendReply(reply)
      return true
    }),
    // 消费 Kitty 键盘协议的 push（>u）、pop（<u）与 set（=u），保持 legacy 键盘编码让中文输入法正常合成
    term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, () => true),
    term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, () => true),
    term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, () => true),
    term.parser.registerOscHandler(4, osc(4)),
    term.parser.registerOscHandler(10, osc(10)),
    term.parser.registerOscHandler(11, osc(11)),
  ]
  return {
    dispose() {
      for (const d of disposables) d.dispose()
    },
  }
}
