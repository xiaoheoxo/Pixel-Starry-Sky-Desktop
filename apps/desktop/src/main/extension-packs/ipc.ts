import { createRequire } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { codedError, EXT_MANIFEST } from '@pixelsky/protocol'
import type { ExtPackOptions } from '@pixelsky/protocol'
import { object, text } from '@pixelsky/engine'
import * as ipc from '../ipc/guard'
import { nativeText } from '../app/ui-language'
import type { AppContext } from '../app/context'
import { ExtensionPacks } from './service'
import { registerPackProtocol } from './protocol'
import { storeIcons } from './market/icons'

let wasm: Uint8Array | null = null

/** onig.wasm 的字节：先找 Vite 给渲染进程打出来的文件（asar 里），开发时退回 node_modules；不接受渲染进程给的路径 */
function onigWasmBytes(): Uint8Array {
  if (wasm) return wasm
  try {
    const dir = join(__dirname, '../renderer/assets')
    const name = readdirSync(dir).find(f => /^onig[-.\w]*\.wasm$/.test(f))
    if (name) return (wasm = new Uint8Array(readFileSync(join(dir, name))))
  } catch {
    // 找不到就走开发路径
  }
  try {
    const file = createRequire(__filename).resolve('vscode-oniguruma/release/onig.wasm')
    return (wasm = new Uint8Array(readFileSync(file)))
  } catch {
    throw codedError('extpacks.wasmMissing')
  }
}

const OVERRIDE_LIMIT = 40

function optionsPatch(raw: unknown): ExtPackOptions {
  const data = object(raw)
  const patch: ExtPackOptions = {}
  if (data.overrideBuiltin !== undefined) {
    const list = data.overrideBuiltin
    if (!Array.isArray(list) || list.length > OVERRIDE_LIMIT || list.some(v => typeof v !== 'string' || v.length > 200))
      throw codedError('extpacks.badRequest')
    patch.overrideBuiltin = list as string[]
  }
  return patch
}

/** 扩展包的主进程一侧：服务在 extension-packs/service.ts，资源协议在 protocol.ts */
export function initExtensionPacks(ctx: AppContext): ExtensionPacks {
  const service = new ExtensionPacks({
    dataDir: join(app.getPath('userData'), 'extension-packs'),
    builtinDir: app.isPackaged
      ? join(process.resourcesPath, 'builtin-extensions')
      : join(__dirname, '../../resources/builtin-extensions'),
    appVersion: app.getVersion(),
    removeIcons: id => storeIcons().remove(id),
  })
  ctx.extPacks = service
  service.onChange(() => ctx.events.broadcast('extpacks:changed'))
  service.start()
  registerPackProtocol(service)

  ipc.handle('extpacks:state', async () => {
    await service.builtinReady()
    return service.state()
  })
  ipc.handle('extpacks:addFolder', async (event, path: unknown) => {
    if (path === null || path === undefined) {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: nativeText(win, '选择扩展文件夹'),
        properties: ['openDirectory' as const],
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (r.canceled || !r.filePaths[0]) return null
      return service.addFolder(r.filePaths[0])
    }
    // 只有开发版接受渲染进程直接给的路径（端到端测试用）
    if (typeof path !== 'string' || app.isPackaged) throw codedError('extpacks.badRequest')
    return service.addFolder(path)
  })
  ipc.handle('extpacks:onigWasm', () => onigWasmBytes())
  ipc.handle('extpacks:setEnabled', async (_e, key: unknown, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw codedError('extpacks.badRequest')
    await service.setEnabled(text(key, 'key'), enabled)
  })
  ipc.handle('extpacks:remove', async (_e, key: unknown) => {
    await service.remove(text(key, 'key'))
  })
  ipc.handle('extpacks:reload', async (_e, key: unknown) => {
    await service.reload(key === null || key === undefined ? null : text(key, 'key'))
  })
  ipc.handle('extpacks:setOptions', async (_e, key: unknown, patch: unknown) => {
    await service.setOptions(text(key, 'key'), optionsPatch(patch))
  })
  ipc.handle('extpacks:readJson', (_e, key: unknown, path: unknown) =>
    service.readJson(text(key, 'key'), text(path, 'path')),
  )
  ipc.handle('extpacks:readText', (_e, key: unknown, path: unknown) =>
    service.readText(text(key, 'key'), text(path, 'path')),
  )
  ipc.handle('extpacks:reveal', (_e, key: unknown) => {
    shell.showItemInFolder(join(service.location(text(key, 'key')), EXT_MANIFEST))
  })
  return service
}
