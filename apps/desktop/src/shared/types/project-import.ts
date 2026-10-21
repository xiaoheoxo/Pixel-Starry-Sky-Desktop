export type ProjectImportTool = 'claude' | 'codex' | 'zcode' | 'kimi' | 'cursor' | 'dsh'
export type ProjectImportPicker = ProjectImportTool | 'folders' | 'parent' | 'paths'

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
