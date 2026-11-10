// 数据位置（docs/ui/data-location.md）：会增长的数据（对话、频道、项目登记……）放在哪个文件夹、怎么搬。
// 只用 node:fs，不碰 electron，方便测试；electron 那一侧在 data-dir.ts。
import { cp, lstat, readdir, readFile, rm, statfs, writeFile, access, mkdir, rename } from 'node:fs/promises'
import { constants, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, relative, resolve, isAbsolute } from 'node:path'

/** 跟着数据位置走的条目（相对数据位置）；其余（设置、凭证、Chromium 数据）留在 userData */
export const DATA_ENTRIES = [
  'engine',
  'channels',
  'attachments',
  'project-tools',
  'session-status',
  'terminal',
  'ssh-terminals.json',
  'extension-packs',
] as const

/** 搬到一半的标记：复制前写进目标，写好指针后删掉。下次启动还在说明目标里的条目是上次没搬完的，可以清掉重来 */
export const MOVING_MARK = '.pixelsky-moving'

/** 搬的时候跳过（缓存，留在 Local 能重建） */
const SKIP = [join('extension-packs', 'cache')]

/** userData 里的指针文件：数据位置在哪；有 move 时下次启动先搬 */
export interface DataPointer {
  version: 1
  path: string
  /** 等着下次启动时搬过去 */
  move?: { to: string }
  /** 搬完后旧位置还留着数据（用户点了「删除旧数据」才清掉） */
  previous?: string
  /** 上次搬失败的原因 */
  error?: string
}

export function readPointer(file: string): DataPointer | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DataPointer>
    if (raw?.version !== 1 || typeof raw.path !== 'string' || !isAbsolute(raw.path)) return null
    const move =
      raw.move && typeof raw.move.to === 'string' && isAbsolute(raw.move.to) ? { to: raw.move.to } : undefined
    return {
      version: 1,
      path: raw.path,
      ...(move ? { move } : {}),
      ...(typeof raw.previous === 'string' && isAbsolute(raw.previous) ? { previous: raw.previous } : {}),
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    }
  } catch {
    return null
  }
}

export async function writePointer(file: string, pointer: DataPointer): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(pointer, null, 2), 'utf8')
  await rename(tmp, file)
}

const norm = (p: string): string => {
  const r = resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? r.toLowerCase() : r
}
export const samePath = (a: string, b: string): boolean => norm(a) === norm(b)
/** child 在 parent 里面（含相同） */
export function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface DefaultInput {
  userData: string
  /** 安装目录（exe 所在文件夹） */
  installDir: string
  /** 便携版 exe 所在文件夹（PORTABLE_EXECUTABLE_DIR） */
  portableDir?: string
  /** 系统盘，如 C: */
  systemDrive?: string
  packaged: boolean
  /** userData 里已经有数据（老用户） */
  hasData: boolean
}

/**
 * 没有指针时的默认位置（§4）：老用户、开发版、装在系统盘的都是 userData；
 * 新装在别的盘：安装目录旁边的「<安装目录名>-数据」（不放进安装目录：卸载和更新会清掉它）；便携版放 exe 旁边
 */
export function defaultDataRoot(input: DefaultInput): string {
  if (!input.packaged || input.hasData) return input.userData
  if (input.portableDir) return join(input.portableDir, '像素星空-数据')
  const drive = (input.systemDrive ?? 'C:').replace(/[\\/]+$/, '')
  if (process.platform === 'win32' && samePath(parse(input.installDir).root, drive + '\\')) return input.userData
  if (process.platform !== 'win32') return input.userData
  return join(dirname(input.installDir), `${basename(input.installDir)}-数据`)
}

export type TargetProblem =
  | 'notAbsolute'
  | 'same'
  | 'insideCurrent'
  | 'containsCurrent'
  | 'insideInstall'
  | 'notWritable'
  | 'hasData'
  | 'noSpace'

