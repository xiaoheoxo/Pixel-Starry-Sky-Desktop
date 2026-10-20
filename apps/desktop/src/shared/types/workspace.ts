/**
 * 项目或会话。folder：多文件夹项目的第 N 个附加文件夹（从 1 开始，docs/ui/multi-root-projects.md §3.4），
 * 这时工作区就是那个文件夹（Git 面板按它找仓库）；不写就是主文件夹
 */
export type WorkspaceRef =
  | { sessionId: string; projectId?: never; folder?: number }
  | { projectId: string; sessionId?: never; folder?: number }
export type FileStageRequest =
  | { action: 'begin'; id: string; name: string; bytes: number }
  | { action: 'chunk'; id: string; offset: number; dataBase64: string }
  | { action: 'finish'; id: string }
  | { action: 'cancel'; id: string }
  /** 从输入框移除附件时删掉它的暂存副本；path 是 finish 返回的路径 */
  | { action: 'remove'; path: string }
export interface FileStageResult {
  path?: string
}
export interface WorkspaceTarget {
  ref: WorkspaceRef
  name: string
  /** 主文件夹 */
  path: string
  /**
   * 多文件夹项目的附加文件夹（docs/ui/multi-root-projects.md §3.4）。文件接口里「::1/src/a.ts」指第 1 个附加文件夹里的
   * src/a.ts，不带前缀的路径在主文件夹里；没有附加文件夹时不写
   */
  folders?: { path: string; name: string }[]
}
/** 「从一个文件夹导入…」列出的一个子文件夹（docs/ui/multi-root-projects.md §2） */
export interface ImportCandidate {
  name: string
  path: string
  /** 里面有 .git、package.json 之类，默认勾上 */
  project: boolean
  /** 已经是项目 */
  added: boolean
}
export interface ImportCandidates {
  parent: string
  candidates: ImportCandidate[]
  /** 子文件夹太多，只列了前面一部分 */
  truncated: boolean
}
/** 文件树状态码：被 .gitignore 等规则忽略（只变暗，不算改动） */
export const IGNORED_STATUS = 'I'
/** FileEntry.status / files:status 的值：M 修改、A 新增、D 删除、R 重命名、? 未跟踪、! 冲突、• 里面有改动（仅文件夹）、I 被忽略 */
export interface FileEntry {
  name: string
  path: string
  kind: 'directory' | 'file'
  status?: string
  linked?: boolean
}
export interface DirectoryListing {
  entries: FileEntry[]
  truncated: boolean
}
/** 项目文件内容搜索的一条命中（docs/ui/files-search-terminal-pins.md §2） */
export interface GrepMatch {
  /** 相对项目，用 / 分隔 */
  path: string
  line: number
  column: number
  /** 这一行的内容（过长时截断） */
  text: string
}
export interface GrepResult {
  matches: GrepMatch[]
  truncated: boolean
}
export type FileDocument =
  | {
      kind: 'text'
      path: string
      content: string
      version: string
      bytes: number
      bom: boolean
      newline: 'lf' | 'crlf'
      readonly?: boolean
    }
  | { kind: 'image'; path: string; dataUrl: string; bytes: number }
  | { kind: 'unsupported'; path: string; reason: string; bytes: number }
export type EditorKind = 'vscode' | 'cursor' | 'windsurf' | 'trae-cn' | 'trae' | 'jetbrains' | 'custom'
export interface EditorItem {
  id: string
  name: string
  kind: EditorKind
  path: string
  /** code：VS Code 一类（--reuse-window、--goto）；jetbrains：IntelliJ 一类（--line、--column）；folder：只传路径 */
  mode: 'code' | 'jetbrains' | 'folder'
  available: boolean
  manual: boolean
  version?: string
  source?: 'shortcut' | 'location' | 'path' | 'manual'
  icon?: string
}
export interface EditorState {
  items: EditorItem[]
  defaultId: string | null
  openWith: string
  window: 'reuse' | 'new'
  checkedAt: number
  /** 「打开方式」里编辑器以外的程序（GitHub #12）：文件资源管理器、Git Bash、终端；只列本机装了的 */
  tools: OpenTool[]
  /** 「打开方式」按钮直接点时用哪个（编辑器或程序的 id）；没选过时为 null，用默认编辑器 */
  workspaceId: string | null
}
export type OpenToolId =
  | 'explorer'
  | 'git-bash'
  | 'windows-terminal'
  | 'pwsh'
  | 'powershell'
  /** macOS 的「终端」、Linux 的默认终端 */
  | 'terminal'
  | 'iterm'
export interface OpenTool {
  id: OpenToolId
  name: string
  path: string
}
