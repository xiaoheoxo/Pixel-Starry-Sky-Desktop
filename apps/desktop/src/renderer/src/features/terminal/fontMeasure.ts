// 终端字体晚加载重测格宽（docs/ui/terminal-batch1-tui-hardening.md）：
// xterm 初始化时若自定义等宽字体尚未加载完成，会按回退字体测量单元格；
// 目标字体随后就绪时必须重测 CharSizeService 并重新 fit，避免字符挤压或右缘裁切。
import type { Terminal } from '@xterm/xterm'

interface CharSizeInternals {
  _core?: {
    _charSizeService?: { measure?: () => void }
    _renderService?: { handleDevicePixelRatioChange?: () => void }
  }
}

/** 触发 xterm 重新测量当前字体的单元格宽高并清空 DomRenderer 字形宽度缓存；内部接口不存在时安全忽略 */
export function remeasureCharSize(term: Terminal): boolean {
  const core = (term as unknown as CharSizeInternals)._core
  const measure = core?._charSizeService?.measure
  const refreshRenderer = core?._renderService?.handleDevicePixelRatioChange
  if (typeof measure !== 'function' && typeof refreshRenderer !== 'function') return false
  try {
    measure?.call(core!._charSizeService)
    refreshRenderer?.call(core!._renderService)
    return true
  } catch {
    return false
  }
}

export interface FontSetLike {
  check?(font: string): boolean
  addEventListener(type: 'loadingdone', listener: () => void): void
  removeEventListener(type: 'loadingdone', listener: () => void): void
}

function isFontReady(fonts: FontSetLike, term: Pick<Terminal, 'options'>): boolean {
  const family = term.options.fontFamily
  const size = term.options.fontSize ?? 13
  if (!family || typeof fonts.check !== 'function') return true
  try {
    return fonts.check(`${size}px ${family}`)
  } catch {
    return true
  }
}

/** 当前终端字体尚未就绪时挂 loadingdone 监听，直到目标字体加载完重测并自动摘除 */
export function watchTerminalFont(
  term: Terminal,
  onReady: () => void,
  fonts: FontSetLike | null | undefined = typeof document !== 'undefined' ? document.fonts : null,
): () => void {
  if (!fonts || isFontReady(fonts, term)) return () => {}
  const onDone = (): void => {
    remeasureCharSize(term)
    onReady()
    if (isFontReady(fonts, term)) fonts.removeEventListener('loadingdone', onDone)
  }
  fonts.addEventListener('loadingdone', onDone)
  return () => fonts.removeEventListener('loadingdone', onDone)
}
