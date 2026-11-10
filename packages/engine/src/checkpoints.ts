// 对话检查点的影子 Git 仓库（docs/ui/undo-changes.md §2）：工作树指向会话的工作目录，只存树对象，不碰项目自己的 .git
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { killTree, removeTree } from './exec'

/**
 * 默认排除的大文件类型（docs/ui/checkpoint-disk.md）：视频、音频、压缩包、镜像、设计稿、模型权重。
 * 素材体积大、AI 一般不改，存进快照会把磁盘占满
 */
const LARGE_TYPES =
  'mp4 mov mkv avi webm m4v flv wmv mpg mpeg wav flac mp3 aac m4a ogg aiff zip 7z rar tar gz tgz bz2 xz zst iso dmg img vhd vhdx vmdk psd psb blend fbx exr safetensors gguf ckpt pt pth onnx'.split(
    ' ',
  )

/** 单个文件超过这么大就不存进快照（扩展名不在名单里的也拦得住） */
export const LARGE_FILE = 50 * 1024 * 1024

/** 超时结束 git 后最多等它这么久真正退出：还活着的 git 占着索引锁和写到一半的文件 */
const KILL_WAIT = 5_000

/** 默认排除：依赖和构建缓存目录、大文件类型（大小写各写一条）；项目自己的 .gitignore 照常生效 */
export const DEFAULT_EXCLUDES = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.gradle/',
  'target/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  '.pnpm-store/',
  ...LARGE_TYPES.flatMap(ext => [`*.${ext}`, `*.${ext.toUpperCase()}`]),
]

/** 把一个路径写成 info/exclude 里只匹配它自己的一行（转义通配符和行尾空格） */
const excludeLine = (path: string): string =>
  '/' + path.replace(/[\\*?[\]]/g, '\\$&').replace(/ +$/, spaces => spaces.replaceAll(' ', '\\ '))

/** 文件或目录占多少字节（不跟符号链接） */
function treeBytes(path: string): number {
  const st = lstatSync(path)
  if (!st.isDirectory()) return st.size
  return readdirSync(path).reduce((sum, name) => sum + treeBytes(join(path, name)), 0)
}

/** 删掉整个影子仓库：异步删（几万个小文件同步删会卡住主进程几秒）；删不动再用同步的那套（会先去掉只读） */
export const removeRepo = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true }).catch(() => removeTree(dir))

/**
 * 被结束的 git 留在对象库里的半截文件（docs/ui/checkpoint-disk.md）：objects/pack/tmp_*、objects/??/tmp_obj_*，
 * 以及用户的 git 开了 core.fsyncMethod=batch 时的 objects/tmp_objdir-*（整个目录，count-objects 不算它）。
 * 返回删掉的字节数。调用时这个仓库里不能有我们自己的 git 在写
 */
export function sweepLeftovers(gitDir: string): number {
  let freed = 0
  const drop = (dir: string, match: RegExp): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!match.test(name)) continue
      const file = join(dir, name)
      try {
        const size = treeBytes(file)
        removeTree(file)
        freed += size
      } catch {
        // 还被占着（git 没退干净）：下次再清
      }
    }
  }
  const objects = join(gitDir, 'objects')
  drop(join(objects, 'pack'), /^tmp_/)
  drop(objects, /^tmp_objdir-/)
  let dirs: string[]
  try {
    dirs = readdirSync(objects)
  } catch {
    return freed
  }
  for (const dir of dirs) if (/^[0-9a-f]{2}$/.test(dir)) drop(join(objects, dir), /^tmp_obj_/)
  return freed
}

/** 树里的一个文件：内容；不在树里是 null；子模块、符号链接等不能当普通文件写回的是 'special' */
export type TreeBlob = Buffer | null | 'special'

export interface TreeChange {
  /** 相对工作目录、用 / 分隔 */
  path: string
  status: 'added' | 'modified' | 'deleted'
  /** 二进制文件为 0 */
  insertions: number
  deletions: number
}

interface GitRun {
  code: number | null
  stdout: Buffer
  stderr: string
  timedOut: boolean
  missing: boolean
}

