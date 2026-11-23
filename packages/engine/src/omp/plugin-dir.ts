// 用户在「设置 › 插件」里配的 MCP、技能、扩展包交给 oh-my-pi（docs/omp-engine.md §12.3）：拼一个 Claude 插件格式的目录，
// 用 --plugin-dir 给。MCP 用桌面端展开过的原值（omp 原样用，实测），文件只有自己能读，进程退出就删；
// 技能用目录联接，不复制。插件的钩子、命令、子代理不给（同 Codex、像素星空：那些是 Claude 专有的）
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ExtensionLaunch } from '@pixelsky/protocol'
import { removeTree } from '../exec'

/** 插件名：omp 里 MCP 工具叫 mcp__pixelsky_<服务>_<工具> */
const PLUGIN = 'pixelsky'

/** 没有要给的返回 null；remove 在进程退出后调 */
export function writeOmpPlugin(
  root: string,
  ext: Pick<ExtensionLaunch, 'mcpFile' | 'skillRoots'>,
): { dir: string; remove: () => void } | null {
  const servers = ext.mcpFile
    ? ((JSON.parse(readFileSync(ext.mcpFile, 'utf8')) as { mcpServers?: object }).mcpServers ?? {})
    : {}
  const skills = [...new Set(ext.skillRoots ?? [])].filter(path => existsSync(join(path, 'SKILL.md')))
  if (!Object.keys(servers).length && !skills.length) return null
  const dir = join(root, randomUUID())
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  const manifest = { name: PLUGIN, version: '1.0.0', description: 'PixelSky extensions' }
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
  if (Object.keys(servers).length)
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
  if (skills.length) {
    mkdirSync(join(dir, 'skills'))
    const used = new Set<string>()
    for (const path of skills) {
      const base = basename(path)
      let name = base
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}`
      used.add(name.toLowerCase())
      // Windows 的目录联接不要管理员权限；一个建不了只少这一个
      try {
        symlinkSync(path, join(dir, 'skills', name), 'junction')
      } catch {
        // 例如目标在不支持联接的网络盘
      }
    }
  }
  return {
    dir,
    remove: () => {
      try {
        removeTree(dir)
      } catch {
        // 还被占着：下次启动时清（cleanOmpPlugins）
      }
    },
  }
}

/** 清掉上次没删成的（终端模式的、应用崩溃时的）：里面有 MCP 的凭据 */
export function cleanOmpPlugins(root: string): void {
  if (!existsSync(root)) return
  for (const name of readdirSync(root))
    try {
      removeTree(join(root, name))
    } catch {
      // 别的进程还占着
    }
}
