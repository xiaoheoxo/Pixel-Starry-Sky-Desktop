// 导出对话（docs/ui/conversation-export.md）：渲染层交来写好的内容，这里弹系统保存对话框、写文件；只在本机
import { writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import * as ipc from '../ipc/guard'
import { nativeText } from '../app/ui-language'
import { EXPORT_KINDS, saveArgs } from './args'

export function initExport(): void {
  // 返回写入的完整路径；在保存对话框里取消返回 null
  ipc.handle('export:save', async (e, input) => {
    const { name, ext, content } = saveArgs(input)
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: nativeText(win, ext === 'txt' ? '保存终端输出' : '导出对话'),
      defaultPath: join(app.getPath('downloads'), `${name}.${ext}`),
      filters: [{ name: EXPORT_KINDS[ext], extensions: [ext] }],
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    const path = extname(r.filePath) ? r.filePath : `${r.filePath}.${ext}`
    await writeFile(path, content, 'utf8')
    return path
  })
}
