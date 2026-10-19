import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 像素星空命令行（packages/cli）的入口，传给 EngineHost 的 pixelCli（适配器用 Electron 自带的 node 加 ELECTRON_RUN_AS_NODE 跑）。
 * - 开发：仓库源码 packages/cli/src/cli.ts（靠 Node 的类型剥离）
 * - 打包后：resources/pixel-cli/pixel.mjs（packages/cli/scripts/bundle.mjs 生成，extraResources，不在 asar 里）
 */
export function bundledPixelCli(): string | null {
  const entry = app.isPackaged
    ? join(process.resourcesPath, 'pixel-cli', 'pixel.mjs')
    : join(app.getAppPath(), '..', '..', 'packages', 'cli', 'src', 'cli.ts')
  return existsSync(entry) ? entry : null
}
