// 订阅账号多开的目录联接（docs/ui/engine-accounts.md §2、engine-accounts-claude.md §2.2）：Codex 和 Claude Code 共用。
// 账号目录里的文件夹用目录联接（Windows junction，其它系统符号链接）接回原目录，里面的文件由引擎自己写。
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  type BigIntStats,
} from 'node:fs'
import { join, resolve } from 'node:path'

export const lstat = (p: string): BigIntStats | null => {
  try {
    return lstatSync(p, { bigint: true })
  } catch {
    return null
  }
}

/** 链接已经指到 target 了没有 */
export function linkedTo(path: string, target: string): boolean {
  try {
    return resolve(readlinkSync(path)).toLowerCase() === resolve(target).toLowerCase()
  } catch {
    return false
  }
}

/** 把 from 里的内容并进 to（to 里已有的同名项保留原目录的，只添不改），然后删掉 from */
function mergeInto(from: string, to: string): void {
  for (const name of readdirSync(from)) {
    const src = join(from, name),
      dst = join(to, name)
    if (existsSync(dst)) continue
    try {
      renameSync(src, dst)
    } catch {
      cpSync(src, dst, { recursive: true })
    }
  }
  rmSync(from, { recursive: true, force: true })
}

/**
 * 账号目录 dir 里的 name 接回原目录 real 里的同名文件夹；已经接好的不动。原目录没有这个文件夹时补建一个空的（联接要指向它）。
 * 账号目录里已经有真文件夹（引擎在链上之前自己建的）：merge 为真时把里面的东西挪回原目录再链上（Codex）；
 * 为假时不动它、这一项不共享（Claude：像素星空不往原目录里写文件，engine-accounts-claude.md §2.3），返回 false
 */
export function linkDir(real: string, dir: string, name: string, merge = true): boolean {
  const target = join(real, name),
    path = join(dir, name)
  mkdirSync(target, { recursive: true })
  const st = lstat(path)
  if (st?.isSymbolicLink()) {
    if (linkedTo(path, target)) return true
    rmSync(path, { force: true })
  } else if (st?.isDirectory()) {
    if (!merge) return false
    // 引擎在链上之前自己建了这个文件夹（或者上次链失败了）：里面的东西挪回原目录
    mergeInto(path, target)
  } else if (st) rmSync(path, { force: true })
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  return true
}
