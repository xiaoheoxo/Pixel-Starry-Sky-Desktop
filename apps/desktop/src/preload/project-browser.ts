import type { WorkspaceRef } from '../shared/types/workspace'
import type { BrowserAnnotation, BrowserShortcut, BrowserState } from '../shared/types/project-browser'

export interface PickConfigInput {
  theme: Record<string, string>
  text: Record<string, string>
}

export interface BrowserBridge {
  state(ref: WorkspaceRef): Promise<BrowserState>
  navigate(ref: WorkspaceRef, id: string | null, url: string): Promise<BrowserState>
  select(ref: WorkspaceRef, id: string | null): Promise<BrowserState>
  action(
    ref: WorkspaceRef,
    id: string,
    action: 'back' | 'forward' | 'reload' | 'hardReload' | 'stop' | 'close',
  ): Promise<BrowserState>
  /**
   * 网页视图放在哪（null：藏起来）。freeze：因为被弹出层挡住才藏，先截一张图返回（snapshot），界面拿它顶替；
   * 没在显示或截不到时 snapshot 是 null
   */
  viewport(
    ref: WorkspaceRef,
    bounds: { x: number; y: number; width: number; height: number } | null,
    opts?: { freeze?: boolean },
  ): Promise<{ snapshot: string | null } | void>
  /** extra：点选元素批注的字段（「放回列表」时带回），主进程重新校验 */
  annotate(ref: WorkspaceRef, id: string, text: string, extra?: Partial<BrowserAnnotation>): Promise<BrowserState>
  /** 开 / 关点选元素；config 是界面当前主题色和小框文案（注入网页的脚本用） */
  pick(ref: WorkspaceRef, id: string, on: boolean, config: PickConfigInput): Promise<BrowserState>
  removeAnnotation(ref: WorkspaceRef, id: string, annotationId: string): Promise<BrowserState>
  onChange(cb: (state: BrowserState) => void): () => void
  /** 网页有焦点时按的浏览器快捷键（主进程截下来转过来） */
  onKey(cb: (event: { scope: string; pageId: string; shortcut: BrowserShortcut }) => void): () => void
}
