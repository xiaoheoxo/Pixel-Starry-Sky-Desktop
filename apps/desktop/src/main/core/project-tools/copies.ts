import { randomUUID, createHash } from 'node:crypto'
import { access, mkdir, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { CopyInput, CopyPreview, ProjectCopy } from '../../../shared/types/project-tools'
import { JsonStore, git, gitInfo, inside, run, samePath, value, type ToolsHost } from './common'
import { dirHolders, type DirHolder } from './holders'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * 副本目录删不掉时的提示；能查到占用的进程就点名（停会话、服务、终端都停不到的那些）。
 * 实测 Gradle 9 守护进程编译完不占副本，占着的 java 多半是从副本启动的程序（runClient 的游戏等）
 */
export function busyMessage(path: string, holders: DirHolder[] = [], gradle = false): string {
  let text = `副本目录被占用，没删掉：${path}。`
  if (holders.length) {
    text += `占用的程序：${holders.map(h => `${h.name}（PID ${h.pid}）`).join('、')}。`
    if (gradle && holders.some(h => /java/i.test(h.name)))
      text +=
        'Java 程序多半是从这个副本启动的游戏或服务（比如 runClient），也可能是 Gradle 守护进程（可在项目里执行 gradlew --stop）。'
    return text + '结束这些程序后再删除。'
  }
  return text + '关掉在这个目录里打开的终端或程序后再删除。'
}
async function busyError(path: string): Promise<Error> {
  const holders = await dirHolders(path)
  const gradle =
    holders.length > 0 &&
    (await access(join(path, '.gradle')).then(
      () => true,
      () => false,
    ))
  return new Error(busyMessage(path, holders, gradle))
}

/**
 * 删文件之前先查占用：把目录改个名再改回来。Windows 上里面有文件开着、或有进程的当前目录在里面时改名会失败，
 * 这样一个文件都不删就能报出来，副本不会删掉一半变成残留目录。其它系统删除不受打开的文件影响，不查。
 */
async function probeFree(path: string): Promise<boolean> {
  if (process.platform !== 'win32') return true
  const probe = `${path}.pixelsky-check-${randomUUID().slice(0, 8)}`
  // 只占一下的不算：停会话后界面会马上重读这个副本的 git 状态，杀毒软件也会扫刚生成的文件
  for (let i = 0; ; i++) {
    try {
      await rename(path, probe)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      if (i === 4) return false
      await sleep(250)
    }
  }
  for (let i = 0; i < 5; i++) {
    try {
      await rename(probe, path)
      return true
    } catch {
      await sleep(100)
    }
  }
  throw new Error(`检查副本目录是否被占用时改了名，没能改回来，现在在：${probe}`)
}

/**
 * 递归删目录，总时长有上限。不用 fs.rm 自带的 maxRetries：它在每一层都重试、上层重试又把整棵子树重做，
 * 耗时随目录深度成倍增长，有一个文件一直被锁时实际上不返回（0.7.16 删副本卡死）。这里只在最外层整体重试。
 */
async function removeTree(path: string, budgetMs = 5000): Promise<boolean> {
  const end = Date.now() + budgetMs
  for (let delay = 200; ; delay = Math.min(delay * 2, 1000)) {
    try {
      await rm(path, { recursive: true, force: true })
      return true
    } catch {
      if (Date.now() + delay > end) return (await dirState(path)) === 'missing'
      await sleep(delay)
    }
  }
}
/** 渲染层靠这段文字识别「残留目录不是空的」并弹出二次确认，不要改 */
export const LEFTOVER_MARK = '残留目录不是空的'

type DirState = 'missing' | 'empty' | 'full'
async function dirState(path: string): Promise<DirState> {
  try {
    return (await readdir(path)).length ? 'full' : 'empty'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'missing'
    if (code === 'ENOTDIR') return 'full'
    throw error
  }
}
/** 删空目录：Windows 上刚释放占用时可能还要等一会儿，重试几次 */
async function removeEmptyDir(path: string, tries = 5, delay = 300): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      await rmdir(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    }
    if (i < tries - 1) await sleep(delay)
  }
  return (await dirState(path)) === 'missing'
}

