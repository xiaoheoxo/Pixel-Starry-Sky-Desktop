// Codex 多账号的目录（docs/ui/engine-accounts.md §2）：每个添加的账号一个 CODEX_HOME，只有登录凭据是它自己的；
// 对话记录、插件、技能、MCP 设置等接回原来的目录（文件夹用目录联接 / 符号链接，文件用硬链接），
// sqlite 用 CODEX_SQLITE_HOME 指回原目录。凭据由 codex login 自己写进去，这里不读不碰。
import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, statSync, symlinkSync, type BigIntStats } from 'node:fs'
import { join } from 'node:path'
import { linkDir, linkedTo, lstat } from '../accounts-home'
import { logger } from '../log'

const log = logger('engine.codex.accounts')

/** 接回原目录的文件夹 */
export const SHARED_DIRS = [
  'sessions',
  'archived_sessions',
  'skills',
  'rules',
  'memories',
  'prompts',
  'plugins',
  'log',
  'thread-writer-locks',
  'mcp-oauth-locks',
  'db-backups',
] as const

/** 接回原目录的文件；auth.json（凭据）、.credentials.json（MCP 令牌）不在里面 */
export const SHARED_FILES = ['config.toml', 'history.jsonl', 'session_index.jsonl', 'AGENTS.md'] as const

/** 账号目录要用的环境变量：用户自己设了 CODEX_SQLITE_HOME 的照用户的 */
export function accountEnv(realHome: string, dir: string, env: NodeJS.ProcessEnv): Record<string, string> {
  return { CODEX_HOME: dir, CODEX_SQLITE_HOME: env.CODEX_SQLITE_HOME || realHome }
}

const stat = (p: string): BigIntStats | null => {
  try {
    return statSync(p, { bigint: true })
  } catch {
    return null
  }
}
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.ino === b.ino && a.dev === b.dev && a.ino !== 0n

/** 硬链接 → 符号链接 → 复制（跨盘时）；复制的按修改时间双向同步 */
function linkFile(real: string, dir: string, name: string): void {
  const src = join(real, name),
    dst = join(dir, name)
  const s = stat(src),
    d = lstat(dst)
  if (d?.isSymbolicLink()) {
    if (s && linkedTo(dst, src)) return
    rmSync(dst, { force: true })
  } else if (d?.isFile()) {
    if (s && sameFile(s, d)) return
    // 链接断了（Codex 整个重写了这个文件）或者是复制的：账号目录里那份更新就先拷回原目录
    if (!s || d.mtimeMs > s.mtimeMs) copyFileSync(dst, src)
    rmSync(dst, { force: true })
  }
  if (!existsSync(src)) return
  try {
    linkSync(src, dst)
    return
  } catch {}
  try {
    symlinkSync(src, dst, 'file')
    return
  } catch {}
  copyFileSync(src, dst)
}

/**
 * 准备账号目录：建目录、接上共享的文件夹和文件。每次启动 Codex 前都调，已经接好的不动。
 * 出错只记日志（例如原目录在只读盘上）：Codex 照样能起，只是那一项不共享
 */
export function prepareAccountHome(realHome: string, dir: string): void {
  mkdirSync(dir, { recursive: true })
  mkdirSync(realHome, { recursive: true })
  for (const name of SHARED_DIRS)
    try {
      linkDir(realHome, dir, name)
    } catch (error) {
      log.warn('link dir failed', { name, error: (error as Error).message })
    }
  for (const name of SHARED_FILES)
    try {
      linkFile(realHome, dir, name)
    } catch (error) {
      log.warn('link file failed', { name, error: (error as Error).message })
    }
}
