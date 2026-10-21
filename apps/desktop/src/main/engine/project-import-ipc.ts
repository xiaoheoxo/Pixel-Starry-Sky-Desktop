import { BrowserWindow, dialog } from 'electron'
import { isAbsolute } from 'node:path'
import type { EngineHost } from '@pixelsky/engine'
import type { ProjectImportPicker, ProjectImportTool } from '../../shared/types/project-import'
import { selectedMachine, type AppContext } from '../app/context'
import { nativeText } from '../app/ui-language'
import * as ipc from '../ipc/guard'
import { listImportCandidates } from '../core/importProjects'
import {
  discoverToolProjects,
  inspectProjectPaths,
  parsePathList,
  readImportFile,
  readToolProjects,
  type ImportPath,
} from '../core/project-import'

export function initProjectImport(ctx: AppContext, host: EngineHost): void {
  const known = (): string[] => {
    if (selectedMachine(ctx) !== 'local') throw new Error('请切换到本机后导入项目')
    return host.projects().map(p => p.path)
  }
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    ...host.engineConfig().claude.env,
    ...host.engineConfig().codex.env,
  })
  ipc.handle('projectImport:scan', () => discoverToolProjects(known(), undefined, env()))
  ipc.handle('projectImport:paths', (_event, value: unknown) => {
    const projects = known()
    if (typeof value !== 'string') throw new Error('项目路径清单不正确')
    return inspectProjectPaths(
      parsePathList(value).map(path => ({ path, source: 'Paths' })),
      projects,
    )
  })
  ipc.handle('projectImport:choose', async (event, raw: unknown) => {
    known()
    const kinds: ProjectImportPicker[] = [
      'folders',
      'parent',
      'paths',
      'claude',
      'codex',
      'zcode',
      'kimi',
      'cursor',
      'dsh',
    ]
    if (!kinds.includes(raw as ProjectImportPicker)) throw new Error('项目清单来源不正确')
    const kind = raw as ProjectImportPicker
    const folders = kind === 'folders' || kind === 'parent'
    // Cursor 每个项目一个文件，选 workspaceStorage 文件夹（或它的上级）
    const cursor = kind === 'cursor'
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: nativeText(
        win,
        folders ? '选择项目文件夹' : cursor ? '选择 Cursor 的 workspaceStorage 文件夹' : '手动选择清单',
      ),
      properties: folders ? ['openDirectory', 'multiSelections'] : cursor ? ['openDirectory'] : ['openFile'],
      ...(folders || cursor
        ? {}
        : {
            filters: [
              {
                name: 'Project lists',
                extensions: kind === 'zcode' ? ['json', 'sqlite', 'db'] : kind === 'paths' ? ['txt', 'json'] : ['json'],
              },
            ],
          }),
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return null
    // 原生选择器打开期间可能切换机器；继续前再次检查。
    const projects = known()
    const paths: ImportPath[] = [],
      warnings: string[] = []
    for (const file of result.filePaths) {
      if (!isAbsolute(file)) throw new Error('项目清单路径不正确')
      if (kind === 'folders') paths.push({ path: file, source: 'Folders' })
      else if (kind === 'parent') {
        const batch = await listImportCandidates(file, projects)
        paths.push(...batch.candidates.map(c => ({ path: c.path, source: file, project: c.project })))
        if (batch.truncated) warnings.push(`子文件夹过多，仅预览前 ${batch.candidates.length} 个：${file}`)
      } else if (kind === 'paths') {
        paths.push(...parsePathList(await readImportFile(file)).map(path => ({ path, source: 'Paths' })))
      } else {
        const batch = await readToolProjects(kind as ProjectImportTool, file, env())
        paths.push(...batch.paths)
        warnings.push(...batch.warnings)
      }
    }
    return { ...(await inspectProjectPaths(paths, projects)), warnings }
  })
}
