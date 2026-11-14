export type ProjectImportTool = 'claude' | 'codex' | 'zcode' | 'kimi' | 'cursor' | 'dsh' | 'antigravity' | 'grok'
/** Antigravity 没有能选的文件（会话记录加密，项目路径问 agy 自己），不能手动选 */
export type ProjectImportPicker = Exclude<ProjectImportTool, 'antigravity'> | 'folders' | 'parent' | 'paths'

export interface ProjectImportCandidate {
  /** 规范化的实际路径，同时用作候选项 ID。 */
  path: string
  name: string
  sources: string[]
  project: boolean
  added: boolean
  issue?: 'invalid' | 'missing' | 'notDirectory' | 'unreadable'
}

export interface ProjectImportBatch {
  candidates: ProjectImportCandidate[]
  warnings: string[]
}