export class Copies {
  readonly store: JsonStore<{ version: 1; copies: ProjectCopy[] }>
  constructor(
    dir: string,
    private host: ToolsHost,
    private changed: () => void,
    private stopServices: (path: string) => Promise<void>,
  ) {
    this.store = new JsonStore(join(dir, 'copies.json'), { version: 1, copies: [] })
  }
  async init(): Promise<void> {
    await this.store.init()
  }
  get(id: string): ProjectCopy {
    const copy = this.store.data.copies.find(c => c.id === id)
    if (!copy) throw new Error('副本不存在')
    return copy
  }
  async branches(projectId: string): Promise<string[]> {
    const target = this.host.resolve({ projectId })
    return (await git(target.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']))
      .split('\n')
      .filter(Boolean)
  }
  async preview(projectId: string, input: CopyInput): Promise<CopyPreview> {
    if (!input || typeof input !== 'object') throw new Error('参数不正确')
    const target = this.host.resolve({ projectId }),
      info = await gitInfo(target.path)
    if (!info.root || !info.commit) throw new Error('当前项目不是可用的 Git 仓库')
    const name = value(input.name, 80, true),
      branch = value(input.branch, 150, true),
      base = value(input.base || 'HEAD', 150, true)
    if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name))
      throw new Error('副本名称不正确')
    await git(info.root, ['check-ref-format', '--branch', branch])
    // Never interpret a user revision as a Git option.
    const commit = await git(info.root, ['rev-parse', '--verify', '--end-of-options', base + '^{commit}'])
    const existing = (await this.branches(projectId)).includes(branch)
    if (input.existingBranch ? !existing : existing)
      throw new Error(input.existingBranch ? '分支不存在' : '分支已经存在')
    const hash = createHash('sha256')
      .update(await realpath(info.root))
      .digest('hex')
      .slice(0, 8)
    const defaultBase = join(dirname(info.root), '.pixelsky', 'worktrees', basename(info.root) + '-' + hash)
    const path = input.directory ? resolve(value(input.directory, 1000, true)) : join(defaultBase, name)
    if (!isAbsolute(path) || samePath(path, info.root)) throw new Error('副本目录不正确')
    // 上次删除没清干净的登记先清掉；空目录可以直接用（git worktree add 支持空目录）
    await git(info.root, ['worktree', 'prune']).catch(() => '')
    if ((await dirState(path)) === 'full') throw new Error('目标目录已经存在，可能是上次删除没清干净：' + path)
    return {
      input: { name, branch, existingBranch: input.existingBranch === true, base, directory: path },
      path,
      commit,
      branch,
      root: info.root,
    }
  }
  async create(projectId: string, input: CopyInput): Promise<ProjectCopy> {
    let created: { root: string; path: string } | null = null
    let result: ProjectCopy
    try {
      result = await this.store.transaction(async data => {
        const preview = await this.preview(projectId, input)
        if (data.copies.some(c => samePath(c.path, preview.path))) throw new Error('同名副本已经存在')
        await mkdir(dirname(preview.path), { recursive: true })
        // 不设超时：worktree add 先登记、建分支再检出，大仓库检出超过 2 分钟被打断会留下应用里看不到的半成品
        await run(
          'git',
          [
            '-C',
            preview.root,
            'worktree',
            'add',
            ...(input.existingBranch ? [] : ['-b', preview.branch]),
            '--',
            preview.path,
            input.existingBranch ? preview.branch : preview.commit,
          ],
          undefined,
          0,
        )
        created = { root: preview.root, path: preview.path }
        const now = Date.now(),
          copy: ProjectCopy = {
            id: randomUUID(),
            projectId,
            name: preview.input.name,
            path: await realpath(preview.path),
            branch: preview.branch,
            baseCommit: preview.commit,
            baseBranch: preview.input.base,
            createdAt: now,
            updatedAt: now,
            dirty: false,
            changedCount: 0,
            ahead: 0,
            behind: 0,
            sessions: [],
            error: null,
          }
        data.copies.push(copy)
        return copy
      })
    } catch (error) {
      // Roll back only an untouched worktree created by this attempt. The branch is retained.
      const pending = created as { root: string; path: string } | null
      if (pending) {
        try {
          await git(pending.root, ['worktree', 'remove', '--', pending.path])
        } catch {
          throw new Error(String(error) + '\n' + pending.path)
        }
      }
      throw error
    }
    this.changed()
    return result
  }
  async verify(copy: ProjectCopy): Promise<void> {
    const target = this.host.resolve({ projectId: copy.projectId })
    const list = await git(target.path, ['worktree', 'list', '--porcelain', '-z'])
    const paths = list
      .split('\0')
      .filter(part => part.startsWith('worktree '))
      .map(part => part.slice(9))
    if (!paths.some(path => samePath(path, copy.path)) || samePath(copy.path, target.path))
      throw new Error('工作树不存在或不是 Git 工作树')
    const root = await git(copy.path, ['rev-parse', '--show-toplevel'])
    if (!samePath(root, copy.path)) throw new Error('工作树不存在或不是 Git 工作树')
  }
  async verifyPath(projectId: string, path: string): Promise<void> {
    const target = this.host.resolve({ projectId })
    if (samePath(target.path, path)) return
    const copy = this.store.data.copies.find(c => c.projectId === projectId && samePath(c.path, path))
    if (!copy) throw new Error('副本不存在')
    await this.verify(copy)
  }
  async status(copy: ProjectCopy): Promise<ProjectCopy> {
    try {
      await this.verify(copy)
      const info = await gitInfo(copy.path)
      const counts = (await git(copy.path, ['rev-list', '--left-right', '--count', copy.baseCommit + '...HEAD']))
        .split(/\s+/)
        .map(Number)
      return {
        ...copy,
        branch: info.branch ?? copy.branch,
        dirty: info.dirty,
        changedCount: info.changedCount,
        ahead: counts[1] || 0,
        behind: counts[0] || 0,
        sessions: this.host.sessions(copy.path),
        error: null,
      }
    } catch {
      return { ...copy, sessions: this.host.sessions(copy.path), error: '工作树不存在或不是 Git 工作树' }
    }
  }
  async list(projectId: string): Promise<ProjectCopy[]> {
    this.host.resolve({ projectId })
    return Promise.all(this.store.data.copies.filter(c => c.projectId === projectId).map(c => this.status(c)))
  }
  async open(id: string) {
    const copy = this.get(id)
    await this.verify(copy)
    const record = this.host.create(copy.projectId, copy.path)
    this.changed()
    return record
  }
  private async registered(projectPath: string, path: string): Promise<boolean> {
    const list = await git(projectPath, ['worktree', 'list', '--porcelain', '-z'])
    return list
      .split('\0')
      .filter(part => part.startsWith('worktree '))
      .some(part => samePath(part.slice(9), path))
  }
  async remove(id: string, force = false): Promise<void> {
    await this.store.transaction(async data => {
      const copy = this.get(id)
      const target = this.host.resolve({ projectId: copy.projectId })
      // 只删记录里的副本目录：不能是项目目录，也不能包住项目目录
      // Windows 路径不分大小写，比较前统一成小写
      const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
      if (samePath(copy.path, target.path) || inside(fold(copy.path), fold(target.path)))
        throw new Error('副本目录不正确')
      let valid = true
      try {
        await this.verify(copy)
      } catch {
        valid = false
      }
      if (!valid) {
        await this.removeLeftover(copy, target.path, force)
        data.copies = data.copies.filter(c => c.id !== id)
        return
      }
      const current = await this.status(copy)
      if (current.dirty && !force) throw new Error('副本有未提交修改，请再次确认删除')
      await this.host.withStopped(copy.path, async () => {
        await this.stopServices(copy.path)
        // Recheck after stopping active writers.
        const after = await gitInfo(copy.path)
        if (after.dirty && !force) throw new Error('副本有未提交修改，请再次确认删除')
        if (!(await probeFree(copy.path))) throw await busyError(copy.path)
        try {
          await git(target.path, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', copy.path])
        } catch (error) {
          // 目录被别的进程占着时 git 会删掉文件、注销工作树，但删不掉目录本身
          if (await this.registered(target.path, copy.path)) throw error
          const state = await dirState(copy.path)
          if (state !== 'missing' && !(state === 'empty' && (await removeEmptyDir(copy.path))))
            throw await busyError(copy.path)
        }
        data.copies = data.copies.filter(c => c.id !== id)
      })
    })
    this.changed()
  }
  /** 副本已经不是有效的工作树（git 已注销、或目录被外部删除）：清理残留目录 */
  private async removeLeftover(copy: ProjectCopy, projectPath: string, force: boolean): Promise<void> {
    await git(projectPath, ['worktree', 'prune']).catch(() => '')
    if (await this.registered(projectPath, copy.path)) throw new Error('工作树仍在 Git 登记中，无法清理：' + copy.path)
    const state = await dirState(copy.path)
    if (state === 'missing') return
    if (state === 'full' && !force) throw new Error(`${LEFTOVER_MARK}：${copy.path}，确认后会连同里面的文件一起删除`)
    await this.host.withStopped(copy.path, async () => {
      await this.stopServices(copy.path)
      if (state === 'empty') {
        if (!(await removeEmptyDir(copy.path))) throw await busyError(copy.path)
        return
      }
      if (!(await probeFree(copy.path)) || !(await removeTree(copy.path))) throw await busyError(copy.path)
    })
  }
  async forget(id: string): Promise<void> {
    await this.store.transaction(data => {
      data.copies = data.copies.filter(c => c.id !== id)
    })
    this.changed()
  }
}
