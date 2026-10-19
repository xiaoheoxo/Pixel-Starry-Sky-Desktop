import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { packRemoteCli, type RemoteArch, type RemoteCliArchive } from './remote-cli'

// 找远程要装的命令行文件并打包（打包逻辑在 remote-cli.ts）。远程机器永远是 Linux：
// - 命令行 JS：打包后 resources/pixel-cli，开发时 packages/cli/dist/pixel-cli（pnpm build 生成）；它的 bin/ 是宿主平台的，不用
// - Linux 版 rg / fd：打包后 resources/pixel-cli-linux/<架构>（after-pack.cjs 拷），开发时 packages/cli/vendor/linux-<架构>

export interface RemoteCliSources {
  cliDir: string
  toolsDir: (arch: RemoteArch) => string
}

/** electron 用动态 import：单测里 ssh.ts 也会引到这个文件，不能在加载时就要求 Electron 环境 */
export async function bundledRemoteCliSources(): Promise<RemoteCliSources> {
  const { app } = await import('electron')
  if (app.isPackaged) {
    return {
      cliDir: join(process.resourcesPath, 'pixel-cli'),
      toolsDir: arch => join(process.resourcesPath, 'pixel-cli-linux', arch),
    }
  }
  const cli = join(app.getAppPath(), '..', '..', 'packages', 'cli')
  return { cliDir: join(cli, 'dist', 'pixel-cli'), toolsDir: arch => join(cli, 'vendor', 'linux-' + arch) }
}

/** 一个进程只打一次包（每个架构各一份）；没有命令行文件（开发时没 build）返回 null，失败的结果不缓存 */
export function createRemoteCliCache(sources: () => Promise<RemoteCliSources> = bundledRemoteCliSources) {
  const cache = new Map<RemoteArch, Promise<RemoteCliArchive>>()
  return async (arch: RemoteArch): Promise<RemoteCliArchive | null> => {
    try {
      const { cliDir, toolsDir } = await sources()
      if (!existsSync(join(cliDir, 'pixel.mjs'))) return null
      let packed = cache.get(arch)
      if (!packed) {
        const tools = toolsDir(arch)
        packed = packRemoteCli(cliDir, existsSync(tools) ? tools : null)
        cache.set(arch, packed)
        packed.catch(() => cache.delete(arch))
      }
      return await packed
    } catch {
      return null
    }
  }
}

export const remoteCliArchive = createRemoteCliCache()
export type RemoteCliProvider = (arch: RemoteArch) => Promise<RemoteCliArchive | null>
