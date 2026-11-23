import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export function bundledAgnesDispatch(): string | null {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'agnes-dispatch')
    : join(app.getAppPath(), '..', '..', 'packages', 'engine', 'assets', 'agnes-dispatch')
  return existsSync(join(root, '.codex-plugin', 'plugin.json')) ? root : null
}
