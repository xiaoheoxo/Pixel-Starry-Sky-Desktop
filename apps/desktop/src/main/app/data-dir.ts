// 开发版（pnpm dev / dev:demo）用自己的数据目录：安装版和开发版的应用名都是 @pixelsky/desktop，
// 默认会用同一个 %APPDATA%\@pixelsky\desktop——单实例锁也按数据目录算，开着安装版时开发版一启动就退出（唤起安装版的窗口），
// 而且开发版会读写安装版真实的会话、设置和账号。安装版的位置不变（改了会丢数据）。
// 必须在 index.ts 里第一个导入：别的模块初始化时可能就读数据目录。
//
// 三个位置（docs/ui/data-location.md）：
// - userData（Roaming）：设置、凭证、Chromium 数据，小
// - localRoot（Local）：运行时、日志、图标缓存，删了能重建
// - dataRoot（数据位置，可改）：对话、频道、项目登记等会增长的数据；指针在 userData/data-location.json
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { app } from 'electron'
import {
  DATA_ENTRIES,
  defaultDataRoot,
  finishMove,
  moveData,
  readPointer,
  writePointer,
  type DataPointer,
} from './data-location'

const override = process.env.PIXELSKY_USER_DATA
if (override) app.setPath('userData', override)
// 已经用 --user-data-dir 或 setPath 换过（测试、截图）的不动。默认路径里混着 \ 和 /（@pixelsky/desktop），比较前先规范化
else if (!app.isPackaged && resolve(app.getPath('userData')) === resolve(app.getPath('appData'), app.name))
  app.setPath('userData', join(app.getPath('appData'), '@pixelsky', 'desktop-dev'))

const userData = app.getPath('userData')
export const pointerFile = join(userData, 'data-location.json')

/** Windows 上 userData 在 Roaming 下面时，对应的 Local 目录；别的情况（测试换了目录、非 Windows）就是 userData */
function computeLocal(): string {
  const local = process.env.LOCALAPPDATA
  if (process.platform !== 'win32' || !local) return userData
  const rel = relative(app.getPath('appData'), userData)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? join(local, rel) : userData
}
const local = computeLocal()
/** 缓存类：运行时、日志、图标缓存、网关临时设置 */
export function localRoot(): string {
  return local
}

let pointer: DataPointer | null = readPointer(pointerFile)
let root =
  pointer?.path ??
  defaultDataRoot({
    userData,
    installDir: dirname(process.execPath),
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    systemDrive: process.env.SystemDrive,
    // 换了数据目录启动（测试、多开）：数据也跟着那个目录，不和正式实例共用安装目录旁边的那份
    packaged: app.isPackaged && !override && !process.argv.some(a => a.startsWith('--user-data-dir')),
    hasData: DATA_ENTRIES.some(name => existsSync(join(userData, name))),
  })
/** 会增长的数据放在哪（设置 › 存储 › 数据位置） */
export function dataRoot(): string {
  return root
}
export function dataPointer(): DataPointer | null {
  return pointer
}

/** 以前放在 Roaming 的缓存挪到 Local（同一个盘，rename 很快）；挪不了就删掉，它们都能重建 */
function moveCachesToLocal(): void {
  if (local === userData) return
  for (const name of ['runtime', 'logs', join('extension-packs', 'cache'), 'platform-groups.json', 'gateway']) {
    const from = join(userData, name)
    if (!existsSync(from)) continue
    const to = join(local, name)
    // 日志一启动就写到 Local 了：把旧的按文件并过去，不整个删
    if (name === 'logs' && existsSync(to)) {
      for (const file of readdirSync(from)) {
        try {
          if (!existsSync(join(to, file))) renameSync(join(from, file), join(to, file))
        } catch {
          // 被占着：下次再试
        }
      }
      try {
        rmSync(from, { recursive: true, force: true })
      } catch {
        // 还被占着：下次再试
      }
      continue
    }
    try {
      if (existsSync(to) || name === 'gateway') throw new Error('skip')
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
    } catch {
      // runtime/ 里是私有 Node 和一键装的引擎，删了要重新下载：挪不动就留在原地下次再试（Local 已经有一份时才删）
      if (name === 'runtime' && !existsSync(to)) continue
      try {
        rmSync(from, { recursive: true, force: true })
      } catch {
        // 还被占着：下次再试
      }
    }
  }
}
export type StartupData =
  | { kind: 'ok' }
  | { kind: 'moved'; bytes: number }
  | { kind: 'moveFailed'; error: string }
  | { kind: 'missing'; path: string }

