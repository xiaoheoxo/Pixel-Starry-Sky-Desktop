// 设置 › 存储 › 数据位置的主进程一侧（docs/ui/data-location.md §5）：选文件夹、检查、排好搬家后重启、删旧数据
import { dirname } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { logger } from '@pixelsky/engine'
import * as ipc from '../ipc/guard'
import type { DataLocationChoice, DataLocationInfo } from '../../shared/types/data-location'
import { checkTarget, hasDataAt, measure, removeData, samePath } from './data-location'
import { cancelMove, dataPointer, dataRoot, forgetPrevious, scheduleMove, useExisting } from './data-dir'
import { nativeText } from './ui-language'

const log = logger('data-location')

export function initDataLocation(restart: () => void): void {
  const info = (): DataLocationInfo => {
    const p = dataPointer()
    return {
      path: dataRoot(),
      // 只在 Windows 上提示「在 C 盘的 AppData 里」
      inAppData: process.platform === 'win32' && samePath(dataRoot(), app.getPath('userData')),
      previous: p?.previous ?? null,
      error: p?.error ?? null,
      pending: p?.move?.to ?? null,
    }
  }
  /** 检查通过的目标：move 只认这个，渲染进程不能随便传一个路径进来 */
  let checked: string | null = null
  /** 检查时发现已经有像素星空数据的文件夹：use 只认这个 */
  let existing: string | null = null

  ipc.handle('dataLocation:info', () => info())

  ipc.handle('dataLocation:choose', async (event): Promise<DataLocationChoice> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const opts = {
      title: nativeText(win, '选择数据位置'),
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const path = result.filePaths[0]
    if (result.canceled || !path) return { kind: 'cancelled' }
    const { bytes } = await measure(dataRoot())
    const problem = await checkTarget(path, { current: dataRoot(), installDir: dirname(process.execPath), need: bytes })
    if (problem === 'hasData' && hasDataAt(path)) {
      existing = path
      return { kind: 'existing', path }
    }
    if (problem) return { kind: 'problem', problem, path }
    checked = path
    return { kind: 'ready', path, bytes }
  })

  ipc.handle('dataLocation:move', async (_event, path: unknown) => {
    if (typeof path !== 'string' || !checked || path !== checked) throw new Error('请先选择并检查文件夹')
    await scheduleMove(path)
    log.info('排好搬家，重启', { from: dataRoot(), to: path })
    restart()
  })

  ipc.handle('dataLocation:use', async (_event, path: unknown) => {
    if (typeof path !== 'string' || !existing || path !== existing) throw new Error('请先选择并检查文件夹')
    await useExisting(path)
    log.info('接回已有的数据，重启', { from: dataRoot(), to: path })
    restart()
  })

  ipc.handle('dataLocation:cancelMove', () => cancelMove())

  ipc.handle('dataLocation:removeOld', async () => {
    const old = dataPointer()?.previous
    if (!old || samePath(old, dataRoot())) return forgetPrevious()
    await removeData(old, p => shell.trashItem(p))
    log.info('删除旧位置的数据', { old })
    await forgetPrevious()
  })

  ipc.handle('dataLocation:dismiss', () => forgetPrevious())
}
