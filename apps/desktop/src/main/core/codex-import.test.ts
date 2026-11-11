import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { EngineHost } from '@pixelsky/engine'
import { importCodexWorkspace } from './codex-import'
import { translateMessage } from '../../shared/i18n/translate'

let root: string
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

it('从自定义 CODEX_HOME 登记已有项目再读取会话，来源清单和工具设置原样保留', async () => {
  // realpath：Windows 的临时目录可能是短路径（ADMINI~1），登记项目时会换成完整路径
  root = await realpath(await mkdtemp(join(tmpdir(), 'pixelsky-codex-import-')))
  const home = join(root, 'codex')
  const project = join(root, 'project')
  await mkdir(home)
  await mkdir(project)
  const manifest = join(home, '.codex-global-state.json')
  const config = join(home, 'config.toml')
  const content = JSON.stringify({
    'electron-saved-workspace-roots': [project],
    'local-projects': { p: { rootPaths: [project] } },
    'projectless-thread-ids': ['chat'],
    'thread-project-assignments': {
      assigned: { projectKind: 'local', projectId: 'p' },
      migrated: { projectKind: 'local', projectId: 'new-p' },
      foreign: { projectKind: 'local', projectId: 'other-p' },
    },
    'app-server-project-id-by-legacy-project-id-by-host': {
      [`local:${home}`]: { p: 'new-p' },
      [`local:${join(root, 'another-home')}`]: { p: 'other-p' },
    },
    preferences: { keep: true },
  })
  await writeFile(manifest, content)
  await writeFile(config, 'model = "original-model"\n')
  const calls: string[] = []
  const addProjects = vi.fn((paths: string[]) => {
    calls.push('projects')
    return { added: paths.map(path => ({ path })), existing: [], failed: [] }
  })
  const importCodexSessions = vi.fn(async () => {
    calls.push('sessions')
    return { groups: [], failed: [] }
  })
  const host = { projects: () => [], addProjects, importCodexSessions } as unknown as EngineHost
  const result = await importCodexWorkspace(host, { CODEX_HOME: home }, root)
  expect(calls).toEqual(['projects', 'sessions'])
  expect(addProjects.mock.calls[0][0]).toEqual([project])
  expect(result.addedProjects).toBe(1)
  expect(importCodexSessions).toHaveBeenCalledWith({
    projectless: ['chat'],
    projectRoots: { assigned: [project], migrated: [project] },
  })
  expect(await readFile(manifest, 'utf8')).toBe(content)
  expect(await readFile(config, 'utf8')).toBe('model = "original-model"\n')
})

it('清单缺失或损坏仍读取独立会话；缺失目录不创建、不搬动', async () => {
  // realpath：Windows 的临时目录可能是短路径（ADMINI~1），登记项目时会换成完整路径
  root = await realpath(await mkdtemp(join(tmpdir(), 'pixelsky-codex-import-')))
  const addProjects = vi.fn(() => ({ added: [], existing: [], failed: [] }))
  const importCodexSessions = vi.fn(async () => ({ groups: [], failed: [] }))
  const host = { projects: () => [], addProjects, importCodexSessions } as unknown as EngineHost
  await importCodexWorkspace(host, { CODEX_HOME: root }, root)
  await writeFile(join(root, '.codex-global-state.json'), '{broken')
  const result = await importCodexWorkspace(host, { CODEX_HOME: root }, root)
  expect(result.warnings).toHaveLength(1)
  expect(importCodexSessions).toHaveBeenCalledTimes(2)
  // 两条提示的原文在词典里对得上：英文界面能翻译
  expect(translateMessage(result.warnings[0], 'en-US')).toMatch(/^Could not read the Codex project list/)
  const gone = join(root, 'gone')
  await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({ 'electron-saved-workspace-roots': [gone] }))
  const missing = await importCodexWorkspace(host, { CODEX_HOME: root }, root)
  expect(addProjects).not.toHaveBeenCalled()
  expect(missing.warnings.map(w => translateMessage(w, 'en-US'))).toEqual([`Codex project folder unavailable: ${gone}`])
})
