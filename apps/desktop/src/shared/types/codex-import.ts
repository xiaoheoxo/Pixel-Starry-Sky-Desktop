import type { CodexSessionImportResult } from '@pixelsky/protocol'

export interface CodexWorkspaceImportResult extends CodexSessionImportResult {
  addedProjects: number
  warnings: string[]
}
