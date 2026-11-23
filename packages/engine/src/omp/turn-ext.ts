// 回退、分叉要知道我们的用户条目在 omp 会话树里的位置（docs/omp-engine.md §12.6）：omp 不收客户端给的消息 id，
// 所以写一个扩展，会话进程总是 -e 加载；每轮发提示之前用命令 /pixelsky-turn <条目 id> 在树上记一条（不进上下文，实测），
// 截断点就是这条（branch.ts）。终端模式不加载：命令会出现在用户的菜单里
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const OMP_TURN_COMMAND = 'pixelsky-turn'
/** 记在会话文件里的 customType */
export const TURN_ENTRY = 'pixelsky.turn'

export const OMP_TURN_SOURCE = `// 像素星空写的文件，每次启动会覆盖。记下每一轮在会话里的位置，回退和分叉用
export default function pixelskyTurn(pi) {
  pi.registerCommand(${JSON.stringify(OMP_TURN_COMMAND)}, {
    description: 'PixelSky internal',
    handler: async args => {
      pi.appendEntry(${JSON.stringify(TURN_ENTRY)}, { id: String(args || '').trim() })
    },
  })
}
`

/** 写到 dir 下（内容一样就不写），返回文件路径 */
export function writeOmpTurn(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'pixelsky-turn.mjs')
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    // 还没有
  }
  if (current !== OMP_TURN_SOURCE) writeFileSync(file, OMP_TURN_SOURCE)
  return file
}