/** 选的文件夹能不能用（§5 第 1 步）；need 是要搬的字节数，留 20% 余量 */
export async function checkTarget(
  target: string,
  opts: { current: string; installDir: string; need: number },
): Promise<TargetProblem | null> {
  if (!isAbsolute(target)) return 'notAbsolute'
  if (samePath(target, opts.current)) return 'same'
  if (inside(opts.current, target)) return 'insideCurrent'
  if (inside(target, opts.current)) return 'containsCurrent'
  if (inside(opts.installDir, target)) return 'insideInstall'
  try {
    await mkdir(target, { recursive: true })
    await access(target, constants.W_OK)
    const probe = join(target, `.pixelsky-write-${process.pid}`)
    await writeFile(probe, '')
    await rm(probe, { force: true })
  } catch {
    return 'notWritable'
  }
  // 上次没搬完留下的不算已有数据（moveData 会先清掉）
  if (!existsSync(join(target, MOVING_MARK)))
    for (const name of DATA_ENTRIES) if (existsSync(join(target, name))) return 'hasData'
  const fs = await statfs(target).catch(() => null)
  if (fs && fs.bavail * fs.bsize < opts.need * 1.2) return 'noSpace'
  return null
}

const skipped = (root: string, path: string): boolean => SKIP.some(s => inside(join(root, s), path))

/** 数据条目一共多少个文件、多少字节（不跟符号链接，跳过缓存） */
export async function measure(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const pending: string[] = DATA_ENTRIES.map(name => join(root, name))
  while (pending.length) {
    const p = pending.pop()!
    if (skipped(root, p)) continue
    let st
    try {
      st = await lstat(p)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      for (const name of await readdir(p).catch(() => [] as string[])) pending.push(join(p, name))
    } else {
      files++
      bytes += st.size
    }
  }
  return { files, bytes }
}

/**
 * 聊天的工作目录记的是绝对路径（record.json、checkpoints.json 的 cwd）：搬完把指向旧 chats/ 的改成新的。
 * 只改在 from/engine/chats 下面的，别的（项目里的会话、项目外 Codex 聊天的原文件夹）不动
 */
export async function rewriteChatPaths(to: string, from: string): Promise<Map<string, string>> {
  const oldChats = join(from, 'engine', 'chats')
  const newChats = join(to, 'engine', 'chats')
  const sessions = join(to, 'engine', 'sessions')
  /** 旧 cwd → 新 cwd */
  const changed = new Map<string, string>()
  for (const id of await readdir(sessions).catch(() => [] as string[])) {
    for (const name of ['record.json', 'checkpoints.json']) {
      const file = join(sessions, id, name)
      let data: { cwd?: unknown }
      try {
        data = JSON.parse(await readFile(file, 'utf8'))
      } catch {
        continue
      }
      if (typeof data.cwd !== 'string' || !inside(oldChats, data.cwd)) continue
      const next = join(newChats, relative(oldChats, data.cwd))
      changed.set(data.cwd, next)
      data.cwd = next
      await writeFile(file, JSON.stringify(data, null, 2), 'utf8')
    }
  }
  return changed
}

/** 和 Claude Code 一样把工作目录编成 projects/ 下的文件夹名（engine 的 encodeCwd） */
const encodeCwd = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

/**
 * Claude Code 按工作目录找自己的对话记录（<配置目录>/projects/<编码后的 cwd>/）：聊天的工作目录换了，
 * 把旧文件夹复制一份到新名字下，--resume 才接得上。默认配置目录（含引擎设置里配的 CLAUDE_CONFIG_DIR）
 * 和添加的订阅账号目录（已经跟着 engine/ 搬到 to）都处理；只复制不删，复制失败不挡搬家（退回文字接续）。
 * shortcut: 编码后超过 200 字符的文件夹名 Claude Code 会截断加哈希，算不出来就不复制；数据位置路径很长时再补
 */
