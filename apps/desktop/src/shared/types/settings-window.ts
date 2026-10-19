// 设置独立窗口（docs/ui/settings-window.md）：主进程和两种窗口之间传的东西
import type { WorkspaceRef } from './workspace'

/** 主窗口当前的工作区（插件页要用）；由主窗口报给主进程，再转给设置窗口 */
export interface SettingsWorkspace {
  ref: WorkspaceRef | null
  name: string
  path: string
  key: string
}

export interface SettingsWindowState {
  /** 设置窗口正开着 */
  open: boolean
  /** 置顶（作为主窗口的子窗口，总在它上面） */
  pinned: boolean
  /** 记住的打开方式：true 时从任何入口打开设置都是独立窗口，false 是浮层 */
  preferWindow: boolean
  workspace: SettingsWorkspace | null
}

/**
 * 打开设置前，主窗口里「先记一笔、设置页打开后取走」的那几处请求（models/scroll、extstore/nav、engines/nav、logs/focus、feedback/focus）
 * 都存在模块内存里，不会跨窗口；开独立窗口时随 settingsWindow:open 带过去，设置窗口收到后重新记一遍
 */
export interface SettingsHints {
  /** 滚到「菜单里显示的模型」 */
  modelsScroll?: true
  /** 扩展页停在哪个页签（不写是已安装） */
  extTab?: 'discover' | 'installed' | 'publish'
  /** 发现页搜索框拿焦点 */
  extSearch?: true
  /** 本机引擎页直接打开这个引擎的详情 */
  engineDetail?: string
  /** 日志页筛到这个会话、这个时间以后 */
  logFocus?: { sessionId: string; since: number }
  /** 反馈页打开那一条 / 带预填打开新反馈（FeedbackTarget） */
  feedback?: Record<string, unknown>
}

/** 要设置窗口跳到哪：分区，以及分区里要高亮的那一行（data-setting-title，当前界面语言的标题） */
export interface SettingsTarget {
  section?: string
  row?: string
  hints?: SettingsHints
}

/** 设置窗口请主窗口去做的事（主窗口原来的逻辑，经 mainWindow:run → mainWindow:action 转过去） */
export type MainWindowAction =
  | { kind: 'manageMachines' }
  | { kind: 'openSession'; sessionId: string }
  | { kind: 'openResume'; projectId: string; engine: 'claude' | 'codex' }
  | { kind: 'selectLocalMachine' }
  | { kind: 'terminalScript'; name: string; command: string }
