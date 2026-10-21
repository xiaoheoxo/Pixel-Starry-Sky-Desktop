// Git 面板的主进程实现（docs/ui/git-panel.md）。不依赖 Electron：本机由 workspace/project-tools-ipc.ts 注入回收站，
// SSH 辅助进程注入数据目录下的 trash/（core/project-tools/trash.ts）；都不注入时用 git clean。所有命令以参数数组执行，路径前一律加 `--`。
import { spawn } from 'node:child_process'
import { lstat, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { WorkspaceRef } from '../../../shared/types/workspace'
import type {
  GitAction,
  GitBranch,
  GitChangeSet,
  GitCommitFile,
  GitCommit,
  GitCommitContext,
  GitCommitDetail,
  GitCompareResult,
  GitDiff,
  GitDiffInput,
  GitFailure,
  GitLogPage,
  GitLogQuery,
  GitLogScope,
  GitPaths,
  GitPullMode,
  GitRefs,
  GitResult,
  GitStatus,
} from '../../../shared/types/project-tools'
import { workspaceEntry, workspacePath } from '../workspace-files'
import { samePath, value, type ToolsHost } from './common'
import {
  classifyGitError,
  isHash,
  LOG_FORMAT,
  localPath,
  parseCommitFiles,
  parseLog,
  parseLogNumstat,
  parseStatusV2,
} from './git-parse'
import type { TrashFile } from './trash'
import { collectCommitContext } from './commit-context'

export const DIFF_LIMIT = 2 * 1024 * 1024
const OUTPUT_LIMIT = 16 * 1024 * 1024
const MAX_PATHS = 5000
export const GIT_TIMEOUTS = { read: 15_000, diff: 10_000, stage: 30_000, commit: 300_000, remote: 90_000 }
/** 同一仓库的状态查询：从那一轮开始算，这段时间内到的请求共用同一份结果（写操作完成后作废） */
const STATUS_REUSE_MS = 500
/** 工作区 → 仓库根的缓存隔多久重新问一次 git（期间每次只用 stat 核对 .git 还在） */
const REPO_RECHECK_MS = 60_000
const CACHE_LIMIT = 64

/**
 * 不弹任何交互：凭据 / 编辑器 / 分页器都关掉，英文输出便于分类，状态查询不抢 index.lock，
 * 路径按字面处理（不解释 :(exclude) 之类的 pathspec 魔法）。
 */
export const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  LC_ALL: 'C',
  LANGUAGE: 'C',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1',
}

export interface GitRun {
  code: number | null
  stdout: Buffer
  stderr: string
  timedOut: boolean
  missing: boolean
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32')
      spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    /* 进程已经结束 */
  }
}

/** 运行一条 git 命令；超时后结束整个进程树（凭据助手、ssh 子进程不残留） */
export function runGit(
  cwd: string,
  args: string[],
  opts: { timeout: number; input?: string; limit?: number },
): Promise<GitRun> {
  return new Promise(resolvePromise => {
    const child = spawn(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'advice.detachedHead=false', '-C', cwd, ...args],
      {
        env: { ...process.env, ...GIT_ENV },
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      },
    )
    const out: Buffer[] = [],
      limit = opts.limit ?? OUTPUT_LIMIT
    let size = 0,
      stderr = '',
      timedOut = false,
      settled = false
    const finish = (run: GitRun): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolvePromise(run)
      }
    }
    // 超时：结束整个进程树；hook 的子进程（如 sh 里的 sleep）可能仍占着输出管道，所以不再等 close，直接返回
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      child.kill('SIGKILL')
      child.stdout!.destroy()
      child.stderr!.destroy()
      finish({ code: null, stdout: Buffer.concat(out), stderr, timedOut: true, missing: false })
    }, opts.timeout)
    child.stdout!.on('data', (chunk: Buffer) => {
      if (size <= limit) {
        out.push(chunk)
        size += chunk.length
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString('utf8')
    })
    child.on('error', error =>
      finish({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: error.message,
        timedOut,
        missing: (error as NodeJS.ErrnoException).code === 'ENOENT',
      }),
    )
    child.on('close', code => finish({ code, stdout: Buffer.concat(out), stderr, timedOut, missing: false }))
    if (opts.input !== undefined) {
      child.stdin!.on('error', () => {})
      child.stdin!.end(opts.input, 'utf8')
    }
  })
}

const text = (b: Buffer): string => b.toString('utf8')
const lf = (s: string): string => s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
const isBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0)

function pathList(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_PATHS) throw new Error('参数不正确')
  return input.map(p => value(p, 4096, true).replace(/\\/g, '/'))
}
const paths = (input: unknown): GitPaths => (input === 'all' ? 'all' : pathList(input))

/** 一条 git 命令里路径参数的总长上限：Windows 命令行最长 32767 字符，留出 git 路径、其余参数和引号的余量 */
export const ARGS_BUDGET = 24_000
/** 路径很多时分成几批，每批总长不超过 ARGS_BUDGET（单个超长的自成一批） */
export function pathBatches(list: string[], budget = ARGS_BUDGET): string[][] {
  const out: string[][] = []
  let batch: string[] = [],
    size = 0
  for (const p of list) {
    const cost = p.length + 3
    if (batch.length && size + cost > budget) {
      out.push(batch)
      batch = []
      size = 0
    }
    batch.push(p)
    size += cost
  }
  if (batch.length) out.push(batch)
  return out
}

class GitError extends Error {
  constructor(readonly failure: GitFailure) {
    super(failure.detail || failure.kind)
  }
}

interface Repo {
  root: string
  prefix: string
  workspace: string
}

/** 放弃未跟踪文件时的去处：本机进系统回收站，远端移到数据目录的 trash/（docs/ui/git-panel.md §2.4）；不给则用 git clean */
export type GitTrash = (files: TrashFile[]) => Promise<void>

const EMPTY_STATUS: GitStatus = {
  repo: false,
  missing: false,
  root: null,
  branch: null,
  detached: false,
  head: null,
  initial: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  remotes: [],
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  truncated: false,
  operation: null,
  fetchedAt: null,
  busySessions: 0,
}

const pathKey = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/** 状态里要看的 git 内部文件（rev-parse --git-path 的顺序）；最后的 config 不进状态，只用来判断 remote 有没有变 */
const STATE_PATHS = [
  'MERGE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'FETCH_HEAD',
  'config',
]
const CONFIG_AT = STATE_PATHS.length - 1

/** 一个仓库的固定信息：git 内部路径（worktree / submodule 里 .git 是文件，由 rev-parse 带到真正的目录）和 remote 缓存 */
interface RepoMeta {
  paths: string[] | null
  configKey: string | null
  remotes: string[] | null
}

