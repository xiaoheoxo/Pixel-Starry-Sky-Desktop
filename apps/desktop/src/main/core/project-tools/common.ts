import { execFile } from 'node:child_process'
import { realpath, mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, dirname } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { WorkspaceRef } from '../../../shared/types/workspace'
import type { AiPlan } from '../../../shared/types/project-tools'
import type { SessionRecord } from '@pixelsky/protocol'
export interface ToolsTarget {
  projectId: string
  name: string
  path: string
}
export interface ToolsHost {
  resolve(ref: WorkspaceRef): ToolsTarget
  plans(projectId: string): AiPlan[] | Promise<AiPlan[]>
  sessions(path: string): { id: string; title: string; state: string }[]
  create(projectId: string, cwd: string): SessionRecord
  withStopped<T>(path: string, action: () => Promise<T>): Promise<T>
}
export const exec = promisify(execFile)
export function value(v: unknown, max = 500, required = false): string {
  if (typeof v !== 'string' || v.length > max || v.includes('\0')) throw new Error('参数不正确')
  const result = v.trim()
  if (required && !result) throw new Error('内容不能为空')
  return result
}
export function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}
export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b)
}
export async function directory(root: string, input: string): Promise<string> {
  const realRoot = await realpath(root),
    candidate = resolve(realRoot, input)
  if (!inside(realRoot, candidate)) throw new Error('服务目录必须在项目内')
  const real = await realpath(candidate)
  if (!inside(realRoot, real)) throw new Error('服务目录必须在项目内')
  return real
}
export async function run(program: string, args: string[], cwd?: string, timeout = 6000): Promise<string> {
  const result = await exec(program, args, {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  })
  return result.stdout.trim()
}
export async function optional(program: string, args: string[], cwd?: string): Promise<string | null> {
  try {
    return await run(program, args, cwd)
  } catch {
    return null
  }
}
export async function git(path: string, args: string[]): Promise<string> {
  return run('git', ['-C', path, ...args], undefined, 120_000)
}
/** `git worktree list --porcelain -z` 的一项：路径和分支（分离 HEAD 时为 'HEAD'） */
export interface GitWorktree {
  path: string
  branch: string | null
}

export function parseWorktrees(out: string): GitWorktree[] {
  const trees: GitWorktree[] = []
  for (const line of out.split('\0')) {
    if (line.startsWith('worktree ')) trees.push({ path: line.slice(9), branch: null })
    else if (!trees.length) continue
    else if (line.startsWith('branch ')) trees[trees.length - 1].branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'detached') trees[trees.length - 1].branch = 'HEAD'
  }
  return trees
}

/** 项目本身和它的副本一次读出（工作区选择用，docs/ui/machines-workspaces.md §8）；不是 Git 仓库时为 null */
export async function gitWorktrees(path: string): Promise<GitWorktree[] | null> {
  const out = await optional('git', ['-C', path, 'worktree', 'list', '--porcelain', '-z'])
  return out === null ? null : parseWorktrees(out)
}

export async function gitInfo(path: string) {
  const root = await optional('git', ['-C', path, 'rev-parse', '--show-toplevel'])
  if (!root) return { root: null, branch: null, commit: null, dirty: false, changedCount: 0 }
  const [branch, commit, status] = await Promise.all([
    optional('git', ['-C', path, 'branch', '--show-current']),
    optional('git', ['-C', path, 'rev-parse', 'HEAD']),
    run('git', ['-C', path, 'status', '--porcelain=v1', '-z']),
  ])
  return {
    root,
    branch: branch || 'HEAD',
    commit,
    dirty: !!status,
    changedCount: status ? status.split('\0').filter(Boolean).length : 0,
  }
}
function restore(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    const items = source.map((item, index) => {
      const prior =
        item && typeof item === 'object' && 'id' in item ? target.find(v => v?.id === item.id) : target[index]
      return restore(prior, item)
    })
    target.splice(0, target.length, ...items)
    return target
  }
  if (target && source && typeof target === 'object' && typeof source === 'object') {
    const a = target as Record<string, unknown>,
      b = source as Record<string, unknown>
    for (const key of Object.keys(a)) if (!(key in b)) delete a[key]
    for (const [key, value] of Object.entries(b)) a[key] = restore(a[key], value)
    return a
  }
  return structuredClone(source)
}
/** Mutations use a single transaction queue, and an atomic replace after the complete snapshot. */
export class JsonStore<T> {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    readonly file: string,
    public data: T,
  ) {}
  async init(): Promise<void> {
    try {
      this.data = JSON.parse(await readFile(this.file, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  transaction<R>(fn: (data: T) => Promise<R> | R): Promise<R> {
    const result = this.queue
      .catch(() => {})
      .then(async () => {
        const before = structuredClone(this.data)
        try {
          const result = await fn(this.data),
            temp = this.file + '.' + randomUUID() + '.tmp'
          await mkdir(dirname(this.file), { recursive: true })
          await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8')
          await rename(temp, this.file)
          return result
        } catch (error) {
          this.data = restore(this.data, before) as T
          throw error
        }
      })
    this.queue = result
    return result
  }
}
