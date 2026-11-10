import { stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { dataRoot } from '../app/data-dir'
import { Editors } from '../core/editors'
import * as ipc from '../ipc/guard'
import { WorkspaceFiles, locateFolder, workspacePath, workspaceRef, type TargetResolver } from '../core/workspace-files'
import type { AppContext } from '../app/context'
import { resolveWorkspace } from './resolve'
import { FILE_OPS } from '../core/workspace/ops'
import { opEntries } from '../core/ops'
import type { EditorKind, EditorState } from '../../shared/types/workspace'
import { nativeText } from '../app/ui-language'
import { memoryFile } from '../core/memory-files'
import { machineOf } from '../machines/identity'
import { sendTo } from '../app/rendererHealth'
import { createTreeWatcher } from './tree-watch'

export async function initWorkspace(ctx: AppContext): Promise<void> {
  const resolveTarget: TargetResolver = ref => resolveWorkspace(ctx, ref)
  // 文件树删除：移到系统回收站（docs/ui/files-search-terminal-pins.md §3）
  const files = new WorkspaceFiles(resolveTarget, {
    trash: absolute => shell.trashItem(absolute),
    attachmentDir: join(dataRoot(), 'attachments'),
  })
  void files.cleanExpiredStages().catch(() => {})
  const icons = new Map<string, string>()
  const editors = new Editors(app.getPath('userData'), resolveTarget, async path => {
    if (!icons.has(path)) icons.set(path, (await app.getFileIcon(path, { size: 'small' })).toDataURL())
    return icons.get(path)
  })
  await editors.init()
  const handle = (name: ipc.InvokeChannel, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
    ipc.handle(
      name,
      (e, ...args) =>
        ctx.machines && (name.startsWith('files:') || name === 'editor:open')
          ? ctx.machines.invoke(name, args, () => fn(e, ...args))
          : fn(e, ...args),
      { deny: '不允许的调用方' },
    )
  }
  for (const [channel, op] of opEntries(FILE_OPS)) {
    const run = (args: unknown[]) => op({ files }, ...args)
    ctx.toolOps.set(channel, run)
    handle(channel, (_e, ...args) => run(args))
  }
  handle('files:reveal', async (_e, ref, path = '') => {
    // 「::N/…」在附加文件夹里（docs/ui/multi-root-projects.md §3.4）
    const at = locateFolder(files.target(ref), path)
    const file = await workspacePath(at.root, at.rel)
    if (path) shell.showItemInFolder(file)
    else {
      const err = await shell.openPath(file)
      if (err) throw new Error('打不开项目目录：' + err)
    }
  })
  // 从系统拖进来＝复制进项目（docs/ui/file-tree-external-drop.md §3.1）：源路径在本机，远端项目第一版不做
  handle('files:import', async (_e, ref, folder, sources, confirmed) => {
    const valid = workspaceRef(ref)
    if (machineOf(valid.projectId ?? valid.sessionId) !== 'local') throw new Error('远端项目暂不支持从本机拖入')
    return files.importPaths(valid, folder, sources, confirmed === true)
  })
  handle('files:copyPath', async (_e, ref, path = '') => {
    const at = locateFolder(files.target(ref), path)
    clipboard.writeText(await workspacePath(at.root, at.rel))
  })
  handle('editor:state', (_e, force) => editors.state(force === true))
  // 默认打开方式、外部编辑器改了：告诉所有窗口重新取一次（设置可以开在独立窗口里，docs/ui/settings-window.md §4）
  const changed = (state: EditorState): EditorState => {
    ctx.events.broadcast('editor:changed')
    return state
  }
  handle('editor:preferences', async (_e, patch) => changed(await editors.preferences(patch)))
  handle('editor:remove', async (_e, id) => {
    if (typeof id !== 'string') throw new Error('编辑器 ID 不正确')
    return changed(await editors.remove(id))
  })
  handle('editor:choose', async (e, kind: EditorKind, name?: string, mode?: 'code' | 'folder') => {
    if (!['vscode', 'cursor', 'windsurf', 'trae-cn', 'trae', 'jetbrains', 'custom'].includes(kind))
      throw new Error('未知编辑器')
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 60))
      throw new Error('编辑器名称不正确')
    if (mode !== undefined && mode !== 'code' && mode !== 'folder') throw new Error('打开方式不正确')
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: nativeText(win, '选择编辑器程序'),
      filters: [{ name: nativeText(win, '程序'), extensions: process.platform === 'win32' ? ['exe'] : ['*'] }],
      properties: ['openFile' as const],
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths[0]) return null
    return changed(await editors.configure(kind, result.filePaths[0], name, mode))
  })
  handle('editor:open', (_e, ref, id, path, line, col) => editors.open(workspaceRef(ref), id, path, line, col))
  // 上下文明细里项目外的记忆文件（docs/ui/context-window.md §7）：只开本机会话诊断里列出的文件；
  // 有默认编辑器就用它打开，没有用系统默认程序；reveal 在文件夹里显示
  // 回复里链接到项目外的本机路径（docs/ui/path-click.md）：只看存不存在、在文件夹中显示，不打开、不执行。
  // \\主机\共享 这类网络路径不碰：光是查一下存不存在，系统就会去连那台机器
  handle('editor:statOutside', async (_e, path: unknown) => {
    const file = outsidePath(path)
    const info = await stat(file).catch(() => null)
    return info ? (info.isDirectory() ? 'folder' : 'file') : null
  })
  handle('editor:revealOutside', async (_e, path: unknown) => {
    const file = outsidePath(path)
    if (!(await stat(file).catch(() => null))) throw new Error('找不到这个路径：' + file)
    shell.showItemInFolder(file)
  })
  handle('editor:openMemory', async (_e, sessionId: unknown, path: unknown, action: unknown) => {
    if (typeof sessionId !== 'string' || machineOf(sessionId) !== 'local') throw new Error('只能打开本机上的记忆文件')
    // 诊断只在载入的会话内存里：没载入就没有列出的文件，不为它整份载入
    const listed = ctx.engine?.loaded(sessionId)?.context?.diagnostic?.memory ?? []
    const file = await memoryFile(listed, path)
    if (action === 'reveal') return void shell.showItemInFolder(file)
    if (await editors.openFile(file)) return
    const err = await shell.openPath(file)
    if (err) throw new Error('打不开这个文件：' + err)
  })
  initTreeWatch(files)
}