/** 同一仓库同一工作区前缀的状态查询：同时最多一轮在跑、一轮在排队 */
interface StatusRun {
  gen: number
  startedAt: number
  promise: Promise<GitStatus>
}
interface StatusEntry {
  root: string
  /** 写操作完成后加一：之前开始的那一轮结果不再复用 */
  gen: number
  running: StatusRun | null
  next: Promise<GitStatus> | null
  done: { gen: number; startedAt: number; status: GitStatus } | null
}

/** 文件的 mtime + 大小，读不到是 null */
const fileKey = (path: string): Promise<string | null> =>
  stat(path).then(
    info => `${info.mtimeMs}:${info.size}`,
    () => null,
  )

export class GitTools {
  private locks = new Map<string, Promise<unknown>>()
  private repos = new Map<string, { repo: Repo; at: number }>()
  private resolving = new Map<string, Promise<Repo | 'missing' | null>>()
  private metas = new Map<string, RepoMeta>()
  private statuses = new Map<string, StatusEntry>()
  constructor(
    private host: ToolsHost,
    private changed: () => void,
    private opts: {
      trash?: GitTrash
      timeouts?: Partial<typeof GIT_TIMEOUTS>
      /** 状态结果复用多久（毫秒）；测试里设 0 关掉 */
      statusReuseMs?: number
    } = {},
  ) {}

  private timeout(kind: keyof typeof GIT_TIMEOUTS): number {
    return this.opts.timeouts?.[kind] ?? GIT_TIMEOUTS[kind]
  }

  /**
   * 工作区所在的仓库。仓库根按工作区缓存：每次只用 stat 核对 .git（根目录还有，工作区到根目录之间没有新建的），
   * 每 60 秒或核对不过再问一次 git；不是仓库、没装 git 不缓存。同一时刻的多次查询共用一次 rev-parse。
   * `recheck` 不用缓存、重新问 git（写操作前、手动刷新）
   */
  private async repo(ref: WorkspaceRef, recheck = false): Promise<Repo | 'missing' | null> {
    const workspace = this.host.resolve(ref).path
    const key = pathKey(resolve(workspace))
    const hit = this.repos.get(key)
    if (hit) {
      if (!recheck && Date.now() - hit.at < REPO_RECHECK_MS && (await this.repoIntact(hit.repo))) return hit.repo
      this.repos.delete(key)
    }
    let job = recheck ? undefined : this.resolving.get(key)
    if (!job) {
      const own: Promise<Repo | 'missing' | null> = this.lookup(workspace, key).finally(() => {
        if (this.resolving.get(key) === own) this.resolving.delete(key)
      })
      this.resolving.set(key, (job = own))
    }
    return job
  }

  private async lookup(workspace: string, key: string): Promise<Repo | 'missing' | null> {
    const run = await runGit(workspace, ['rev-parse', '--show-toplevel', '--show-prefix'], {
      timeout: this.timeout('read'),
    })
    if (run.missing) return 'missing'
    if (run.code !== 0) return null
    const [root = '', prefix = ''] = text(run.stdout).split(/\r?\n/)
    const repo = { root: resolve(root.trim()), prefix: prefix.trim(), workspace }
    this.repos.set(key, { repo, at: Date.now() })
    return repo
  }

  /** 缓存的仓库根还对：根目录的 .git 还在，工作区和中间各级目录都没有新建 .git（新建了，仓库根就换成了它） */
  private async repoIntact(repo: Repo): Promise<boolean> {
    const exists = (dir: string) =>
      stat(join(dir, '.git')).then(
        () => true,
        () => false,
      )
    const inner: string[] = []
    for (let dir = resolve(repo.workspace); !samePath(dir, repo.root); ) {
      inner.push(dir)
      const up = dirname(dir)
      // 工作区不在仓库根下面（符号链接等）：只查工作区自己
      if (up === dir) {
        inner.splice(1)
        break
      }
      dir = up
    }
    const [own, ...nested] = await Promise.all([exists(repo.root), ...inner.map(exists)])
    return own && !nested.some(Boolean)
  }

  private async exec(
    repo: Repo,
    action: GitAction,
    args: string[],
    kind: keyof typeof GIT_TIMEOUTS,
    input?: string,
  ): Promise<string> {
    const run = await runGit(repo.root, args, { timeout: this.timeout(kind), input })
    if (run.code !== 0 || run.timedOut)
      throw new GitError(
        classifyGitError(run.stderr || text(run.stdout), { action, timedOut: run.timedOut, missing: run.missing }),
      )
    return text(run.stdout)
  }

  /** hook 失败时 git 只转发 hook 自己的输出，无法从文字判断：原因不明且仓库有对应 hook 时归为 hook */
  private async hookFailure(repo: Repo, error: unknown, names: string[]): Promise<never> {
    if (!(error instanceof GitError) || error.failure.kind !== 'unknown') throw error
    const configured = text(
      (await runGit(repo.root, ['config', 'core.hooksPath'], { timeout: this.timeout('read') })).stdout,
    ).trim()
    const dir = configured
      ? resolve(repo.root, configured)
      : resolve(
          repo.root,
          text(
            (await runGit(repo.root, ['rev-parse', '--git-path', 'hooks'], { timeout: this.timeout('read') })).stdout,
          ).trim(),
        )
    const found = await Promise.all(
      names.map(name =>
        stat(resolve(dir, name)).then(
          info => info.isFile(),
          () => false,
        ),
      ),
    )
    if (found.some(Boolean)) throw new GitError({ ...error.failure, kind: 'hook', remedies: [] })
    throw error
  }

  private busy(repo: Repo): number {
    return this.host.sessions(repo.workspace).filter(s => s.state !== 'idle').length
  }

  /**
   * 工作区的 Git 状态。同一仓库同时到的请求共用一轮 git status，结果再复用 0.5 秒；写操作完成后作废。
   * `fresh` 要求读一轮在此之后才开始的（写操作前后、需要准确判断的地方用）；`recheck` 还要重新确认仓库根（手动刷新）。
   */
  async status(ref: WorkspaceRef, fresh = false, recheck = false): Promise<GitStatus> {
    const repo = await this.repo(ref, recheck)
    if (recheck) fresh = true
    if (repo === 'missing') return { ...EMPTY_STATUS, missing: true }
    if (!repo) return EMPTY_STATUS
    const status = await this.sharedStatus(repo, fresh)
    // 会话是否在运行不用 git 查，每次按当前的取
    return { ...status, busySessions: this.busy(repo) }
  }