/** 快照缺了内容、不能再用时的说法（界面翻译见 branchMessages 的 branch.checkpointExpired） */
export const CHECKPOINT_EXPIRED = '这一轮的代码快照已失效（项目的 git 清理了旧内容，或快照文件被删），代码保持不变'

export class CheckpointError extends Error {
  constructor(
    readonly reason: 'no-git' | 'timeout' | 'failed',
    message: string,
  ) {
    super(message)
  }
}

/** 一条 git 命令；GIT_DIR 等环境变量去掉，免得被外面的设置带到别的仓库 */
function runGit(
  args: string[],
  opts: { cwd?: string; timeout: number; input?: string; running?: Set<ChildProcess> },
): Promise<GitRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const key of Object.keys(env))
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES)$/i.test(key))
      delete env[key]
  return new Promise(done => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    opts.running?.add(child)
    const out: Buffer[] = []
    let stderr = ''
    let settled = false
    let timedOut = false
    let grace: NodeJS.Timeout | undefined
    const finish = (run: GitRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      opts.running?.delete(child)
      done(run)
    }
    const late = (): GitRun => ({ code: null, stdout: Buffer.alloc(0), stderr, timedOut: true, missing: false })
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      // 等它真正退出再往下走（Windows 上 taskkill 是异步的）：不然清不掉它的锁和半截文件，下一条命令还会撞上索引锁
      grace = setTimeout(() => finish(late()), KILL_WAIT)
    }, opts.timeout)
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString('utf8')
    })
    child.on('error', error =>
      finish({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: error.message,
        timedOut: false,
        missing: (error as NodeJS.ErrnoException).code === 'ENOENT',
      }),
    )
    child.on('close', code =>
      finish(timedOut ? late() : { code, stdout: Buffer.concat(out), stderr, timedOut: false, missing: false }),
    )
    if (opts.input !== undefined) {
      child.stdin!.on('error', () => {})
      child.stdin!.end(opts.input, 'utf8')
    }
  })
}

/** 文件相对工作目录的路径（/ 分隔）；在工作目录外返回 null */
export function workPath(workTree: string, file: string): string | null {
  const rel = relative(workTree, isAbsolute(file) ? file : resolve(workTree, file))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.replaceAll('\\', '/')
}

export class ShadowRepo {
  /** 所有命令排队执行：共用一个索引文件 */
  private chain: Promise<unknown> = Promise.resolve()
  private ready = false
  /** 正在跑的 git（退出时结束它们） */
  private readonly running = new Set<ChildProcess>()
  private stopped = false
  /** 太大、不存进快照的文件（相对工作目录）；记在 info/large，比较两棵树时也不算它们 */
  private large = new Set<string>()

