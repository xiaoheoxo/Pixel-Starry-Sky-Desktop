/** 全局快捷键。macOS 用 ⌘，其他平台用 Ctrl。列表见 docs/ui/workbench.md §7 */

import { isMac, labelOf, matchesAction, type ActionId } from './keybindings'

/** 可以自定义的快捷键（docs/ui/custom-shortcuts.md）：显示文字和判断都按当前设置，调用的地方不用改 */
function action(id: ActionId): { readonly label: string; match: (e: KeyboardEvent) => boolean } {
  return {
    get label() {
      return labelOf(id)
    },
    match: e => matchesAction(id, e),
  }
}

/** 收起 / 展开侧边栏：默认 Ctrl+B（macOS ⌘B），和 Mirasim、VS Code 一致 */
export const TOGGLE_SIDEBAR = action('toggleSidebar')
/** 收起 / 展开右侧面板：默认 Ctrl+Alt+B（macOS ⌥⌘B），和 VS Code 的辅助侧栏一致 */
export const TOGGLE_PANEL = action('togglePanel')
/** 收起 / 展开代码模式的底部面板：默认 Ctrl+J（macOS ⌘J），只在代码模式生效 */
export const TOGGLE_BOTTOM_PANEL = action('toggleBottomPanel')
/** 打开设置：默认 Ctrl+,（macOS ⌘,） */
export const OPEN_SETTINGS = action('openSettings')
export const OPEN_SEARCH = action('openSearch')
/** 新建任务：默认 Ctrl+N（macOS ⌘N），docs/ui/layout-v2.md §9 */
export const NEW_TASK = action('newTask')
/** 在当前对话里查找：默认 Ctrl+F，docs/ui/content-highlight.md §2 E；终端、编辑器里仍是它们自己的查找 */
export const FIND_IN_CONVERSATION = action('findInConversation')
/** 命令面板：默认 Ctrl+Shift+P */
export const COMMAND_PALETTE = action('commandPalette')
/** 显示 / 隐藏终端：默认 Ctrl+`；新建终端：默认 Ctrl+Shift+` */
export const TOGGLE_TERMINAL = action('toggleTerminal')
export const NEW_TERMINAL = action('newTerminal')
/** 编辑器里把选中的代码引用到对话：默认 Ctrl+L（macOS ⌘L），docs/ui/editor-quote.md */
export const QUOTE_SELECTION = action('quoteSelection')
/** 快捷键一览：默认 Ctrl+/（macOS ⌘/），docs/ui/ui-polish-2026-10-13.md §5 */
export const SHORTCUTS_HELP = action('shortcutsHelp')
/** 会话界面 ⇄ 终端（TUI）：默认 Alt+T（docs/ui/tui-toggle.md §3.1） */
export const TOGGLE_TUI_MODE = action('toggleTuiMode')
/** 打开 / 关闭旁聊：默认 Ctrl+;，在当前对话区生效 */
export const TOGGLE_SIDE_CHAT = action('toggleSideChat')
/** 打开内置浏览器：默认 Ctrl+Shift+B */
export const OPEN_BUILTIN_BROWSER = action('openBrowser')
/** 切换权限模式：默认 Ctrl+Shift+M，跳过完全放行（session/fullAccess.ts） */
export const CYCLE_PERMISSION = action('cyclePermission')
/** 切换对话查看模式：默认 Ctrl+O，在当前对话区生效（docs/ui/view-mode.md） */
export const CYCLE_VIEW_MODE = action('cycleViewMode')
/** 语音输入开始 / 结束并识别：默认 Alt+V，在当前对话区生效（docs/ui/voice-input.md §11） */
export const TOGGLE_VOICE = action('toggleVoice')

const mod = (e: KeyboardEvent): boolean => (isMac ? e.metaKey : e.ctrlKey)

// ---------------------------------------------------------------------------
// 多对话窗格（与 Mirasim 一致，docs/ui/multi-pane.md §4）
// ---------------------------------------------------------------------------

/** 向右拆分：默认 Ctrl+D */
export const SPLIT_RIGHT = action('splitRight')

/** 向下拆分：默认 Ctrl+Shift+D */
export const SPLIT_DOWN = action('splitDown')

/** 关闭当前标签，窗格空了就关窗格：Ctrl+W（主进程的菜单里去掉了「关闭窗口」，见 main/index.ts） */
export const CLOSE_TAB = action('closeTab')

/** 放大 / 还原当前窗格：默认 Ctrl+Shift+Enter */
export const ZOOM_PANE = action('zoomPane')

/** 跳到第 N 个窗格：Alt+1…6；返回窗格序号（从 0 开始），不匹配返回 -1 */
export const JUMP_PANE = {
  label: isMac ? '⌥1…6' : 'Alt+1…6',
  index: (e: KeyboardEvent): number => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return -1
    const m = /^Digit([1-6])$/.exec(e.code)
    return m ? Number(m[1]) - 1 : -1
  },
}

/** 切换到上一个 / 下一个窗格：Ctrl+Alt+← / →；返回 -1、1，不匹配返回 0 */
export const CYCLE_PANE = {
  label: isMac ? '⌥⌘← / →' : 'Ctrl+Alt+← / →',
  delta: (e: KeyboardEvent): number => {
    if (!mod(e) || !e.altKey || e.shiftKey) return 0
    return e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
  },
}

/** 当前窗格里切换标签：Ctrl+Tab / Ctrl+Shift+Tab（macOS 也用 Ctrl，和浏览器一致）；返回 1、-1，不匹配返回 0 */
export const CYCLE_TAB = {
  label: 'Ctrl+Tab',
  delta: (e: KeyboardEvent): number =>
    e.key === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey ? (e.shiftKey ? -1 : 1) : 0,
}

/** 按钮提示文字后面带上快捷键，例如「收起侧边栏（Ctrl+B）」 */
export function withShortcut(label: string, shortcut: { label: string }): string {
  return `${label}（${shortcut.label}）`
}
