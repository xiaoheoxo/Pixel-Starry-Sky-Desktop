import type {
  WorkspaceRef,
  WorkspaceTarget,
  DirectoryListing,
  FileDocument,
  GrepResult,
  EditorKind,
  EditorState,
} from '../shared/types/workspace'

export interface FilesBridge {
  target(ref: WorkspaceRef): Promise<WorkspaceTarget>
  list(ref: WorkspaceRef, path: string): Promise<DirectoryListing>
  /** 同 list，目录不存在时返回 null 而不是报错（路径链接、@ 菜单问一下有没有用） */
  listExisting(ref: WorkspaceRef, path: string): Promise<DirectoryListing | null>
  search(ref: WorkspaceRef, name: string): Promise<DirectoryListing>
  /** 内容搜索（docs/ui/files-search-terminal-pins.md §2） */
  grep(ref: WorkspaceRef, query: string): Promise<GrepResult>
  /** 新建空文件 / 文件夹，返回相对项目的路径 */
  create(ref: WorkspaceRef, path: string, kind: 'file' | 'folder'): Promise<{ path: string }>
  /** 项目内重命名或移动，返回新的相对路径 */
  rename(ref: WorkspaceRef, from: string, to: string): Promise<{ path: string }>
  /** 移到回收站 */
  remove(ref: WorkspaceRef, path: string): Promise<void>
  status(ref: WorkspaceRef): Promise<Record<string, string>>
  read(ref: WorkspaceRef, path: string): Promise<FileDocument>
  headContent(ref: WorkspaceRef, path: string): Promise<string | null>
  save(
    ref: WorkspaceRef,
    path: string,
    content: string,
    version: string,
  ): Promise<Extract<FileDocument, { kind: 'text' }>>
  reveal(ref: WorkspaceRef, path?: string): Promise<void>
  copyPath(ref: WorkspaceRef, path?: string): Promise<void>
  onBeforeClose(cb: () => void): () => void
  finishClose(): Promise<void>
}
export interface EditorBridge {
  state(force?: boolean): Promise<EditorState>
  preferences(patch: {
    defaultId?: string | null
    openWith?: string
    window?: 'reuse' | 'new'
    /** 「打开方式」按钮直接点时用哪个（编辑器或程序的 id） */
    workspaceId?: string | null
  }): Promise<EditorState>
  choose(kind: EditorKind, name?: string, mode?: 'code' | 'folder'): Promise<EditorState | null>
  remove(id: string): Promise<EditorState>
  /** 别的窗口改了默认打开方式、外部编辑器：重新取一次状态 */
  onChanged(callback: () => void): () => void
  open(
    ref: WorkspaceRef,
    editorId?: string,
    path?: string,
    line?: number,
    column?: number,
  ): Promise<{ editor: string; target: string }>
  /** 上下文明细里项目外的记忆文件：用默认编辑器（没有时用系统默认程序）打开，或在文件夹里显示。只认会话诊断里列出的路径 */
  openMemory(sessionId: string, path: string, action?: 'open' | 'reveal'): Promise<void>
  /** 回复里链接到项目外的本机路径：是文件、文件夹还是不存在（不读内容） */
  statOutside(path: string): Promise<'file' | 'folder' | null>
  /** 项目外的本机路径在系统文件夹中显示（不打开文件） */
  revealOutside(path: string): Promise<void>
}