  private sharedStatus(repo: Repo, fresh: boolean): Promise<GitStatus> {
    const reuse = this.opts.statusReuseMs ?? STATUS_REUSE_MS
    const key = pathKey(repo.root) + '\0' + repo.prefix
    let entry = this.statuses.get(key)
    if (!entry) {
      this.prune()
      this.statuses.set(key, (entry = { root: pathKey(repo.root), gen: 0, running: null, next: null, done: null }))
    }
    const now = Date.now()
    const { done, running } = entry
    if (!fresh && done && done.gen === entry.gen && now - done.startedAt < reuse) return Promise.resolve(done.status)
    if (!running) return this.launch(repo, entry)
    if (!fresh && running.gen === entry.gen && now - running.startedAt < reuse) return running.promise
    // 正在跑的那一轮开始得太早（或中间有过写操作）：排一轮接在它后面，之后到的请求共用这一轮
    entry.next ??= running.promise
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        entry.next = null
        return this.launch(repo, entry)
      })
    return entry.next
  }

  private launch(repo: Repo, entry: StatusEntry): Promise<GitStatus> {
    const run: StatusRun = { gen: entry.gen, startedAt: Date.now(), promise: Promise.resolve(EMPTY_STATUS) }
    const job = this.readStatus(repo)
    // 同步部分（起 git 进程）返回后才算这一轮开始
    run.startedAt = Date.now()
    run.promise = job
      .then(
        status => {
          if (run.gen === entry.gen) entry.done = { gen: run.gen, startedAt: run.startedAt, status }
          return status
        },
        error => {
          entry.done = null
          throw error
        },
      )
      .finally(() => {
        if (entry.running === run) entry.running = null
      })
    entry.running = run
    return run.promise
  }

  /** 这个仓库发生了写操作：之前的结果不再复用，开始得早的那一轮即使跑完也不记下来 */
  private invalidate(repo: Repo): void {
    const root = pathKey(repo.root)
    for (const entry of this.statuses.values())
      if (entry.root === root) {
        entry.gen++
        entry.done = null
      }
  }

  /** 状态记录只留最近用过的：超过上限时丢掉闲着的 */
  private prune(): void {
    if (this.statuses.size < CACHE_LIMIT) return
    for (const [key, entry] of this.statuses) if (!entry.running && !entry.next) this.statuses.delete(key)
  }

  /** git 内部文件的路径（worktree / submodule 里 .git 是文件，rev-parse 会带到真正的目录）；读失败是 null */
  private async gitPaths(repo: Repo): Promise<string[] | null> {
    const args = ['rev-parse']
    for (const name of STATE_PATHS) args.push('--git-path', name)
    const run = await runGit(repo.root, args, { timeout: this.timeout('read') })
    if (run.code !== 0) return null
    const lines = text(run.stdout)
      .split(/\r?\n/)
      .map(p => p.trim())
      .filter(Boolean)
    return lines.length === STATE_PATHS.length ? lines.map(p => resolve(repo.root, p)) : null
  }

  /** 真正跑 git。固定不变的东西缓存：git 内部路径只问一次，remote 只在 config 变了才重问，常态下只剩 git status 一个进程 */
  private async readStatus(repo: Repo): Promise<GitStatus> {
    const rootKey = pathKey(repo.root)
    const cached = this.metas.get(rootKey)
    // 先把 git status 起起来（Windows 上 spawn 是同步的，可能很慢；launch 要等它返回才开始计复用窗口）
    const statusJob = runGit(repo.root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], {
      timeout: this.timeout('read'),
    })
    const knownKey = cached?.paths ? await fileKey(cached.paths[CONFIG_AT]) : null
    const remotesKnown = !!cached?.remotes && !!knownKey && cached.configKey === knownKey
    const [statusRun, remotesRun, pathsRun] = await Promise.all([
      statusJob,
      remotesKnown ? null : runGit(repo.root, ['remote'], { timeout: this.timeout('read') }),
      cached?.paths ? null : this.gitPaths(repo),
    ])
    if (statusRun.code !== 0)
      throw new Error(
        statusRun.timedOut ? 'Git 状态读取超时' : statusRun.stderr.trim().split('\n').at(-1) || 'Git 状态读取失败',
      )
    const parsed = parseStatusV2(text(statusRun.stdout), repo.prefix)
    const gitPaths = cached?.paths ?? pathsRun
    const exists = await Promise.all(
      (gitPaths ?? []).slice(0, CONFIG_AT).map(p =>
        stat(p).then(
          info => info,
          () => null,
        ),
      ),
    )
    const [merge, rebaseMerge, rebaseApply, cherry, revert, fetchHead] = exists
    const operation =
      rebaseMerge || rebaseApply ? 'rebase' : merge ? 'merge' : cherry ? 'cherry-pick' : revert ? 'revert' : null
    let remotes = cached?.remotes ?? []
    let meta: RepoMeta | null = null
    if (remotesRun) {
      remotes = text(remotesRun.stdout)
        .split(/\r?\n/)
        .map(r => r.trim())
        .filter(Boolean)
      // 读成功且拿得到 config 的指纹才记下：下次 config 没变就不再起进程
      const configKey = knownKey ?? (gitPaths ? await fileKey(gitPaths[CONFIG_AT]) : null)
      if (remotesRun.code === 0 && configKey) meta = { paths: gitPaths, configKey, remotes }
    }
    if (gitPaths && !cached?.paths) meta ??= { paths: gitPaths, configKey: null, remotes: null }
    if (meta) this.remember(rootKey, meta)
    return {
      ...EMPTY_STATUS,
      ...parsed,
      repo: true,
      root: repo.root,
      remotes,
      operation,
      fetchedAt: fetchHead ? fetchHead.mtimeMs : null,
    }
  }

  private remember(rootKey: string, meta: RepoMeta): void {
    if (this.metas.size >= CACHE_LIMIT && !this.metas.has(rootKey)) this.metas.delete(this.metas.keys().next().value!)
    this.metas.set(rootKey, meta)
  }

  private async blob(repo: Repo, spec: string): Promise<Buffer | null> {
    const run = await runGit(repo.root, ['cat-file', 'blob', spec], {
      timeout: this.timeout('diff'),
      limit: DIFF_LIMIT,
    })
    return run.code === 0 ? run.stdout : null
  }

  private async worktree(repo: Repo, path: string): Promise<Buffer | null> {
    let file: string
    try {
      file = await workspacePath(repo.root, path, 'file')
    } catch {
      return null
    }
    const info = await stat(file)
    if (info.size > DIFF_LIMIT) return Buffer.alloc(DIFF_LIMIT + 1)
    return readFile(file)
  }

  async diff(ref: WorkspaceRef, input: GitDiffInput): Promise<GitDiff> {
    const repo = await this.repo(ref)
    if (!repo || repo === 'missing') throw new Error('当前项目不是可用的 Git 仓库')
    const path = value(input.path, 4096, true).replace(/\\/g, '/')
    const orig = input.origPath ? value(input.origPath, 4096, true).replace(/\\/g, '/') : path
    if (!['staged', 'unstaged', 'untracked', 'conflicted', 'commit'].includes(input.area)) throw new Error('参数不正确')
    let a: Buffer | null, b: Buffer | null
    if (input.area === 'commit') {
      // 历史里的一个文件（docs/ui/git-panel.md §9.5）：from 为 null 是根提交，和空文件比；删除的文件 to 那边没有
      const from = input.from ?? null
      if (!isHash(input.to) || (from !== null && !isHash(from))) throw new Error('参数不正确')
      ;[a, b] = await Promise.all([
        from ? this.blob(repo, `${from}:${orig}`) : Promise.resolve(null),
        this.blob(repo, `${input.to}:${path}`),
      ])
    } else if (input.area === 'staged')
      [a, b] = await Promise.all([this.blob(repo, `HEAD:${orig}`), this.blob(repo, `:${path}`)])
    else if (input.area === 'unstaged')
      [a, b] = await Promise.all([this.blob(repo, `:${path}`), this.worktree(repo, path)])
    else if (input.area === 'untracked') [a, b] = [Buffer.alloc(0), await this.worktree(repo, path)]
    else [a, b] = await Promise.all([this.blob(repo, `:2:${path}`), this.worktree(repo, path)])
    const tooLarge = (a?.length ?? 0) > DIFF_LIMIT || (b?.length ?? 0) > DIFF_LIMIT
    const binary = !tooLarge && ((!!a && isBinary(a)) || (!!b && isBinary(b)))
    if (tooLarge || binary) return { path, original: null, modified: null, binary, tooLarge }
    return { path, original: a ? lf(text(a)) : null, modified: b ? lf(text(b)) : null, binary: false, tooLarge: false }
  }

  /** AI 写提交信息要发给模型的改动（docs/ui/ai-commit-codex-warnings-history.md §2.2）：只读，按上限截好 */
  async commitContext(ref: WorkspaceRef, input: unknown): Promise<GitCommitContext> {
    const scope = (input as { scope?: unknown } | null)?.scope
    if (scope !== 'staged' && scope !== 'all') throw new Error('参数不正确')
    const repo = await this.repo(ref)
    if (!repo || repo === 'missing') throw new Error('当前项目不是可用的 Git 仓库')
    return collectCommitContext(repo.root, scope, async (args, opts) => {
      const run = await runGit(repo.root, args, { timeout: this.timeout('diff'), ...opts })
      return { ok: run.code === 0 && !run.timedOut, stdout: run.stdout }
    })
  }

  async branches(ref: WorkspaceRef): Promise<GitBranch[]> {
    const repo = await this.repo(ref)
    if (!repo || repo === 'missing') return []
    const out = await this.exec(
      repo,
      'switch',
      [
        'for-each-ref',
        '--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(committerdate:unix)%00%(HEAD)%00%(worktreepath)',
        'refs/heads',
        'refs/remotes',
      ],
      'read',
    )
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap(line => {
        const [full, name, upstream, date, head, worktree] = line.split('\0')
        if (!full || full.endsWith('/HEAD')) return []
        const current = head === '*'
        return [
          {
            name,
            remote: full.startsWith('refs/remotes/'),
            upstream: upstream || null,
            current,
            worktree: !current && worktree ? worktree : null,
            committedAt: Number(date) * 1000 || 0,
          },
        ]
      })
      .sort((a, b) => Number(b.current) - Number(a.current) || b.committedAt - a.committedAt)
  }

  // -------------------------------------------------------------------------
  // 提交历史（docs/ui/git-panel.md §9）：只读，不抢 index.lock
  // -------------------------------------------------------------------------

  private versionCache: Promise<number[]> | null = null
  /** git 版本号（[2, 45, 1]）；读不到时当作很旧 */
  private version(): Promise<number[]> {
    this.versionCache ??= runGit('.', ['version'], { timeout: this.timeout('read') }).then(run =>
      (/(\d+)\.(\d+)(?:\.(\d+))?/.exec(text(run.stdout))?.slice(1) ?? ['0', '0']).map(n => Number(n) || 0),
    )
    return this.versionCache
  }

  private async historyRepo(ref: WorkspaceRef): Promise<Repo> {
    const repo = await this.repo(ref)
    if (repo === 'missing') throw new GitError({ kind: 'missing', action: 'history', detail: '', remedies: [] })
    if (!repo) throw new GitError({ kind: 'notRepo', action: 'history', detail: '', remedies: [] })
    return repo
  }

  /** 读一个可能不存在的值（没有上游、还没有提交）：失败时返回空字符串 */
  private async maybe(repo: Repo, args: string[]): Promise<string> {
    const run = await runGit(repo.root, args, { timeout: this.timeout('read') })
    return run.code === 0 ? text(run.stdout).trim() : ''
  }

  async refs(ref: WorkspaceRef): Promise<GitRefs> {
    const repo = await this.historyRepo(ref)
    const [list, head, branch, upstream, remoteHead] = await Promise.all([
      this.exec(
        repo,
        'history',
        ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'],
        'read',
      ),
      this.maybe(repo, ['rev-parse', '--verify', '-q', 'HEAD']),
      this.maybe(repo, ['symbolic-ref', '-q', '--short', 'HEAD']),
      this.maybe(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
      this.maybe(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']),
    ])
    const local: string[] = [],
      remote: string[] = [],
      tags: string[] = []
    for (const full of list.split(/\r?\n/).filter(Boolean)) {
      if (full.startsWith('refs/heads/')) local.push(full.slice(11))
      else if (full.startsWith('refs/remotes/')) {
        if (!full.endsWith('/HEAD')) remote.push(full.slice(13))
      } else if (full.startsWith('refs/tags/')) tags.push(full.slice(10))
    }
    // 基础分支：本地 main / master，再看远端默认分支和 origin/main / origin/master；当前就在它上面时不算
    const candidates = ['main', 'master', remoteHead, 'origin/main', 'origin/master'].filter(Boolean)
    const base =
      candidates.find(
        name => (local.includes(name) || remote.includes(name)) && name !== branch && name !== upstream,
      ) ?? null
    const onBase = !!branch && candidates.slice(0, 2).includes(branch)
    return {
      head: head || null,
      branch: branch || null,
      upstream: upstream || null,
      base: onBase ? null : base,
      local,
      remote,
      tags,
    }
  }

  /** 范围 → git log 的起点（完整引用名，避免和文件名、同名标签混淆）；自选的名字必须是已有的引用 */
  private revisions(refs: GitRefs, scope: GitLogScope): { options: string[]; revs: string[] } {
    const full = (name: string): string | null =>
      refs.local.includes(name)
        ? `refs/heads/${name}`
        : refs.remote.includes(name)
          ? `refs/remotes/${name}`
          : refs.tags.includes(name)
            ? `refs/tags/${name}`
            : null
    const head = refs.head ? ['HEAD'] : []
    if (scope === 'all') {
      const any = refs.head || refs.local.length || refs.remote.length || refs.tags.length
      return any ? { options: ['--branches', '--remotes', '--tags'], revs: head } : { options: [], revs: [] }
    }
    if (Array.isArray(scope)) {
      if (scope.length > 200) throw new Error('参数不正确')
      const picked = scope.map(name => (name === 'HEAD' ? (refs.head ? 'HEAD' : null) : full(value(name, 255, true))))
      if (picked.some(p => p === null)) throw new Error('分支不存在，请刷新后重试')
      return { options: [], revs: picked as string[] }
    }
    if (scope !== 'auto') throw new Error('参数不正确')
    const extra = [refs.upstream, refs.base].map(name => (name ? full(name) : null))
    return { options: [], revs: [...head, ...extra.filter((r): r is string => !!r)] }
  }

  /** git 2.31 起 --diff-merges=first-parent 让合并提交也有统计 */
  private async mergeStats(): Promise<boolean> {
    const [major = 0, minor = 0] = await this.version()
    return major > 2 || (major === 2 && minor >= 31)
  }

  async log(ref: WorkspaceRef, input: unknown): Promise<GitLogPage> {
    const q = (input ?? {}) as Partial<GitLogQuery>
    const skip = Number(q.skip) || 0,
      limit = Number(q.limit) || 50
    if (skip < 0 || limit < 1 || limit > 500 || !Number.isInteger(skip) || !Number.isInteger(limit))
      throw new Error('参数不正确')
    const search = q.search === undefined || q.search === null ? '' : value(q.search, 200).trim()
    const repo = await this.historyRepo(ref)
    const filePath = q.path === undefined || q.path === null ? null : this.historyPath(repo, q.path, q.pathBase)
    const refs = await this.refs(ref)
    const { options, revs } = this.revisions(refs, q.scope ?? 'auto')
    const [mergeStats, shallow] = await Promise.all([
      this.mergeStats(),
      this.maybe(repo, ['rev-parse', '--is-shallow-repository']),
    ])
    const base = [
      '-c',
      'log.showSignature=false',
      'log',
      LOG_FORMAT,
      '--decorate=full',
      '--shortstat',
      '--no-ext-diff',
      ...(mergeStats ? ['--diff-merges=first-parent'] : []),
    ]
    const page = (commits: GitCommit[], more: boolean): GitLogPage => ({
      commits,
      more,
      shallow: shallow === 'true',
      ...(filePath ? { path: filePath } : {}),
    })
    if (!revs.length && !options.length) return page([], false)
    const tail = [...options, '--end-of-options', ...revs, ...(filePath ? ['--', filePath] : [])]
    const read = async (args: string[]): Promise<GitCommit[]> => {
      if (!filePath) return parseLog(await this.exec(repo, 'history', [...base, ...args, ...tail], 'read'), mergeStats)
      // 单文件历史（§9.15）：跟着改名往前找；状态和路径、增删行数分两次取（--name-status 会盖过 --numstat）
      const fileBase = base.filter(a => a !== '--shortstat' && !a.startsWith('--diff-merges'))
      const [named, counted] = await Promise.all([
        this.exec(repo, 'history', [...fileBase, '--follow', '-M', '--name-status', ...args, ...tail], 'read'),
        this.exec(repo, 'history', [...fileBase, '--follow', '-M', '--numstat', ...args, ...tail], 'read'),
      ])
      const counts = parseLogNumstat(counted)
      return parseLog(named, mergeStats).map(c => {
        const [insertions, deletions] = counts.get(c.hash) ?? [null, null]
        return c.file ? { ...c, file: { ...c.file, insertions, deletions } } : c
      })
    }
    if (!search) {
      // --follow 配 --skip 时，跳过的范围跨过改名就跟丢了（git 2.55 实测）：单文件历史从头取再切
      if (filePath) {
        const commits = await read([`-n${skip + limit + 1}`])
        return page(commits.slice(skip, skip + limit), commits.length > skip + limit)
      }
      const commits = await read(['--topo-order', `-n${skip + limit + 1}`, `--skip=${skip}`])
      return page(commits.slice(0, limit), commits.length > limit)
    }
    // 单文件历史里搜索：--grep 会把改名那个提交也筛掉，--follow 就跟丢了；取这个文件的全部历史（最多 5000）再筛
    if (filePath) {
      const needle = search.toLowerCase()
      const all = await read(['-n5000'])
      const found = all.filter(
        c =>
          c.subject.toLowerCase().includes(needle) ||
          c.body.toLowerCase().includes(needle) ||
          c.author.toLowerCase().includes(needle) ||
          c.hash.startsWith(needle),
      )
      return page(found.slice(skip, skip + limit), found.length > skip + limit)
    }
    // 搜索：提交信息、作者分开查（git 会把两者按「且」组合），哈希前缀单独解析；合并去重后按提交时间排
    const want = skip + limit + 1
    const [byMessage, byAuthor, byHash] = await Promise.all([
      read(['--regexp-ignore-case', '--fixed-strings', `--grep=${search}`, `-n${want}`]),
      read(['--regexp-ignore-case', '--fixed-strings', `--author=${search}`, `-n${want}`]),
      /^[0-9a-f]{4,64}$/i.test(search)
        ? this.maybe(repo, ['rev-parse', '--verify', '-q', '--end-of-options', `${search.toLowerCase()}^{commit}`])
        : Promise.resolve(''),
    ])
    const exact = isHash(byHash)
      ? parseLog(
          await this.exec(repo, 'history', [...base, '--no-walk', '--end-of-options', byHash], 'read'),
          mergeStats,
        )
      : []
    const seen = new Set<string>()
    const merged = [...exact, ...[...byMessage, ...byAuthor].sort((a, b) => b.committedAt - a.committedAt)].filter(
      c => !seen.has(c.hash) && !!seen.add(c.hash),
    )
    return page(merged.slice(skip, skip + limit), merged.length > skip + limit)
  }

  /** 单文件历史的路径 → 相对仓库根目录；不接受 .. 和 . 段 */
  private historyPath(repo: Repo, path: unknown, base: unknown): string {
    const p = value(path, 4096, true)
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
    if (!p || p.split('/').some(seg => !seg || seg === '..' || seg === '.')) throw new Error('参数不正确')
    return base === 'repo' ? p : repo.prefix + p
  }

  /** 两个提交之间的改动文件；from 为 null 时是根提交（和空树比） */
  private async changeSet(repo: Repo, from: string | null, to: string): Promise<GitChangeSet> {
    const diff = (format: string) =>
      from
        ? ['diff', '--no-ext-diff', '--no-textconv', '-M', format, '-z', '--end-of-options', from, to]
        : ['diff-tree', '--no-commit-id', '--root', '-r', '-M', format, '-z', '--end-of-options', to]
    const [names, nums] = await Promise.all([
      this.exec(repo, 'history', diff('--name-status'), 'read'),
      this.exec(repo, 'history', diff('--numstat'), 'read'),
    ])
    const set = parseCommitFiles(names, nums)
    return { from, to, files: await this.withLocal(repo, set.files), truncated: set.truncated }
  }

  /** 给提交里的文件填上 local：现在工作区里还有这个文件才能「打开文件」（历史里的文件可能后来删了或改名了） */
  private async withLocal(repo: Repo, files: GitCommitFile[]): Promise<GitCommitFile[]> {
    return Promise.all(
      files.map(async file => {
        const local = file.code === 'D' ? null : localPath(file.path, repo.prefix)
        if (!local) return { ...file, local: null }
        const info = await stat(resolve(repo.root, file.path)).catch(() => null)
        return { ...file, local: info?.isFile() ? local : null }
      }),
    )
  }

  async show(ref: WorkspaceRef, hash: unknown): Promise<GitCommitDetail> {
    if (!isHash(hash)) throw new Error('参数不正确')
    const repo = await this.historyRepo(ref)
    const [commit] = parseLog(
      await this.exec(
        repo,
        'history',
        ['-c', 'log.showSignature=false', 'log', LOG_FORMAT, '--decorate=full', '--no-walk', '--end-of-options', hash],
        'read',
      ),
    )
    if (!commit) throw new Error('找不到这个提交')
    // 合并提交和第一父提交比较（docs/ui/git-panel.md §9.5）
    const changes = await this.changeSet(repo, commit.parents[0] ?? null, commit.hash)
    // 上面没带 --shortstat：统计按改动文件算（二进制文件不计行数）
    const stat = changes.files.reduce(
      (s, f) => ({
        files: s.files + 1,
        insertions: s.insertions + (f.insertions ?? 0),
        deletions: s.deletions + (f.deletions ?? 0),
      }),
      { files: 0, insertions: 0, deletions: 0 },
    )
    return { ...changes, commit: { ...commit, stat } }
  }

  /** 哈希或已有引用的短名 → 提交哈希；不认识的名字报错（不把输入当成任意 revision 表达式） */
  private async resolveCommit(repo: Repo, refs: GitRefs, name: unknown): Promise<string> {
    let rev: string
    if (isHash(name)) rev = name
    else {
      const n = value(name, 255, true)
      rev =
        n === 'HEAD' && refs.head
          ? 'HEAD'
          : refs.local.includes(n)
            ? `refs/heads/${n}`
            : refs.remote.includes(n)
              ? `refs/remotes/${n}`
              : refs.tags.includes(n)
                ? `refs/tags/${n}`
                : ''
      if (!rev) throw new Error('分支不存在，请刷新后重试')
    }
    const out = await this.exec(
      repo,
      'history',
      ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`],
      'read',
    )
    return out.trim()
  }

  async compare(ref: WorkspaceRef, target: unknown): Promise<GitCompareResult> {
    const repo = await this.historyRepo(ref)
    const refs = await this.refs(ref)
    let from: string, to: string
    if (target && typeof target === 'object') {
      // 任意两点（§9.6 第二期「和…比较」）：直接比较两端，提交数是 from..to
      const t = target as { from?: unknown; to?: unknown }
      ;[from, to] = await Promise.all([this.resolveCommit(repo, refs, t.from), this.resolveCommit(repo, refs, t.to)])
    } else {
      const kind = target
      if (kind !== 'outgoing' && kind !== 'incoming' && kind !== 'base') throw new Error('参数不正确')
      const other = kind === 'base' ? refs.base : refs.upstream
      if (!refs.head || !other) throw new Error(kind === 'base' ? '没有找到基础分支' : '当前分支没有上游')
      const otherRef = refs.local.includes(other) ? `refs/heads/${other}` : `refs/remotes/${other}`
      const [tip, mergeBase] = await Promise.all([
        this.exec(repo, 'history', ['rev-parse', '--verify', '--end-of-options', `${otherRef}^{commit}`], 'read'),
        this.exec(repo, 'history', ['merge-base', '--end-of-options', 'HEAD', otherRef], 'read'),
      ])
      from = mergeBase.trim()
      to = kind === 'incoming' ? tip.trim() : refs.head
    }
    const [changes, count] = await Promise.all([
      this.changeSet(repo, from, to),
      this.exec(repo, 'history', ['rev-list', '--count', '--end-of-options', `${from}..${to}`], 'read'),
    ])
    return { ...changes, commits: Number(count.trim()) || 0 }
  }

  /**
   * 历史里会改动仓库的操作（docs/ui/git-panel.md §9.6 第二期）。动工作区的（检出、cherry-pick、revert、reset）
   * 有会话在运行时拒绝；只动引用的（新建 / 删除标签、删除分支）不拦。合并提交的 cherry-pick / revert 按第一父提交。
   */
  historyAction(ref: WorkspaceRef, input: unknown): Promise<GitResult> {
    const v = (input ?? {}) as Record<string, unknown>
    const kind = v.kind
    if (['checkout', 'cherryPick', 'revert', 'reset', 'tag'].includes(kind as string) && !isHash(v.hash))
      throw new Error('参数不正确')
    const hash = v.hash as string
    const invalid = (detail: string) => new GitError({ kind: 'invalid', action: 'history', detail, remedies: [] })
    switch (kind) {
      case 'checkout':
        return this.mutate(
          ref,
          'history',
          async repo => {
            await this.exec(repo, 'history', ['switch', '--detach', hash], 'stage')
          },
          true,
        )
      case 'cherryPick':
      case 'revert':
        return this.mutate(
          ref,
          'history',
          async repo => {
            const line = await this.exec(
              repo,
              'history',
              ['rev-list', '--parents', '-n1', '--end-of-options', hash],
              'read',
            )
            const merge = line.trim().split(' ').length > 2 ? ['-m', '1'] : []
            const args = kind === 'revert' ? ['revert', '--no-edit', ...merge, hash] : ['cherry-pick', ...merge, hash]
            await this.exec(repo, 'history', args, 'commit').catch(error =>
              this.hookFailure(repo, error, ['pre-commit', 'prepare-commit-msg', 'commit-msg']),
            )
          },
          true,
        )
      case 'reset': {
        const mode = v.mode
        if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') throw new Error('参数不正确')
        return this.mutate(
          ref,
          'history',
          async (repo, status) => {
            if (status.operation) throw invalid('有进行中的合并、变基或 cherry-pick，请先中止或完成')
            await this.exec(repo, 'history', ['reset', '-q', `--${mode}`, hash], 'stage')
          },
          true,
        )
      }
      case 'tag': {
        const name = value(v.name, 255, true)
        const message = typeof v.message === 'string' ? v.message.trim().slice(0, 20_000) : ''
        return this.mutate(ref, 'history', async repo => {
          if (name.startsWith('-')) throw invalid('标签名不能以 - 开头')
          await this.exec(repo, 'history', ['check-ref-format', `refs/tags/${name}`], 'read').catch(() => {
            throw invalid('标签名不符合 Git 规则')
          })
          // 有说明时建附注标签（说明从标准输入传入）
          await this.exec(
            repo,
            'history',
            message
              ? ['tag', '-a', '-F', '-', '--end-of-options', name, hash]
              : ['tag', '--end-of-options', name, hash],
            'stage',
            message || undefined,
          )
        })
      }
      case 'deleteBranch':
      case 'deleteTag': {
        const name = value(v.name, 255, true)
        return this.mutate(ref, 'history', async repo => {
          const refs = await this.refs(ref)
          if (!(kind === 'deleteBranch' ? refs.local : refs.tags).includes(name))
            throw new Error(kind === 'deleteBranch' ? '分支不存在，请刷新后重试' : '标签不存在，请刷新后重试')
          if (kind === 'deleteBranch' && name === refs.branch) throw invalid('不能删除当前分支')
          await this.exec(
            repo,
            'history',
            kind === 'deleteTag'
              ? ['tag', '-d', '--end-of-options', name]
              : ['branch', v.force === true ? '-D' : '-d', '--end-of-options', name],
            'stage',
          )
        })
      }
      default:
        throw new Error('参数不正确')
    }
  }

  /** 写操作：按仓库串行；成功后通知界面并返回最新状态，失败返回分类后的原因（不抛错，方便跨 IPC / SSH） */
  private async mutate(
    ref: WorkspaceRef,
    action: GitAction,
    fn: (repo: Repo, status: GitStatus) => Promise<void>,
    guard = false,
  ): Promise<GitResult> {
    // 改动仓库前重新确认仓库根：缓存没发现的变化（.git 换了、外面套了新仓库）不能让写操作落到别的仓库
    const repo = await this.repo(ref, true)
    if (repo === 'missing')
      return { ok: false, failure: { kind: 'missing', action, detail: '', remedies: [] }, status: null }
    if (!repo) return { ok: false, failure: { kind: 'notRepo', action, detail: '', remedies: [] }, status: null }
    const key = pathKey(repo.root)
    const prior = this.locks.get(key) ?? Promise.resolve()
    const task = prior
      .catch(() => {})
      .then(async (): Promise<GitResult> => {
        // 写操作前后都读一轮此刻才开始的，不用复用的结果
        const before = await this.status(ref, true)
        if (guard && before.busySessions > 0)
          return { ok: false, failure: { kind: 'busy', action, detail: '', remedies: [] }, status: before }
        try {
          await fn(repo, before)
        } catch (error) {
          const failure =
            error instanceof GitError
              ? error.failure
              : { kind: 'invalid' as const, action, detail: (error as Error).message, remedies: [] }
          this.invalidate(repo)
          this.changed()
          return { ok: false, failure, status: await this.status(ref, true).catch(() => null) }
        }
        this.invalidate(repo)
        this.changed()
        return { ok: true, status: await this.status(ref, true) }
      })
    this.locks.set(key, task)
    try {
      return await task
    } finally {
      if (this.locks.get(key) === task) this.locks.delete(key)
    }
  }

  stage(ref: WorkspaceRef, input: unknown): Promise<GitResult> {
    const list = paths(input)
    return this.mutate(ref, 'stage', async repo => {
      await this.exec(repo, 'stage', list === 'all' ? ['add', '-A'] : ['add', '-A', '--', ...list], 'stage')
    })
  }

  unstage(ref: WorkspaceRef, input: unknown): Promise<GitResult> {
    const list = paths(input)
    return this.mutate(ref, 'unstage', async (repo, status) => {
      const target = list === 'all' ? ['.'] : list
      // 还没有任何提交时没有 HEAD 可以 reset，改为从暂存区移除
      if (status.initial) await this.exec(repo, 'unstage', ['rm', '--cached', '-r', '-q', '--', ...target], 'stage')
      else
        await this.exec(
          repo,
          'unstage',
          list === 'all' ? ['reset', '-q'] : ['reset', '-q', 'HEAD', '--', ...list],
          'stage',
        )
    })
  }

  discard(ref: WorkspaceRef, input: unknown): Promise<GitResult> {
    const all = input === 'all'
    const v = all ? null : (input as { paths?: unknown; untracked?: unknown } | null)
    const tracked = all ? [] : pathList(v?.paths ?? []),
      untracked = all ? [] : pathList(v?.untracked ?? [])
    return this.mutate(ref, 'discard', async (repo, status) => {
      const restore = all ? status.unstaged.filter(f => !f.submodule).map(f => f.path) : tracked
      // 只删除刚读到的未跟踪列表里的文件
      const listed = new Set(status.untracked.map(f => f.path))
      const remove = all ? [...listed] : untracked.filter(p => listed.has(p))
      if (!all && remove.length !== untracked.length) throw new Error('文件状态已变化，请刷新后重试')
      // 「放弃全部」可能有几千个文件：分批，免得命令行超长起不来
      for (const batch of pathBatches(restore)) await this.exec(repo, 'discard', ['checkout', '--', ...batch], 'stage')
      if (!remove.length) return
      if (this.opts.trash) {
        const files: TrashFile[] = []
        for (const path of remove) {
          // 不跟随链接：未跟踪的符号链接放弃的是链接本身，不能把它指向的（已跟踪）文件送进回收站
          const { path: absolute } = await workspaceEntry(repo.root, path)
          if ((await lstat(absolute)).isDirectory()) throw new Error('目标不是普通文件')
          files.push({ absolute, relative: path })
        }
        await this.opts.trash(files)
      } else
        for (const batch of pathBatches(remove))
          await this.exec(repo, 'discard', ['clean', '-f', '-q', '--', ...batch], 'stage')
    })
  }

  commit(ref: WorkspaceRef, input: unknown): Promise<GitResult> {
    const v = (input ?? {}) as { message?: unknown; all?: unknown; push?: unknown }
    const message = value(v.message, 20_000, true)
    return this.mutate(ref, 'commit', async (repo, status) => {
      if (v.all === true) await this.exec(repo, 'commit', ['add', '-A'], 'stage')
      else if (!status.staged.length)
        throw new GitError({ kind: 'nothing', action: 'commit', detail: '', remedies: [] })
      await this.exec(repo, 'commit', ['commit', '-q', '-F', '-'], 'commit', message).catch(error =>
        this.hookFailure(repo, error, ['pre-commit', 'prepare-commit-msg', 'commit-msg']),
      )
      if (v.push === true) {
        this.invalidate(repo)
        await this.pushIn(repo, await this.status(ref, true), false)
      }
    })
  }

  private async pushIn(repo: Repo, status: GitStatus, publish: boolean): Promise<void> {
    if (status.detached)
      throw new GitError({
        kind: 'invalid',
        action: 'push',
        detail: '分离 HEAD 不能推送，请先切换到分支',
        remedies: [],
      })
    const hook = (error: unknown) => this.hookFailure(repo, error, ['pre-push'])
    if (status.upstream && !publish) {
      await this.exec(repo, 'push', ['push'], 'remote').catch(hook)
      return
    }
    if (!status.remotes.length) throw new GitError({ kind: 'noRemote', action: 'push', detail: '', remedies: [] })
    const remote = status.remotes.length === 1 ? status.remotes[0] : status.remotes.includes('origin') ? 'origin' : null
    if (!remote) throw new GitError({ kind: 'noUpstream', action: 'push', detail: '', remedies: [] })
    await this.exec(repo, 'push', ['push', '-u', remote, 'HEAD'], 'remote').catch(hook)
  }

  push(ref: WorkspaceRef, input: unknown): Promise<GitResult> {
    const publish = (input as { publish?: unknown } | null)?.publish === true
    return this.mutate(ref, 'push', (repo, status) => this.pushIn(repo, status, publish))
  }

  pull(ref: WorkspaceRef, mode: unknown): Promise<GitResult> {
    const args: Record<GitPullMode, string[]> = {
      'ff-only': ['pull', '--ff-only'],
      rebase: ['pull', '--rebase'],
      stash: ['pull', '--rebase', '--autostash'],
    }
    if (typeof mode !== 'string' || !(mode in args)) throw new Error('参数不正确')
    return this.mutate(
      ref,
      'pull',
      async repo => {
        await this.exec(repo, 'pull', args[mode as GitPullMode], 'remote')
      },
      true,
    )
  }

  fetch(ref: WorkspaceRef): Promise<GitResult> {
    return this.mutate(ref, 'fetch', async (repo, status) => {
      if (!status.remotes.length) throw new GitError({ kind: 'noRemote', action: 'fetch', detail: '', remedies: [] })
      await this.exec(repo, 'fetch', ['fetch', '--prune'], 'remote')
    })
  }

  switchBranch(ref: WorkspaceRef, input: unknown): Promise<GitResult> {
    const v = (input ?? {}) as { branch?: unknown; remote?: unknown }
    const branch = value(v.branch, 255, true),
      remote = v.remote === true
    return this.mutate(
      ref,
      'switch',
      async repo => {
        const list = await this.branches(ref)
        const found = list.find(b => b.name === branch && b.remote === remote)
        if (!found) throw new Error('分支不存在，请刷新后重试')
        if (!remote) {
          await this.exec(repo, 'switch', ['switch', branch], 'stage')
          return
        }
        const local = branch.slice(branch.indexOf('/') + 1)
        if (list.some(b => !b.remote && b.name === local)) await this.exec(repo, 'switch', ['switch', local], 'stage')
        else await this.exec(repo, 'switch', ['switch', '--track', branch], 'stage')
      },
      true,
    )
  }

  createBranch(ref: WorkspaceRef, input: unknown): Promise<GitResult> {
    const v = (input ?? {}) as { name?: unknown; start?: unknown; switch?: unknown }
    const name = value(v.name, 255, true)
    // 在历史里的某个提交上新建（docs/ui/git-panel.md §9.6）：不切过去时只新建引用，不动工作区，会话运行中也可以
    if (v.start !== undefined && v.start !== null) {
      if (!isHash(v.start)) throw new Error('参数不正确')
      const start = v.start,
        switchTo = v.switch === true
      return this.mutate(
        ref,
        'create',
        async repo => {
          await this.checkBranchName(repo, name)
          await this.exec(
            repo,
            'create',
            switchTo ? ['switch', '-c', name, start] : ['branch', '--end-of-options', name, start],
            'stage',
          )
        },
        switchTo,
      )
    }
    return this.mutate(
      ref,
      'create',
      async repo => {
        await this.checkBranchName(repo, name)
        await this.exec(repo, 'create', ['switch', '-c', name], 'stage')
      },
      true,
    )
  }

  private async checkBranchName(repo: Repo, name: string): Promise<void> {
    if (name.startsWith('-'))
      throw new GitError({ kind: 'invalid', action: 'create', detail: '分支名不能以 - 开头', remedies: [] })
    await this.exec(repo, 'create', ['check-ref-format', '--branch', name], 'read').catch(() => {
      throw new GitError({ kind: 'invalid', action: 'create', detail: '分支名不符合 Git 规则', remedies: [] })
    })
  }

  operation(ref: WorkspaceRef, action: unknown): Promise<GitResult> {
    if (action !== 'abort' && action !== 'continue') throw new Error('参数不正确')
    return this.mutate(
      ref,
      'operation',
      async (repo, status) => {
        if (!status.operation) throw new Error('没有进行中的合并或变基')
        if (action === 'continue' && status.conflicted.length)
          throw new GitError({ kind: 'conflict', action: 'operation', detail: '', remedies: ['abort'] })
        await this.exec(repo, 'operation', [status.operation, `--${action}`], 'commit')
      },
      true,
    )
  }
}
