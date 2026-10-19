// 可以自定义的快捷键（docs/ui/custom-shortcuts.md）：动作列表和默认键、本机保存的自定义、按当前设置判断按键。
// 一组键的（Alt+1…6、Ctrl+Alt+← / →、Ctrl+Tab）和终端里的复制粘贴固定，只用来检查冲突。
import { useSyncExternalStore } from 'react'
import { tr, type TranslationKey } from '../../i18n/core'
import {
  formatBinding,
  matchesBinding,
  parseBinding,
  sameBinding,
  type Binding,
  type KeyEventLike,
} from './keybindingModel'

export const isMac = typeof window !== 'undefined' && window.pixelsky?.platform === 'darwin'

const key = (code: string, { shift = false, alt = false, mod = true } = {}): Binding => ({ code, mod, shift, alt })

/** 能改的动作，按设置页里的顺序 */
export const ACTIONS = [
  // 新建任务（docs/ui/layout-v2.md §9）；终端输入里不抢，任务看板页里仍是它自己的「新建卡片」
  { id: 'newTask', label: 'sidebar.action.newTask', binding: key('KeyN') },
  { id: 'commandPalette', label: 'terminal.commandPalette', binding: key('KeyP', { shift: true }) },
  { id: 'toggleTerminal', label: 'terminal.title', binding: key('Backquote') },
  { id: 'newTerminal', label: 'terminal.new', binding: key('Backquote', { shift: true }) },
  { id: 'toggleSidebar', label: 'settings.SettingsDialog.toggleSidebar', binding: key('KeyB') },
  { id: 'togglePanel', label: 'settings.SettingsDialog.toggleRightPanel', binding: key('KeyB', { alt: true }) },
  // 代码模式的底部面板（docs/ui/coding-mode-impl.md）；对话模式里不处理
  { id: 'toggleBottomPanel', label: 'coding.shell.toggleBottomPanel', binding: key('KeyJ') },
  { id: 'openSettings', label: 'settings.SettingsDialog.openSettings', binding: key('Comma') },
  { id: 'openSearch', label: 'search.SearchDialog.searchConversationsAndContent', binding: key('KeyP') },
  { id: 'findInConversation', label: 'content.find.label', binding: key('KeyF') },
  { id: 'splitRight', label: 'shortcuts.splitPaneRight', binding: key('KeyD') },
  { id: 'splitDown', label: 'shortcuts.splitPaneDown', binding: key('KeyD', { shift: true }) },
  { id: 'closeTab', label: 'shortcuts.closeTabClosePane', binding: key('KeyW') },
  { id: 'zoomPane', label: 'shortcuts.expandRestoreCurrentPane', binding: key('Enter', { shift: true }) },
  // 编辑器里把选中的代码引用到对话（docs/ui/editor-quote.md）；只在编辑器里生效，终端里的 Ctrl+L 照旧清屏
  { id: 'quoteSelection', label: 'editor.quote.action', binding: key('KeyL') },
  // 快捷键一览（docs/ui/ui-polish-2026-10-13.md §5）；代码编辑器和终端里不抢（编辑器里是注释）
  { id: 'shortcutsHelp', label: 'shortcuts.help.action', binding: key('Slash') },
] as const satisfies readonly { id: string; label: TranslationKey; binding: Binding }[]

export type ActionId = (typeof ACTIONS)[number]['id']

const digits = [1, 2, 3, 4, 5, 6].map(n => key(`Digit${n}`, { mod: false, alt: true }))

/** 固定的快捷键：显示在设置页下面，也参与冲突检查 */
export const FIXED: readonly { label: TranslationKey; keys: () => string; bindings: Binding[] }[] = [
  { label: 'shortcuts.jumpToPaneN', keys: () => (isMac ? '⌥1…6' : 'Alt+1…6'), bindings: digits },
  {
    label: 'shortcuts.switchToPreviousNext',
    keys: () => (isMac ? '⌥⌘← / →' : 'Ctrl+Alt+← / →'),
    bindings: [key('ArrowLeft', { alt: true }), key('ArrowRight', { alt: true })],
  },
  {
    label: 'shortcuts.switchTabsInPane',
    keys: () => 'Ctrl+Tab / Ctrl+Shift+Tab',
    bindings: [key('Tab', { mod: !isMac }), key('Tab', { mod: !isMac, shift: true })],
  },
  // Windows / Linux 上有选中内容时 Ctrl+C 也复制（Ctrl+C 本来就是保留键，不用进 bindings）
  {
    label: 'terminal.copy',
    keys: () => (isMac ? 'Ctrl+Shift+C' : 'Ctrl+C / Ctrl+Shift+C'),
    bindings: [key('KeyC', { shift: true })],
  },
  { label: 'terminal.paste', keys: () => 'Ctrl+Shift+V', bindings: [key('KeyV', { shift: true })] },
]

const STORAGE_KEY = 'pixelsky.keybindings'
type Custom = Partial<Record<ActionId, Binding>>

function load(): Custom {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (!saved || typeof saved !== 'object') return {}
    const out: Custom = {}
    for (const action of ACTIONS) {
      const b = parseBinding((saved as Record<string, unknown>)[action.id])
      if (b) out[action.id] = b
    }
    return out
  } catch {
    return {}
  }
}

let custom: Custom = typeof window === 'undefined' ? {} : load()
/** 设置页正在录制：这期间按键不触发任何动作 */
let recording = false
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(l => l())

function save(next: Custom): void {
  custom = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(custom))
  } catch {
    // 存储不可用时，当前窗口内仍然生效
  }
  emit()
}

function onStorage(event: StorageEvent): void {
  if (event.storageArea !== localStorage || (event.key !== STORAGE_KEY && event.key !== null)) return
  custom = load()
  emit()
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

const defaultOf = (id: ActionId): Binding => ACTIONS.find(a => a.id === id)!.binding

export const bindingOf = (id: ActionId): Binding => custom[id] ?? defaultOf(id)
export const isCustomized = (id: ActionId): boolean => !!custom[id] && !sameBinding(custom[id], defaultOf(id))
export const anyCustomized = (): boolean => ACTIONS.some(a => isCustomized(a.id))

/** 显示文字，例如「Ctrl+B」「⌘B」 */
export const labelOf = (id: ActionId): string => formatBinding(bindingOf(id), isMac)

/** 按键是不是这个动作；录制中、按住不放的重复按键都不算 */
export function matchesAction(id: ActionId, e: KeyEventLike & { repeat?: boolean }): boolean {
  return !recording && !e.repeat && matchesBinding(e, bindingOf(id), isMac)
}

/** 改成别的组合键；null 恢复默认 */
export function setBinding(id: ActionId, binding: Binding | null): void {
  const next = { ...custom }
  if (!binding || sameBinding(binding, defaultOf(id))) delete next[id]
  else next[id] = binding
  save(next)
}

export function resetAllBindings(): void {
  save({})
}

export function setRecording(on: boolean): void {
  recording = on
}

/** 和哪个快捷键冲突（名字），不冲突为 null */
export function conflictOf(id: ActionId, binding: Binding): string | null {
  for (const action of ACTIONS)
    if (action.id !== id && sameBinding(bindingOf(action.id), binding)) return tr(action.label)
  for (const fixed of FIXED) if (fixed.bindings.some(b => sameBinding(b, binding))) return tr(fixed.label)
  return null
}

/** 自定义变了就重新渲染（设置页、按钮提示） */
export function useKeybindings(): Custom {
  return useSyncExternalStore(
    subscribe,
    () => custom,
    () => custom,
  )
}