  constructor(
    readonly gitDir: string,
    readonly workTree: string,
    private readonly timeout = 30_000,
  ) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const guarded = (): Promise<T> =>
      this.stopped ? Promise.reject(new CheckpointError('failed', '应用正在退出')) : task()
    const next = this.chain.then(guarded, guarded)
    this.chain = next.catch(() => undefined)
    return next
  }

  private git(args: string[], timeout = this.timeout, input?: string): Promise<GitRun> {
    // 停了以后一个操作里剩下的命令（add 之后的 write-tree 等）也不再起
    if (this.stopped)
      return Promise.resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: '应用正在退出',
        timedOut: false,
        missing: false,
      })
    return runGit(
      [
        '-c',
        'core.quotepath=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.safecrlf=false',
        '-c',
        'core.longpaths=true',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'safe.directory=*',
        `--git-dir=${this.gitDir}`,
        `--work-tree=${this.workTree}`,
        ...args,
      ],
      { cwd: this.workTree, timeout, input, running: this.running },
    )
  }

  private async must(args: string[], timeout = this.timeout, input?: string): Promise<Buffer> {
    const run = await this.git(args, timeout, input)
    if (run.missing) throw new CheckpointError('no-git', '没有找到 git')
    if (run.timedOut) throw new CheckpointError('timeout', `git ${args[0]} 超时`)
    if (run.code !== 0) throw new CheckpointError('failed', run.stderr.trim() || `git ${args[0]} 失败`)
    return run.stdout
  }

  /** git 认它是仓库要有 HEAD、objects/、refs/ */
  private complete(): boolean {
    return ['HEAD', 'objects', 'refs'].every(name => existsSync(join(this.gitDir, name)))
  }

  /**
   * 第一次用时建仓库：借项目的对象库、用项目的索引起步（没改过的文件不用重新算）。
   * 影子仓库从不建分支，refs/ 里只有空目录，复制、同步、清理空目录的工具会把它丢掉，git 就不认这个仓库了
   * （「not a git repository」），快照对象其实还在：每次用前检查，缺了就补上
   */
  private async init(): Promise<void> {
    if (this.ready && this.complete()) return
    if (!existsSync(this.workTree) || !statSync(this.workTree).isDirectory())
      throw new CheckpointError('failed', '工作目录不存在')
    if (!existsSync(join(this.gitDir, 'HEAD'))) {
      mkdirSync(this.gitDir, { recursive: true })
      const run = await runGit(['init', '--bare', '--quiet', this.gitDir], { timeout: this.timeout })
      if (run.missing) throw new CheckpointError('no-git', '没有找到 git')
      if (run.code !== 0) throw new CheckpointError('failed', run.stderr.trim() || 'git init 失败')
      writeFileSync(
        join(this.gitDir, 'config'),
        '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = false\n[gc]\n\tauto = 0\n',
      )
      await this.borrowObjects()
    }
    mkdirSync(join(this.gitDir, 'refs', 'heads'), { recursive: true })
    mkdirSync(join(this.gitDir, 'refs', 'tags'), { recursive: true })
    mkdirSync(join(this.gitDir, 'objects', 'info'), { recursive: true })
    mkdirSync(join(this.gitDir, 'info'), { recursive: true })
    // 存原样字节：项目 .gitattributes 的换行转换（text=auto、eol）、过滤器（LFS）、编码转换都不要，
    // 否则写回去的是转换过的内容。info/attributes 优先于工作树里的 .gitattributes
    writeFileSync(join(this.gitDir, 'info', 'attributes'), '* -text -filter -ident -working-tree-encoding\n')
    try {
      this.large = new Set(
        readFileSync(join(this.gitDir, 'info', 'large'), 'utf8')
          .split('\n')
          .filter(Boolean),
      )
    } catch {
      this.large = new Set()
    }
    // 每次都重写：旧版本建的仓库也用上新的默认排除（已经在快照里的文件不受影响）
    this.writeExclude()
    this.ready = true
  }

  private writeExclude(): void {
    // 影子仓库自己在工作目录里时（数据目录放在项目里）也排除，不然会把自己拍进去
    const self = workPath(this.workTree, this.gitDir)
    writeFileSync(
      join(this.gitDir, 'info', 'exclude'),
      [...DEFAULT_EXCLUDES, ...(self ? [`/${self}/`] : []), ...[...this.large].map(excludeLine)].join('\n') + '\n',
    )
  }

  /**
   * 工作目录在 Git 仓库里：借它的对象库，内容一样的文件不再存一份。
   * 不复制项目的索引当起点：那里记的是按项目设置转换过的内容（autocrlf、LFS 指针），文件没改时不会重新算
   */
  private async borrowObjects(): Promise<void> {
    const run = await runGit(['-c', 'safe.directory=*', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: this.workTree,
      timeout: 10_000,
    })
    if (run.code !== 0) return
    const common = run.stdout.toString('utf8').split(/\r?\n/)[0]
    if (!common) return
    const objects = join(common, 'objects')
    if (!existsSync(objects)) return
    mkdirSync(join(this.gitDir, 'objects', 'info'), { recursive: true })
    writeFileSync(join(this.gitDir, 'objects', 'info', 'alternates'), objects.replaceAll('\\', '/') + '\n')
  }

  /**
   * 去掉索引锁和对象库里的半截文件：命令都在这里排队执行，开始前还在的是之前被结束的 git 留下的。
   * 半截文件不清会越积越多（一次几百 MB 到几 GB，docs/ui/checkpoint-disk.md）
   */
  private dropLock(): void {
    try {
      rmSync(join(this.gitDir, 'index.lock'), { force: true })
    } catch {
      // 删不掉时下面的 git 会报错
    }
    sweepLeftovers(this.gitDir)
  }

  /** 清掉被结束的 git 留下的半截文件（定时清理用）；返回删掉的字节数 */
  sweep(): Promise<number> {
    return this.serial(async () => (existsSync(this.gitDir) ? sweepLeftovers(this.gitDir) : 0))
  }

  /**
   * 拍快照前：有变化的文件里超过 LARGE_FILE 的不存。记进 info/large、写进排除、从索引里拿掉
   * （以前存过的版本还在旧快照里，之后的快照不再有它）。列不出来不挡拍快照
   */
  private async skipLarge(timeout: number): Promise<void> {
    const run = await this.git(['ls-files', '-z', '--others', '--modified', '--exclude-standard'], timeout)
    if (run.timedOut) {
      this.dropLock()
      throw new CheckpointError('timeout', '拍快照超时')
    }
    if (run.code !== 0) return
    const paths = [...new Set(run.stdout.toString('utf8').split('\0'))].filter(
      path => path && !path.endsWith('/') && !/[\r\n]/.test(path) && !this.large.has(path),
    )
    const found: string[] = []
    for (let i = 0; i < paths.length; i += 64)
      await Promise.all(
        paths.slice(i, i + 64).map(path =>
          stat(join(this.workTree, path)).then(
            st => {
              if (st.isFile() && st.size > LARGE_FILE) found.push(path)
            },
            () => undefined,
          ),
        ),
      )
    if (found.length === 0) return
    for (const path of found) this.large.add(path)
    writeFileSync(join(this.gitDir, 'info', 'large'), [...this.large].join('\n') + '\n')
    this.writeExclude()
    await this.git(['update-index', '--force-remove', '-z', '--stdin'], timeout, found.join('\0') + '\0')
  }

  /** 拍一次快照：返回树对象 id。读不了的文件（被占用等）跳过 */
  capture(timeout = this.timeout): Promise<string> {
    return this.serial(async () => {
      await this.init()
      this.dropLock()
      await this.skipLarge(timeout)
      let run = await this.git(['add', '--all', '--ignore-errors', '--', '.'], timeout)
      if (run.missing) throw new CheckpointError('no-git', '没有找到 git')
      // 超时结束的 git 会留下索引锁，下次就拍不了了
      if (run.timedOut) {
        this.dropLock()
        throw new CheckpointError('timeout', '拍快照超时')
      }
      // 索引坏了：删掉从头来
      if (run.code !== 0 && /index file|bad signature|corrupt/i.test(run.stderr)) {
        rmSync(join(this.gitDir, 'index'), { force: true })
        run = await this.git(['add', '--all', '--ignore-errors', '--', '.'], timeout)
        if (run.timedOut) {
          this.dropLock()
          throw new CheckpointError('timeout', '拍快照超时')
        }
      }
      // 退出码 1 是个别文件读不了（被占用等，--ignore-errors 跳过了）；其他非 0 是整个命令失败，
      // 这时索引还是上一次的，接着 write-tree 会把旧状态当成现在
      if (run.code !== 0 && run.code !== 1)
        throw new CheckpointError('failed', run.stderr.trim() || `git add 失败（${run.code}）`)
      return (await this.must(['write-tree'], timeout)).toString('utf8').trim()
    })
  }

  /** 两棵树之间改了哪些文件 */
  diff(from: string, to: string): Promise<TreeChange[]> {
    return this.serial(async () => {
      await this.init()
      const [status, numstat] = await Promise.all([
        this.must(['diff-tree', '-r', '--no-renames', '--name-status', '-z', from, to]),
        this.must(['diff-tree', '-r', '--no-renames', '--numstat', '-z', from, to]),
      ])
      const counts = new Map<string, [number, number]>()
      for (const entry of numstat.toString('utf8').split('\0')) {
        const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(entry)
        if (m) counts.set(m[3], [m[1] === '-' ? 0 : Number(m[1]), m[2] === '-' ? 0 : Number(m[2])])
      }
      const parts = status.toString('utf8').split('\0')
      const out: TreeChange[] = []
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const code = parts[i]
        const path = parts[i + 1]
        if (!code || !path) continue
        // 太大不再存的文件：从索引里拿掉后新的树里就没有它了，不是真的被删
        if (this.large.has(path)) continue
        const [insertions, deletions] = counts.get(path) ?? [0, 0]
        out.push({
          path,
          status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified',
          insertions,
          deletions,
        })
      }
      return out
    })
  }

  /** 树里某个文件的内容 */
  blob(tree: string, path: string): Promise<TreeBlob> {
    return this.serial(async () => {
      await this.init()
      const entry = (await this.must(['ls-tree', '-z', tree, '--', path])).toString('utf8').split('\0')[0]
      if (!entry) return null
      const [mode] = entry.split(' ')
      if (mode !== '100644' && mode !== '100755') return 'special'
      return this.must(['cat-file', 'blob', `${tree}:${path}`])
    })
  }

  /**
   * 快照缺了内容：借来的项目对象被项目的 git 清理掉了（改写历史后 gc），或者影子仓库被删过。
   * 树本身不在也算缺；只查有没有，不读文件内容
   */
  incomplete(tree: string, timeout = this.timeout): Promise<boolean> {
    return this.serial(async () => {
      await this.init()
      const run = await this.git(['rev-list', '--objects', '--missing=print', tree, '--'], timeout)
      if (run.missing) throw new CheckpointError('no-git', '没有找到 git')
      if (run.timedOut) throw new CheckpointError('timeout', '检查快照超时')
      if (run.code !== 0) {
        // 只认「对象不在」；别的错误（比如很旧的 git 不认 --missing）不能当成缺内容，否则好好的快照会被记成失效
        if (/bad object|not a valid object|not a tree object|unable to read|could not read/i.test(run.stderr))
          return true
        throw new CheckpointError('failed', run.stderr.trim() || 'rev-list 失败')
      }
      return /^\?/m.test(run.stdout.toString('utf8'))
    })
  }

  /** 这些路径里被 .gitignore / 默认排除的（不在快照里） */
  ignored(paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return Promise.resolve(new Set())
    return this.serial(async () => {
      await this.init()
      const run = await this.git(['check-ignore', '--no-index', '-z', '--stdin'], this.timeout, paths.join('\0') + '\0')
      // 退出码 1：都没被排除
      if (run.code !== 0 && run.code !== 1)
        throw new CheckpointError('failed', run.stderr.trim() || 'check-ignore 失败')
      return new Set(run.stdout.toString('utf8').split('\0').filter(Boolean))
    })
  }

  /** 对象库大小（字节），连同没清掉的半截文件（size-garbage）：以前不算它，上限拦不住残留 */
  size(): Promise<number> {
    return this.serial(async () => {
      await this.init()
      const text = (await this.must(['count-objects', '-v'])).toString('utf8')
      const kib = (key: string): number => Number(new RegExp(`^${key}: (\\d+)`, 'm').exec(text)?.[1] ?? 0)
      return (kib('size') + kib('size-pack') + kib('size-garbage')) * 1024
    })
  }

  /** 应用退出：结束正在跑的 git，排着的不再跑（留下的索引锁下次开始前会清掉） */
  async stop(): Promise<void> {
    this.stopped = true
    for (const child of this.running) killTree(child)
    await this.idle()
  }

  /** 排着的命令都跑完（删会话前等它们，免得 Windows 上目录被占用删不掉） */
  idle(): Promise<void> {
    return this.chain.then(() => undefined)
  }

  /** 影子仓库建好了（拍过快照） */
  exists(): boolean {
    return existsSync(join(this.gitDir, 'HEAD'))
  }

  /** 删掉整个影子仓库 */
  async destroy(): Promise<void> {
    await this.serial(async () => {
      await removeRepo(this.gitDir)
      this.ready = false
    })
  }
}
