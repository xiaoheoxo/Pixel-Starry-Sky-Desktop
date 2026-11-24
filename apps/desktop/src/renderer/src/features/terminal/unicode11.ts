// 零外部依赖的 Unicode 11+ 字符宽度提供器（实现 xterm 的 IUnicodeVersionProvider）：
// xterm 内置的 UnicodeV6 把现代 Emoji（如 ✨ ✅ ❌ 🔎 🟢 🚀 🤖）全算成 1 格，导致 TUI 边框错位；
// 这里借助 V8 内置的 Unicode 属性正则（Emoji_Presentation / Extended_Pictographic / Mn / Me）
// 与东亚宽字符区间，同时正确合并肤色修饰符、FE0F 变体选择符和 ZWJ 连字序列。
import type { IUnicodeVersionProvider, Terminal } from '@xterm/xterm'

const KIND_NORMAL = 0
const KIND_COMBINING = 1
const KIND_EMOJI = 2
const KIND_EMOJI_TEXT = 3
const KIND_ZWJ = 4
const KIND_KEYCAP_BASE = 5
const KIND_KEYCAP_FE0F = 6

const RE_COMBINING = /^[\p{Mn}\p{Me}]$/u
const RE_EMOJI_WIDE = /^\p{Emoji_Presentation}$/u
const RE_EMOJI_PICTO = /^\p{Extended_Pictographic}$/u

const CACHE_LIMIT = 4096
/** 码点缓存：高 4 位存 kind，低 2 位存基础宽度（0 / 1 / 2） */
const cache = new Map<number, number>()

const packProp = (kind: number, width: number, shouldJoin: boolean): number =>
  ((kind & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0)

const unpackWidth = (prop: number): 0 | 1 | 2 => ((prop >> 1) & 3) as 0 | 1 | 2
const unpackKind = (prop: number): number => prop >> 3

function isZeroWidthFormat(cp: number): boolean {
  return (
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0xfeff ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0000 && cp <= 0xe01ef)
  )
}

function isEastAsianWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0x3247) ||
    (cp >= 0x3250 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4c6) ||
    (cp >= 0xa960 && cp <= 0xa97c) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6b) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1b000 && cp <= 0x1b122) ||
    (cp >= 0x1f200 && cp <= 0x1f251) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

function isKeycapBase(cp: number): boolean {
  return cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39)
}

function classify(cp: number): { width: 0 | 1 | 2; kind: number } {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return { width: 0, kind: KIND_NORMAL }
  if (isKeycapBase(cp)) return { width: 1, kind: KIND_KEYCAP_BASE }
  if (cp < 0x7f) return { width: 1, kind: KIND_NORMAL }
  // 区域指示符（国旗字母 🇦..🇿）：每枚固定占 1 格（成对自然占 2 格且在 DomRenderer 同属性连续段内自动合字，避免跨换行残留连接态）
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return { width: 1, kind: KIND_NORMAL }
  const hit = cache.get(cp)
  if (hit !== undefined) return { width: (hit & 3) as 0 | 1 | 2, kind: hit >> 2 }

  let width: 0 | 1 | 2 = 1
  let kind = KIND_NORMAL
  if (isZeroWidthFormat(cp)) {
    width = 0
    kind = KIND_COMBINING
  } else {
    const ch = String.fromCodePoint(cp)
    if (RE_COMBINING.test(ch)) {
      width = 0
      kind = KIND_COMBINING
    } else if (RE_EMOJI_WIDE.test(ch)) {
      width = 2
      kind = KIND_EMOJI
    } else if (isEastAsianWide(cp)) {
      width = 2
      kind = KIND_NORMAL
    } else if (RE_EMOJI_PICTO.test(ch)) {
      // 默认文本样式（如 ⚠ ☀ ⚙）：单独出现占 1 格，后面跟 U+FE0F 时升为 2 格
      width = 1
      kind = KIND_EMOJI_TEXT
    }
  }
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(cp, (kind << 2) | width)
  return { width, kind }
}

export const unicode11Provider: IUnicodeVersionProvider = {
  version: '11',
  wcwidth(codepoint: number): 0 | 1 | 2 {
    if (codepoint < 0 || codepoint > 0x10ffff) return 0
    return classify(codepoint).width
  },
  charProperties(codepoint: number, preceding: number): number {
    if (codepoint < 0 || codepoint > 0x10ffff) return 0
    const prevWidth = preceding ? unpackWidth(preceding) : 0
    const prevKind = preceding ? unpackKind(preceding) : KIND_NORMAL

    // ZWJ（U+200D）：跟在 Emoji / 候选符号后面时并入同一字形簇，并标记下一枚 Emoji 也合并；跟在普通字符后保持原格宽不倒扣
    if (codepoint === 0x200d) {
      if ((prevKind === KIND_EMOJI || prevKind === KIND_EMOJI_TEXT) && prevWidth > 0)
        return packProp(KIND_ZWJ, prevWidth, true)
      return packProp(KIND_COMBINING, prevWidth, prevWidth > 0)
    }

    // 变体选择符 16（U+FE0F）：把窄候选符号（如 ⚠）提升为 2 格 Emoji；跟在 0-9/#/* 后进入键帽 Emoji 等待态
    if (codepoint === 0xfe0f) {
      if ((prevKind === KIND_EMOJI_TEXT || prevKind === KIND_EMOJI) && prevWidth > 0)
        return packProp(KIND_EMOJI, 2, true)
      if (prevKind === KIND_KEYCAP_BASE && prevWidth > 0) return packProp(KIND_KEYCAP_FE0F, 1, true)
      return packProp(KIND_COMBINING, prevWidth, prevWidth > 0)
    }

    // 键帽外框（U+20E3）：跟在 [0-9#*]+FE0F 后升为 2 格键帽 Emoji（如 1️⃣ #️⃣）
    if (codepoint === 0x20e3 && prevKind === KIND_KEYCAP_FE0F && prevWidth > 0) {
      return packProp(KIND_EMOJI, 2, true)
    }

    // 肤色修饰符（U+1F3FB..U+1F3FF）：跟在 Emoji 后面时不额外占格
    if (codepoint >= 0x1f3fb && codepoint <= 0x1f3ff) {
      if ((prevKind === KIND_EMOJI || prevKind === KIND_EMOJI_TEXT) && prevWidth > 0)
        return packProp(KIND_EMOJI, 2, true)
      return packProp(KIND_EMOJI, 2, false)
    }

    const { width, kind } = classify(codepoint)

    // ZWJ 后紧跟的 Emoji：并入前一个 2 格 Emoji 字形簇
    if (prevKind === KIND_ZWJ && (kind === KIND_EMOJI || kind === KIND_EMOJI_TEXT)) return packProp(KIND_EMOJI, 2, true)

    if (width === 0 && preceding !== 0) {
      if (prevWidth === 0) return packProp(kind, 0, false)
      return packProp(prevKind, prevWidth, true)
    }
    return packProp(kind, width, false)
  },
}

/** 给终端实例注册并启用 Unicode 11+ 宽度提供器 */
export function enableUnicode11(term: Pick<Terminal, 'unicode'>): void {
  try {
    if (!term.unicode.versions.includes('11')) term.unicode.register(unicode11Provider)
    term.unicode.activeVersion = '11'
  } catch {
    /* 测试桩或未开 proposed API 时忽略 */
  }
}
