import type { WorkspaceRef } from '../shared/types/workspace'
import type { BrowserState } from '../shared/types/project-browser'

export interface BrowserBridge {
  state(ref: WorkspaceRef): Promise<BrowserState>
  navigate(ref: WorkspaceRef, id: string | null, url: string): Promise<BrowserState>
  select(ref: WorkspaceRef, id: string | null): Promise<BrowserState>
  action(ref: WorkspaceRef, id: string, action: 'back' | 'forward' | 'reload' | 'stop' | 'close'): Promise<BrowserState>
  /**
   * 网页视图放在哪（null：藏起来）。freeze：因为被弹出层挡住才藏，先截一张图返回（snapshot），界面拿它顶替；
   * 没在显示或截不到时 snapshot 是 null
   */
  viewport(
    ref: WorkspaceRef,
    bounds: { x: number; y: number; width: number; height: number } | null,
    opts?: { freeze?: boolean },
  ): Promise<{ snapshot: string | null } | void>
  annotate(ref: WorkspaceRef, id: string, text: string): Promise<BrowserState>
  removeAnnotation(ref: WorkspaceRef, id: string, annotationId: string): Promise<BrowserState>
  onChange(cb: (state: BrowserState) => void): () => void
}