/**
 * 启动时、任何模块读数据之前（index.ts 的 whenReady 开头）：有排好的搬家就搬（这时没有别的进程在写），
 * 然后确认数据位置在。新装默认位置第一次用时把指针写下来，以后不再随安装目录变
 */
export async function prepareDataRoot(): Promise<StartupData> {
  // 要在单实例锁之后：第二次启动时第一份还在用 runtime/，不能去挪它
  moveCachesToLocal()
  // 先确认原来的位置在：盘没插时不能去搬（会搬出一份空数据），排好的搬家留着，接上后重试照样搬
  if (pointer && !existsSync(root)) return { kind: 'missing', path: root }
  if (pointer?.move) {
    const to = pointer.move.to
    try {
      const { bytes } = await moveData(root, to)
      // 先删标记再换指针：标记留在用着的数据里，以后再选这个文件夹会被当成半份清掉。
      // 这两步之间崩溃：下次重搬时目标里条目齐全、没有标记，会报「已经有」安全失败，不会删
      await finishMove(to)
      pointer = { version: 1, path: to, previous: root }
      await writePointer(pointerFile, pointer)
      root = to
      return { kind: 'moved', bytes }
    } catch (error) {
      const message = (error as Error).message
      pointer = { version: 1, path: root, error: message }
      await writePointer(pointerFile, pointer)
      return { kind: 'moveFailed', error: message }
    }
  }
  if (!existsSync(root)) {
    // 新装的默认位置建不出来（没权限、盘满）：退回 userData
    try {
      mkdirSync(root, { recursive: true })
    } catch {
      root = userData
    }
  }
  if (!pointer && root !== userData) {
    pointer = { version: 1, path: root }
    await writePointer(pointerFile, pointer)
  }
  // 正在用的数据位置不该有「搬到一半」的标记（旧版本或删失败留下的）：每次启动清一次
  await finishMove(root).catch(() => undefined)
  return { kind: 'ok' }
}

/** 找不到数据位置时选了「回到默认位置」：指针指回 userData（原来的数据还在那个盘上，接回来后可以再改回去） */
export async function resetDataRoot(): Promise<void> {
  pointer = { version: 1, path: userData }
  root = userData
  await writePointer(pointerFile, pointer)
  mkdirSync(root, { recursive: true })
}

/** 排一次搬家：下次启动时搬到 to */
export async function scheduleMove(to: string): Promise<void> {
  pointer = { version: 1, path: root, move: { to } }
  await writePointer(pointerFile, pointer)
}

/** 接回一个已经有数据的文件夹（换过盘、回到默认位置后再接回去）：只改指针，不复制，下次启动用它 */
export async function useExisting(path: string): Promise<void> {
  pointer = { version: 1, path }
  await writePointer(pointerFile, pointer)
}

/** 取消排好的搬家 */
export async function cancelMove(): Promise<void> {
  if (!pointer?.move) return
  pointer = { version: 1, path: root, ...(pointer.previous ? { previous: pointer.previous } : {}) }
  await writePointer(pointerFile, pointer)
}

/** 旧位置的数据已经删了（或用户不要了）：不再提示 */
export async function forgetPrevious(): Promise<void> {
  if (!pointer?.previous && !pointer?.error) return
  pointer = { version: 1, path: root }
  await writePointer(pointerFile, pointer)
}
