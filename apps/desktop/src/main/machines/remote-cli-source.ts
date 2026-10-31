import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { packRemoteCli, type RemoteArch, type RemoteCliArchive } from './remote-cli'

// 找远程要装的命令行文件并打包（打包逻辑在 remote-cli.ts）。命令行 JS 不分系统，rg / fd 只给 Linux 远程：
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

/**
 * 一个进程只打一次包（每个系统 + 架构各一份）；没有命令行文件（开发时没 build）返回 null，失败的结果不缓存。
 * 随包的 rg / fd 只有 Linux 版：远程是 Windows / macOS 时包里不带，命令行用远程自己 PATH 里的
 */
export function createRemoteCliCache(sources: () => Promise<RemoteCliSources> = bundledRemoteCliSources) {
  const cache = new Map<string, Promise<RemoteCliArchive>>()
  return async (arch: RemoteArch, platform = 'linux'): Promise<RemoteCliArchive | null> => {
    try {
      const { cliDir, toolsDir } = await sources()
      if (!existsSync(join(cliDir, 'pixel.mjs'))) return null
      const key = platform === 'linux' ? arch : 'other-' + arch
      let packed = cache.get(key)
      if (!packed) {
        const tools = platform === 'linux' ? toolsDir(arch) : null
        packed = packRemoteCli(cliDir, tools && existsSync(tools) ? tools : null)
        cache.set(key, packed)
        packed.catch(() => cache.delete(key))
      }
      return await packed
    } catch {
      return null
    }
  }
}

export const remoteCliArchive = createRemoteCliCache()
export type RemoteCliProvider = (arch: RemoteArch, platform?: string) => Promise<RemoteCliArchive | null>
