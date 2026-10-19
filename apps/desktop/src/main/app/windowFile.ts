// userData/window.json 是几个模块共用的小文件（托盘偏好、窗口位置）：
// 写之前先读出整个文件，只改自己的字段，别的字段原样保留。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readWindowFile(file: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 合并写入；失败（磁盘满、被占用）时静默，本次内存里的状态仍然生效 */
export function mergeWindowFile(file: string, patch: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const text = JSON.stringify({ ...readWindowFile(file), ...patch })
    // 先写临时文件再改名覆盖：写到一半崩溃 / 断电时，原文件还是完整的（托盘偏好不会被清空）
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, text)
      renameSync(tmp, file) // Windows 上 renameSync 也会覆盖已有文件
    } catch {
      // 改名失败（目标被杀毒软件 / 别的进程占着等）：清掉临时文件，退回直接写
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      writeFileSync(file, text)
    }
  } catch {
    /* ignore */
  }
}
