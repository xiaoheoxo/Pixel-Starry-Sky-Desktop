// 测试临时目录：固定放在仓库根 scratch/<日期>-engine-test/ 下，和运行目录无关
import { mkdirSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// test/helpers → test → packages/engine → packages → 仓库根
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 本次测试共用的父目录 */
export function scratchRoot(): string {
  const dir = join(REPO_ROOT, 'scratch', `${today()}-engine-test`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 新建一个临时目录，返回路径；用完调用 removeTmp */
export function makeTmp(prefix: string): string {
  // 测试文件并行跑：别的文件 removeTmp 时可能正好把空了的父目录删掉（在这里 mkdir 和 mkdtemp 之间），
  // 遇到父目录不存在就重建再试
  for (let attempt = 0; ; attempt++) {
    try {
      return mkdtempSync(join(scratchRoot(), `${prefix}-`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 4) throw error
    }
  }
}

export function removeTmp(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  // 父目录空了就一起删掉，不在 scratch/ 留空目录
  try {
    rmdirSync(dirname(dir))
  } catch {
    /* 还有其他测试的目录 */
  }
}