/**
 * 文件树自动刷新（docs/ui/file-tree-auto-refresh.md §2 B）：看得见、展开着的本机项目根订阅目录监听，变化只推给订阅的窗口。
 * 远端机器、Linux（递归监听要走遍整棵树）、网络路径不监听，回 false，树照旧按焦点 / 一轮结束刷新
 */
function initTreeWatch(files: WorkspaceFiles): void {
  const watcher = createTreeWatcher()
  const pages = new Map<WebContents, { subs: Map<number, () => void>; detach: () => void }>()
  const drop = (contents: WebContents): void => {
    const page = pages.get(contents)
    if (!page) return
    pages.delete(contents)
    for (const stop of page.subs.values()) stop()
    page.detach()
  }
  ipc.handle('files:watch', (e, id: unknown, ref: unknown) => {
    if (!Number.isSafeInteger(id)) throw new Error('监听编号不正确')
    const contents = e.sender
    const key = id as number
    pages.get(contents)?.subs.get(key)?.()
    pages.get(contents)?.subs.delete(key)
    if (ref == null) return false
    const valid = workspaceRef(ref)
    if (process.platform === 'linux' || machineOf(valid.projectId ?? valid.sessionId) !== 'local') return false
    const target = files.target(valid)
    const roots = [
      { path: target.path, prefix: '' },
      ...(target.folders ?? []).map((f, i) => ({ path: f.path, prefix: `::${i + 1}` })),
    ].filter(r => !/^[\\/]{2}/.test(r.path))
    if (!roots.length) return false
    let page = pages.get(contents)
    if (!page) {
      // 页面重新加载或崩溃后页面里已经没有监听：全部退订，树挂上时会重新订阅
      const onNavigate = (_event: unknown, _url: string, _inPlace: boolean, isMain: boolean): void => {
        if (isMain) drop(contents)
      }
      const gone = (): void => drop(contents)
      contents.on('did-start-navigation', onNavigate)
      contents.on('render-process-gone', gone)
      contents.on('destroyed', gone)
      page = {
        subs: new Map(),
        detach: () => {
          if (contents.isDestroyed()) return
          contents.removeListener('did-start-navigation', onNavigate)
          contents.removeListener('render-process-gone', gone)
          contents.removeListener('destroyed', gone)
        },
      }
      pages.set(contents, page)
    }
    page.subs.set(
      key,
      watcher.subscribe(roots, change => sendTo(contents, 'files:changed', key, change)),
    )
    return true
  })
}

/** 项目外路径的参数检查：本机绝对路径；网络路径（\\主机\共享、//主机/共享）不收 */
export function outsidePath(path: unknown): string {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) throw new Error('路径不正确')
  if (/^[\\/]{2}/.test(path) || !isAbsolute(path)) throw new Error('只能是本机上的完整路径')
  return resolve(path)
}
