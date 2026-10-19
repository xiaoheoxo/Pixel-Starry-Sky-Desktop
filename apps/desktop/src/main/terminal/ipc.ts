import { app, BrowserWindow, clipboard, dialog, shell, webContents, type IpcMainInvokeEvent } from 'electron'
import * as ipc from '../ipc/guard'
import type { TerminalProfileInput } from '../../shared/types/terminal'
import type { WorkspaceRef } from '../../shared/types/workspace'
import { TerminalManager, type TerminalTarget } from './manager'
import { nativeText } from '../app/ui-language'
import type { Machines } from '../machines/service'
import { machineOf, argumentMachine } from '../machines/identity'
import { RemoteTerminals } from './remote'
import { sendTo } from '../app/rendererHealth'

let manager: TerminalManager | undefined
let remote: RemoteTerminals | undefined
const observed = new Set<number>()
/** 终端通道：窗口必须存在，但不要求窗口的 webContents 就是调用方（保持原有的校验强度）。 */
const terminalOnly = { looseOwner: true } as const
function ref(value: unknown): WorkspaceRef {
  const item = value as Partial<WorkspaceRef>
  // 附加文件夹编号（docs/ui/multi-root-projects.md §3.4）：只收 1–20 的整数
  const folder =
    Number.isInteger(item?.folder) && item.folder! >= 1 && item.folder! <= 20 ? { folder: item.folder } : {}
  if (typeof item?.projectId === 'string' && item.projectId) return { projectId: item.projectId, ...folder }
  if (typeof item?.sessionId === 'string' && item.sessionId) return { sessionId: item.sessionId, ...folder }
  throw new Error('请先选择项目')
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 160) throw new Error('终端请求不正确')
  return value
}
export async function initTerminalIpc(
  machines: Machines | null,
  resolve: (ref: WorkspaceRef) => TerminalTarget,
): Promise<() => Promise<void>> {
  const service = new TerminalManager(app.getPath('userData'), resolve, (owner, event) => {
    const target = webContents.fromId(owner)
    if (target) sendTo(target, 'terminal:event', event)
  })
  manager = service
  await service.init()
  // 后台检测完 Shell 列表后通知所有碰过终端通道的窗口重新取一次状态
  service.onProfilesChanged(() => {
    for (const owner of observed) {
      const target = webContents.fromId(owner)
      if (target) sendTo(target, 'terminal:event', { type: 'profiles' })
    }
  })
  if (machines) {
    remote = new RemoteTerminals(machines, app.getPath('userData'), (owner, event) => {
      const target = webContents.fromId(owner)
      if (target) sendTo(target, 'terminal:event', event)
    })
    await remote.init()
  }
  const handle = (name: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
    ipc.handle(
      `terminal:${name}` as ipc.InvokeChannel,
      async (event, ...args) => {
        if (!observed.has(event.sender.id)) {
          const owner = event.sender.id
          observed.add(owner)
          const cleanup = (): void => {
            void service.shutdown(owner).catch(console.error)
            void remote?.shutdown(owner).catch(console.error)
          }
          event.sender.on('render-process-gone', cleanup)
          event.sender.on('did-start-navigation', (_event, _url, _inPlace, isMain) => {
            if (isMain) cleanup()
          })
          event.sender.once('destroyed', () => {
            observed.delete(owner)
            cleanup()
          })
        }
        // 设置页的「刷新」：重新检测一遍再返回（异步，不卡主进程）
        if (name === 'state' && args[0] === true) await service.refresh()
        if (remote) {
          const id = argumentMachine(args),
            active = machines?.currentId ?? 'local',
            owner = event.sender.id
          if (name === 'state') {
            const local = service.state(owner),
              ssh = remote.state(owner)
            return { ...(active === 'local' ? local : ssh), terminals: [...local.terminals, ...ssh.terminals] }
          }
          if (id) {
            if (name === 'create') return remote.create(owner, ref(args[0]), args[1], args[2])
            if (name === 'write') return remote.write(owner, args[0], args[1], args[2])
            if (name === 'resize') return remote.resize(owner, args[0], args[1], args[2], args[3])
            if (name === 'rename') return remote.rename(owner, args[0], args[1])
            if (name === 'close' || name === 'restart')
              return remote.change(owner, args[0], name === 'restart', args[1] === true)
          }
          if (
            active !== 'local' &&
            ['setDefaultProfile', 'saveProfile', 'removeProfile', 'resetProfiles', 'chooseProgram'].includes(name)
          )
            throw new Error('SSH_SHELL_MANAGED_REMOTELY')
        }
        return fn(event, ...args)
      },
      terminalOnly,
    )
  }
  handle('state', e => service.state(e.sender.id))
  handle('setDefaultProfile', (e, value) => service.setDefault(e.sender.id, id(value)))
  handle('saveProfile', (e, input: TerminalProfileInput) => service.saveProfile(e.sender.id, input))
  handle('removeProfile', (e, value) => service.removeProfile(e.sender.id, id(value)))
  handle('resetProfiles', e => service.removeProfile(e.sender.id))
  handle('chooseProgram', async e => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    const result = await dialog.showOpenDialog(win, {
      title: nativeText(win, '选择 Shell 程序'),
      properties: ['openFile'],
      ...(process.platform === 'win32' && { filters: [{ name: 'Shell', extensions: ['exe'] }] }),
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle('create', (e, workspace, profileId, requestId) =>
    service.create(e.sender.id, ref(workspace), profileId === undefined ? undefined : id(profileId), id(requestId)),
  )
  handle('write', (e, key, gen, data) => service.write(e.sender.id, id(key), gen, data))
  handle('resize', (e, key, gen, cols, rows) => service.resize(e.sender.id, id(key), gen, cols, rows))
  ipc.on(
    'terminal:ack',
    (e, key, gen, seq) => {
      if (typeof key === 'string' && Number.isInteger(gen) && Number.isInteger(seq)) {
        if (machineOf(key) !== 'local') remote?.ack(e.sender.id, key, gen, seq)
        else service.ack(e.sender.id, key, gen, seq)
      }
    },
    terminalOnly,
  )
  ipc.on(
    'terminal:focused',
    (e, value) => {
      if (typeof value === 'boolean') e.sender.setIgnoreMenuShortcuts(value)
    },
    terminalOnly,
  )
  handle('rename', (e, key, title) => service.rename(e.sender.id, id(key), title))
  handle('close', (e, key, force) => service.change(e.sender.id, id(key), false, force === true))
  handle('restart', (e, key, force) => service.change(e.sender.id, id(key), true, force === true))
  handle('clipboardRead', () => clipboard.readText())
  handle('clipboardWrite', (_e, value: unknown) => {
    if (typeof value !== 'string' || value.length > 2_000_000) throw new Error('终端输入过长')
    clipboard.writeText(value)
  })
  handle('openLink', (_e, value: unknown) => {
    if (typeof value !== 'string' || value.length > 8192 || !/^https?:\/\//i.test(value)) throw new Error('链接不正确')
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('链接不正确')
    return shell.openExternal(url.href)
  })
  return async () => {
    await service.shutdown()
    await remote?.shutdown()
  }
}
/** 删除副本前关掉工作目录在其中的终端（project-tools-ipc 用） */
export async function stopTerminalsUnder(path: string): Promise<void> {
  await manager?.stopUnder(path)
}
export async function confirmTerminalClose(win: BrowserWindow): Promise<boolean> {
  if (!manager?.hasRunning(win.webContents.id) && !remote?.hasRunning(win.webContents.id)) return true
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    title: nativeText(win, '终端仍在运行'),
    message: nativeText(win, '退出会结束本窗口的终端及其前台子进程。'),
    buttons: [nativeText(win, '取消'), nativeText(win, '结束终端并退出')],
    defaultId: 0,
    cancelId: 0,
  })
  return result.response === 1
}
export async function closeWindowTerminals(win: BrowserWindow): Promise<void> {
  await manager?.shutdown(win.webContents.id)
  await remote?.shutdown(win.webContents.id)
}
