// 在 WSL 里找引擎程序时认准 Linux 版（规划 §4.5）：PATH 里带进来的 Windows 程序能跑，但会按 Windows 路径处理
import { closeSync, openSync, readSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isFile, pathDirs } from './exec'

export interface WslDeps {
  readHead: (path: string) => Uint8Array | null
  realpath: (path: string) => string
}

export function inWsl(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' && !!env.WSL_DISTRO_NAME
}

/** /mnt/c/… 这类 Windows 盘挂载路径 */
export function isWindowsMount(path: string): boolean {
  return /^\/mnt\/[a-z](?:\/|$)/i.test(path)
}

/** Windows 可执行文件（PE）以 MZ 开头；不能看扩展名，npm 装的 Linux 版也叫 claude.exe */
export function hasPeHeader(head: Uint8Array | null): boolean {
  return !!head && head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a
}

export function readHead(path: string): Uint8Array | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(2)
    const n = readSync(fd, buf, 0, 2, 0)
    return buf.subarray(0, n)
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const realDeps: WslDeps = { readHead, realpath: realpathSync }

/** 在 WSL 里应该跳过的 Windows 程序：路径或解析链接后的路径在 /mnt/<盘符>/ 下，或文件头是 MZ */
export function skipInWsl(
  path: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  deps: WslDeps = realDeps,
): boolean {
  if (!inWsl(env, platform)) return false
  if (isWindowsMount(path)) return true
  let real = path
  try {
    real = deps.realpath(path)
  } catch {
    // 解析不了就按原路径判断
  }
  return isWindowsMount(real) || hasPeHeader(deps.readHead(real))
}

/** 测试用：指定平台和读文件的方式 */
export interface WslOpts {
  platform?: NodeJS.Platform
  deps?: WslDeps
}

/** 候选该留下就返回 true；在 WSL 里该跳过的返回 false，并把存在的路径记进 skipped（找不到 Linux 版时写进详情） */
export function keepInWsl(
  path: string,
  env: NodeJS.ProcessEnv,
  skipped: string[] | undefined,
  opts: WslOpts = {},
): boolean {
  if (!skipInWsl(path, env, opts.platform, opts.deps)) return true
  if (isFile(path) && skipped && !skipped.includes(path)) skipped.push(path)
  return false
}

/** PATH 里所有叫这个名字的文件（WSL 里第一个常是 /mnt/c 下的，Linux 版在后面） */
export function allOnPath(fileName: string, env: NodeJS.ProcessEnv): string[] {
  return pathDirs(env.PATH ?? env.Path ?? '')
    .map(d => join(d, fileName))
    .filter(isFile)
}

/** 只找到 Windows 程序时写进详情的说明 */
export function windowsOnlyNote(skipped: string[]): string {
  return skipped.length ? `只找到 Windows 程序：${skipped[0]}` : ''
}
