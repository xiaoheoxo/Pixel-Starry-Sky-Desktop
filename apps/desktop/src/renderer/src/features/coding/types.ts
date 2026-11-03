export type AppMode = 'chat' | 'code'
export type CodingPanel = 'left' | 'right' | 'bottom'
export type LeftView = 'files' | 'outline' | 'search' | 'git' | 'tasks' | 'conversations'
/** tasks / sandbox / copies 没有工具条按钮，只能通过事件、命令面板或运行组件打开 */
export type RightView = 'chat' | 'browser' | 'artifacts' | 'notifications' | 'tasks' | 'sandbox' | 'copies'
export type BottomTab = 'terminal' | 'aiCommands' | 'output' | 'problems' | 'ports'
export type EditorViewMode = 'preview' | 'code' | 'diff' | 'split'
export type DiffBase = 'head' | 'turn'
export interface PanelPrefs {
  open: boolean
  size: number
}
export interface CodingLayoutPrefs {
  left: PanelPrefs & { view: LeftView }
  right: PanelPrefs & { view: RightView }
  bottom: PanelPrefs & { tab: BottomTab; maximized: boolean }
}
/** 演示会话 id，mock/coding.ts 里写同一个字面量（mock 不能引 features） */
export const CODING_DEMO_SESSION_ID = 'demo-coding-v3'
