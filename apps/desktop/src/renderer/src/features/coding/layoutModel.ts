// 代码模式的布局算法（纯函数，不碰 window / localStorage）。docs/ui/coding-mode-impl.md §3.2
import type { AppMode, BottomTab, CodingLayoutPrefs, CodingPanel, LeftView, RightView } from './types'

export const STRIPE_WIDTH = 40
export const TOPBAR_HEIGHT = 48 // 和 WindowControls 的 h-12 一致
export const STATUSBAR_HEIGHT = 24
export const CENTER_MIN_WIDTH = 420
export const EDITOR_MIN_HEIGHT = 160
export const PANEL_LIMITS: Record<CodingPanel, { min: number; max: number; initial: number }> = {
  left: { min: 240, max: 520, initial: 280 },
  right: { min: 320, max: 720, initial: 420 },
  bottom: { min: 120, max: 900, initial: 260 },
}

export const DEFAULT_CODING_LAYOUT: CodingLayoutPrefs = {
  left: { open: true, size: PANEL_LIMITS.left.initial, view: 'files' },
  right: { open: true, size: PANEL_LIMITS.right.initial, view: 'chat' },
  bottom: { open: true, size: PANEL_LIMITS.bottom.initial, tab: 'terminal', maximized: false },
}

const LEFT_VIEWS: readonly LeftView[] = ['files', 'outline', 'search', 'git', 'tasks', 'conversations']
const RIGHT_VIEWS: readonly RightView[] = [
  'chat',
  'browser',
  'artifacts',
  'notifications',
  'tasks',
  'sandbox',
  'copies',
]
const BOTTOM_TABS: readonly BottomTab[] = ['terminal', 'aiCommands', 'output', 'problems', 'ports']

export function parseAppMode(raw: unknown): AppMode {
  return raw === 'code' ? 'code' : 'chat'
}

export function clampPanel(panel: CodingPanel, size: number): number {
  const { min, max, initial } = PANEL_LIMITS[panel]
  if (typeof size !== 'number' || !Number.isFinite(size)) return initial
  return Math.round(Math.min(max, Math.max(min, size)))
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const pick = <T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T =>
  typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
const bool = (raw: unknown, fallback: boolean): boolean => (typeof raw === 'boolean' ? raw : fallback)
const sizeOf = (panel: CodingPanel, raw: unknown): number =>
  typeof raw === 'number' && Number.isFinite(raw) ? clampPanel(panel, raw) : PANEL_LIMITS[panel].initial

/** 坏数据逐字段退回默认；接受已经解析好的对象或 JSON 字符串 */
export function parseCodingLayout(raw: unknown): CodingLayoutPrefs {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return DEFAULT_CODING_LAYOUT
    }
  }
  if (!isRecord(value)) return DEFAULT_CODING_LAYOUT
  const d = DEFAULT_CODING_LAYOUT
  const left = isRecord(value.left) ? value.left : {}
  const right = isRecord(value.right) ? value.right : {}
  const bottom = isRecord(value.bottom) ? value.bottom : {}
  return {
    left: {
      open: bool(left.open, d.left.open),
      size: sizeOf('left', left.size),
      view: pick(left.view, LEFT_VIEWS, d.left.view),
    },
    right: {
      open: bool(right.open, d.right.open),
      size: sizeOf('right', right.size),
      view: pick(right.view, RIGHT_VIEWS, d.right.view),
    },
    bottom: {
      open: bool(bottom.open, d.bottom.open),
      size: sizeOf('bottom', bottom.size),
      tab: pick(bottom.tab, BOTTOM_TABS, d.bottom.tab),
      maximized: bool(bottom.maximized, d.bottom.maximized),
    },
  }
}

export interface FittedPanel {
  shown: boolean
  size: number
}
export interface CodingFit {
  left: FittedPanel
  right: FittedPanel
  bottom: FittedPanel
  centerWidth: number
  editorHidden: boolean
  tooNarrow: boolean
  /** 左栏开着、但因为窗口窄这次被布局藏掉了（只剩活动栏） */
  leftHiddenByFit: boolean
  /** 终端页右侧的列表这次应该自动收起（挤压阶段，让终端本体宽一点） */
  terminalListCollapsed: boolean
}