export async function copyClaudeTranscripts(
  to: string,
  moved: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (!moved.size) return 0
  const configs = new Set<string>([env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')])
  try {
    const settings = JSON.parse(await readFile(join(to, 'engine', 'engine-settings.json'), 'utf8')) as {
      env?: { claude?: { CLAUDE_CONFIG_DIR?: unknown } }
    }
    const custom = settings.env?.claude?.CLAUDE_CONFIG_DIR
    if (typeof custom === 'string' && isAbsolute(custom)) configs.add(custom)
  } catch {
    // 没有引擎设置
  }
  const accounts = join(to, 'engine', 'accounts', 'claude')
  for (const id of await readdir(accounts).catch(() => [] as string[])) configs.add(join(accounts, id))
  let copied = 0
  for (const config of configs) {
    const projects = join(config, 'projects')
    for (const [oldCwd, newCwd] of moved) {
      const src = join(projects, encodeCwd(oldCwd))
      const dst = join(projects, encodeCwd(newCwd))
      if (encodeCwd(newCwd).length > 200 || !existsSync(src)) continue
      // 新名字下已经有（搬回以前用过的位置）：那是上次的旧记录，改名留着，换成这次的
      if (existsSync(dst)) {
        try {
          await rename(dst, `${dst}.old-${process.pid}-${Date.now()}`)
        } catch {
          continue
        }
      }
      // 先复制到临时名字再改名：复制一半被打断不会留下一份不完整的、下次又被跳过
      const tmp = `${dst}.copying`
      try {
        await rm(tmp, { recursive: true, force: true })
        await cp(src, tmp, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
        await rename(tmp, dst)
        copied++
      } catch {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
  return copied
}

/**
 * 把数据条目从 from 复制到 to，核对文件数和字节数，再改聊天路径。不删 from。
 * 失败时删掉这次在 to 里建的条目再抛错（to 里原来没有这些条目，checkTarget 查过）
 */
export async function moveData(
  from: string,
  to: string,
  onProgress?: (done: number, total: number) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ files: number; bytes: number }> {
  // 原来的位置不在（盘没插）：measure 会得到 0/0、核对也会通过，必须先拦下，不能切到一份空数据
  if (!existsSync(from)) throw new Error(`找不到原来的数据位置：${from}`)
  const total = await measure(from)
  await mkdir(to, { recursive: true })
  const mark = join(to, MOVING_MARK)
  // 上次复制到一半被打断：标记还在，目标里的条目是那次建的，清掉重来
  if (existsSync(mark)) for (const name of DATA_ENTRIES) await rm(join(to, name), { recursive: true, force: true })
  // 目标里已经有同名条目（选完到重启之间被放进去的）：一个都不碰，直接报错——失败清理只删这次建的
  for (const name of DATA_ENTRIES)
    if (existsSync(join(from, name)) && existsSync(join(to, name))) throw new Error(`目标文件夹里已经有 ${name}`)
  await writeFile(mark, from, 'utf8')
  const created: string[] = []
  try {
    let done = 0
    for (const name of DATA_ENTRIES) {
      const src = join(from, name)
      if (!existsSync(src)) continue
      const dst = join(to, name)
      created.push(dst)
      await cp(src, dst, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
        filter: p => !skipped(from, p),
      })
      done += (await measure(to)).bytes - done
      onProgress?.(done, total.bytes)
    }
    const copied = await measure(to)
    if (copied.files !== total.files || copied.bytes !== total.bytes)
      throw new Error(`复制后核对不一致：${copied.files}/${total.files} 个文件，${copied.bytes}/${total.bytes} 字节`)
    await copyClaudeTranscripts(to, await rewriteChatPaths(to, from), env)
    return total
  } catch (error) {
    await Promise.all(created.map(p => rm(p, { recursive: true, force: true }).catch(() => undefined)))
    await rm(mark, { force: true }).catch(() => undefined)
    throw error
  }
}

/** 指针已经指向 to：去掉搬到一半的标记 */
export async function finishMove(to: string): Promise<void> {
  await rm(join(to, MOVING_MARK), { force: true })
}

/** 一个文件夹里有没有像素星空的数据（接回原来的数据位置时用） */
export function hasDataAt(root: string): boolean {
  // 只认像素星空自己写的文件：随便一个叫 engine 的文件夹不算（接回后「删除旧数据」会删到它）
  const engine = join(root, 'engine')
  const own = ['projects.json', 'engine-settings.json', 'sessions'].some(name => existsSync(join(engine, name)))
  return own && !existsSync(join(root, MOVING_MARK))
}

/** 删掉旧位置的数据条目（只删 DATA_ENTRIES：旧位置可能就是 userData，设置和凭证还在那里） */
export async function removeData(root: string, trash: (path: string) => Promise<void>): Promise<void> {
  for (const name of DATA_ENTRIES) {
    const p = join(root, name)
    if (existsSync(p)) await trash(p)
  }
}
