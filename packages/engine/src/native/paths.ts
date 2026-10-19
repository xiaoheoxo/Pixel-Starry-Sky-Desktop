import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { IS_WINDOWS } from '../exec'

// ---------- 路径 ----------

export function normalDir(p: string): string {
  const r = resolve(p).replace(/[\\/]+$/, '')
  return IS_WINDOWS ? r.toLowerCase() : r
}

/** 两个目录是不是同一个：Windows 忽略大小写和末尾分隔符，对不上时两边 realpath 再比（符号链接 / 目录联接） */
export async function sameDir(a: string, b: string): Promise<boolean> {
  if (normalDir(a) === normalDir(b)) return true
  try {
    return normalDir(await realpath(a)) === normalDir(await realpath(b))
  } catch {
    return false
  }
}

/** child 是不是在 parent 下面（含相同）；是的话返回相对路径（相同时 ''） */
export function under(parent: string, child: string): string | null {
  // Windows 上 relative 不区分大小写，剩下的部分保持记录里的写法
  const rel = relative(resolve(parent), resolve(child))
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel.replace(/\\/g, '/')
}

/** 记录里的 cwd 对得上项目路径吗。subfolders：项目下面的子文件夹也算（返回相对路径） */
export async function matchCwd(
  project: string,
  recorded: string,
  subfolders: boolean,
): Promise<{ subdir: string | null } | null> {
  if (await sameDir(project, recorded)) return { subdir: null }
  if (!subfolders) return null
  let rel = under(project, recorded)
  if (rel === null) {
    try {
      rel = under(await realpath(project), await realpath(recorded))
    } catch {
      return null
    }
  }
  if (rel === null) return null
  if (rel === '') return { subdir: null }
  // 子文件夹已经不在了：启动会报「工作目录不存在」，不列
  const gone = await stat(recorded).then(
    s => !s.isDirectory(),
    () => true,
  )
  return gone ? null : { subdir: rel }
}