/** 终端页右侧列表展开时的宽度 */
export const TERMINAL_LIST_WIDTH = 180

/**
 * 只决定这次怎么显示，不改用户保存的偏好。窗口变窄时的收缩顺序（docs/ui/coding-mode-impl.md §3.2）：
 * 左栏压到 240 -> 藏左栏（只剩活动栏）-> 右栏压到 320 -> 终端列表收起 -> 仍不够提示太窄。
 * keepLeft（用户刚主动打开左栏）时左栏只压不藏，改去压右栏。
 */
export function fitCoding(
  prefs: CodingLayoutPrefs,
  viewport: { width: number; height: number },
  opts: { keepLeft?: boolean } = {},
): CodingFit {
  const avail = viewport.width - 2 * STRIPE_WIDTH
  let L = prefs.left.open ? clampPanel('left', prefs.left.size) : 0
  const prefR = prefs.right.open ? clampPanel('right', prefs.right.size) : 0
  let R = prefR
  let leftShown = prefs.left.open
  let leftHiddenByFit = false
  let over = CENTER_MIN_WIDTH - (avail - L - R)
  if (over > 0 && L > 0) {
    const cut = Math.min(over, L - PANEL_LIMITS.left.min)
    if (cut > 0) {
      L -= cut
      over -= cut
    }
  }
  if (over > 0 && L > 0 && !opts.keepLeft) {
    L = 0
    leftShown = false
    leftHiddenByFit = true
    over = CENTER_MIN_WIDTH - (avail - R)
  }
  if (over > 0 && R > 0) {
    const cut = Math.min(over, R - PANEL_LIMITS.right.min)
    if (cut > 0) {
      R -= cut
      over -= cut
    }
  }
  const tooNarrow = over > 0
  const centerWidth = avail - L - R
  const squeezed = leftHiddenByFit || R < prefR || tooNarrow
  const terminalListCollapsed = squeezed && centerWidth < CENTER_MIN_WIDTH + TERMINAL_LIST_WIDTH

  const availH = viewport.height - TOPBAR_HEIGHT - STATUSBAR_HEIGHT
  let bottom: FittedPanel = { shown: false, size: clampPanel('bottom', prefs.bottom.size) }
  let editorHidden = false
  if (prefs.bottom.open) {
    if (prefs.bottom.maximized) {
      bottom = { shown: true, size: Math.max(0, availH) }
      editorHidden = true
    } else {
      const fitted = Math.min(bottom.size, availH - EDITOR_MIN_HEIGHT)
      bottom = fitted < PANEL_LIMITS.bottom.min ? { shown: false, size: bottom.size } : { shown: true, size: fitted }
    }
  }
  return {
    left: { shown: leftShown, size: leftShown ? L : clampPanel('left', prefs.left.size) },
    right: { shown: prefs.right.open, size: prefs.right.open ? R : clampPanel('right', prefs.right.size) },
    bottom,
    centerWidth,
    editorHidden,
    tooNarrow,
    leftHiddenByFit,
    terminalListCollapsed,
  }
}

/** 面板开着、点的就是当前视图就收起；否则打开并切到这个视图 */
export function toggleLeftView(prefs: CodingLayoutPrefs, view: LeftView): CodingLayoutPrefs {
  const open = !(prefs.left.open && prefs.left.view === view)
  return { ...prefs, left: { ...prefs.left, open, view } }
}
export function toggleRightView(prefs: CodingLayoutPrefs, view: RightView): CodingLayoutPrefs {
  const open = !(prefs.right.open && prefs.right.view === view)
  return { ...prefs, right: { ...prefs.right, open, view } }
}
/** 不传 tab 时只做开合 */
export function toggleBottomTab(prefs: CodingLayoutPrefs, tab?: BottomTab): CodingLayoutPrefs {
  if (!tab) return { ...prefs, bottom: { ...prefs.bottom, open: !prefs.bottom.open } }
  const open = !(prefs.bottom.open && prefs.bottom.tab === tab)
  return { ...prefs, bottom: { ...prefs.bottom, open, tab } }
}
