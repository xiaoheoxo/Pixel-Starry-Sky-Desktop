import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { EngineHost } from '@pixelsky/engine'
import type { CodexSessionAssignments } from '@pixelsky/protocol'
import type { CodexWorkspaceImportResult } from '../../shared/types/codex-import'
import {
  inspectProjectPaths,
  MAX_IMPORT_PATHS,
  readImportFile,
  toolProjectPaths,
  toolImportFiles,
  type ImportPath,
} from './project-import'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/** 明确的项目外标记优先于 cwd；工作树不在根目录下时仍沿用来源的项目归属。 */
function memberships(value: unknown, codexHome: string): Required<CodexSessionAssignments> {
  const data = object(value)
  const projects = object(data['local-projects'])
  const projectRoots: Record<string, string[]> = {}
  const rootsById = new Map(Object.entries(projects).map(([id, project]) => [id, strings(object(project).rootPaths)]))
  const homeKey = (path: string): string => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))
  for (const [host, mappings] of Object.entries(object(data['app-server-project-id-by-legacy-project-id-by-host']))) {
    if (!host.startsWith('local:') || homeKey(host.slice(6)) !== homeKey(codexHome)) continue
    for (const [oldId, id] of Object.entries(object(mappings))) {
      if (typeof id === 'string' && rootsById.has(oldId)) rootsById.set(id, rootsById.get(oldId)!)
    }
  }
  for (const [id, raw] of Object.entries(object(data['thread-project-assignments']))) {
    const entry = object(raw)
    if (entry.projectKind === 'local' && typeof entry.projectId === 'string') {
      const roots = rootsById.get(entry.projectId)
      if (roots?.length) projectRoots[id] = roots
    }
  }
  return { projectless: strings(data['projectless-thread-ids']), projectRoots }
}

/** 登记 Codex 已有的项目根目录，再统一读取线程；目录清单缺失不妨碍项目外会话。 */
export async function importCodexWorkspace(
  host: EngineHost,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<CodexWorkspaceImportResult> {
  const warnings: string[] = []
  const paths: ImportPath[] = []
  const assignments: Required<CodexSessionAssignments> = { projectless: [], projectRoots: {} }
  for (const file of toolImportFiles(home, env).codex) {
    try {
      const data: unknown = JSON.parse(await readImportFile(file))
      paths.push(...toolProjectPaths('codex', data).map(path => ({ path, source: 'Codex' })))
      const membership = memberships(data, dirname(file))
      assignments.projectless = [...assignments.projectless, ...membership.projectless]
      assignments.projectRoots = { ...assignments.projectRoots, ...membership.projectRoots }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        warnings.push('Codex 项目清单读取失败，仍会读取会话；可在下方手动登记项目')
    }
  }
  let addedProjects = 0
  for (let start = 0; start < paths.length; start += MAX_IMPORT_PATHS) {
    const inspected = await inspectProjectPaths(
      paths.slice(start, start + MAX_IMPORT_PATHS),
      host.projects().map(p => p.path),
    )
    const valid = inspected.candidates.filter(c => !c.issue && !c.added)
    if (valid.length) {
      const added = host.addProjects(valid.map(c => c.path))
      addedProjects += added.added.length
      warnings.push(...added.failed.map(f => `${f.path}：${f.error}`))
    }
    warnings.push(...inspected.candidates.filter(c => c.issue).map(c => `Codex 项目目录不可用：${c.path}`))
  }
  return { ...(await host.importCodexSessions(assignments)), addedProjects, warnings }
}
