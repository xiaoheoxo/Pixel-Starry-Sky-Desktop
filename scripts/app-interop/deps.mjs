// 互通环境要用的 ws（中转的 WebSocket 服务）和 esbuild（打包桌面端 TS 源码），都是仓库里已装的依赖，不另加。
// esbuild 是 packages/cli、packages/extension-cli 的依赖；ws 没有工作区包直接依赖它（是 pi 的间接依赖），
// 只能取 pnpm 提升到 node_modules/.pnpm/node_modules 里的那份。所以按顺序在这几个位置找，找到第一个为止。
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const places = [
  join(root, 'packages', 'cli'),
  join(root, 'packages', 'extension-cli'),
  join(root, 'apps', 'desktop'),
  root,
  join(root, 'node_modules', '.pnpm', 'node_modules'),
]

export function need(name) {
  for (const dir of places) {
    try {
      // 文件不用真实存在，createRequire 只拿它的目录当解析起点
      return createRequire(join(dir, 'resolve-from.cjs'))(name)
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error(`找不到依赖 ${name}：先在仓库根目录运行 pnpm install`)
}
