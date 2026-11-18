// 执行机目录里几个文件的读法（docs/multica-learn.md §11.7）：daemon 和 install 共用，单独放一处免得 install → daemon → remote-runtime
// → install 成了循环导入（remote-runtime 的 runner:* 方法要用 install）。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunnerConfig } from '../../shared/types/runner'
import { cleanRunnerConfig } from './config'

/** helper.cjs 的版本：文件内容哈希前 12 位（桌面拿它和自己带的比，不一样才升级） */
export function bundleVersion(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
  } catch {
    return 'unknown'
  }
}

/** 升级时桌面放进来的新版本：runner.next.cjs（手上没在做的活时换上） */
export const nextScript = (script: string): string => script.replace(/\.cjs$/, '.next.cjs')

export function readConfig(dir: string): RunnerConfig | null {
  try {
    return cleanRunnerConfig(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')))
  } catch {
    return null
  }
}
