// 对话检查点（docs/ui/undo-changes.md）：每轮开始前、结束时给工作目录拍快照；
// 改动卡片按文件撤回 / 恢复，回退时用它还原代码（可以只还原其中几个文件）
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { lstat, readdir, statfs } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  CheckpointDisabled,
  CheckpointList,
  RevertFilesResult,
  RevertSkip,
  RewindCodePreview,
} from '@pixelsky/protocol'
import {
  CHECKPOINT_EXPIRED,
  CheckpointError,
  removeRepo,
  ShadowRepo,
  sweepLeftovers,
  workPath,
  type TreeBlob,
} from '../checkpoints'
import { diffText } from '../diff'
import { describeError, logger } from '../log'
import { UNDO_LIMIT } from './branch'
import type { HostContext } from './context'

const log = logger('engine.checkpoints')

/**
 * 发消息前最多等快照这么久。没拍完这一轮就不等了（这一轮没有快照），git 在后台接着跑完，
 * 索引建好了下一轮就快（第一次要把工作目录算一遍）。以前等 5 秒：慢机器上每轮开头干等，体感是「发了消息半天不动」
 */
const BEFORE_WAIT = 2_000
/** 一条 git 命令的超时（拍快照、预览和还原前） */
const LATER_TIMEOUT = 60_000
/** 连续这么多次拍快照超时，这次运行里停用这个会话的快照（重启后再试） */
const SLOW_LIMIT = 3
/** 影子仓库超过这个大小就删掉并停用 */
export const CHECKPOINT_LIMIT = 200 * 1024 * 1024
/** 所有会话的影子仓库合计超过这个大小：从最久没用的会话开始删（docs/ui/checkpoint-disk.md） */
export const CHECKPOINT_TOTAL_LIMIT = 5 * 1024 ** 3
/** 数据目录所在磁盘剩余少于这么多就不拍新快照 */
export const DISK_MIN = 5 * 1024 ** 3
/** 剩余空间多久查一次 */
const DISK_FRESH = 30_000
/** 定时清理：启动后多久跑第一次、之后每隔多久 */
const MAINTAIN_FIRST = 60_000
const MAINTAIN_EVERY = 3_600_000
/** 按修改时间判断手改时留的余量：有的文件系统时间精度只有 2 秒，这一轮最后写的文件不能算成之后改的 */
const MTIME_SLACK = 2_000
/** 冲突确认框里的 diff 最多这么长 */
const CONFLICT_DIFF_LIMIT = 20_000

interface TurnData {
  /** 这一轮开始前 / 结束时的树 */
  before?: string
  after?: string
  /** 这一轮改了哪些文件（before → after） */
  files?: string[]
  /** 开始前快照拍好的时间；没有开始前快照的（只记了结束）是结束的时间 */
  at: number
  /** 这一轮结束的时间（快照停用、没拍到时也记） */
  endedAt?: number
  /** 快照缺了内容（项目的 git 清理了借来的对象、影子仓库被删过）：不能再用 */
  lost?: true
}

interface FileData {
  version: 1
  /** 影子仓库对应的工作目录：会话换了目录就从头来 */
  cwd: string
  disabled?: CheckpointDisabled
  message?: string
  turns: Record<string, TurnData>
}

interface State {
  repo: ShadowRepo
  data: FileData
}

/** 撤回前的文件内容；null 表示当时文件不存在 */
type Saved = { path: string; data: Buffer | null }[]

interface Revert {
  itemId: string
  paths: string[]
  files: Saved
}

const SKIP_TEXT: Record<RevertSkip, string> = {
  outside: '不在工作目录里',
  excluded: '被 .gitignore 或默认规则排除，没有快照',
  'no-checkpoint': '这一轮没有代码快照',
  special: '子模块或链接，不能撤回',
  failed: '读写失败',
}

export class HostCheckpoints {
  private readonly states = new Map<string, State>()
  /** 改动卡片撤回的文件，按会话；只在内存里 */
  private readonly reverts = new Map<string, Map<string, Revert>>()
  /** 没装 git：这次运行里不再试（装上后重启生效） */
  private noGit = false
  /**
   * 每个工作目录连续超时的次数；到 SLOW_LIMIT 这个项目的会话都停用（只在内存里）。
   * 按目录不按会话：频道每一步都是新会话，按会话算永远到不了上限（docs/ui/checkpoint-disk.md）
   */
  private readonly timeouts = new Map<string, number>()
  /** 开始打字时预先拍第一次的会话（每次运行只拍一次） */
  private readonly prepared = new Set<string>()
  /** 最近一次查到的磁盘剩余空间够不够 */
  private disk = { at: 0, low: false }
  private timer: NodeJS.Timeout | null = null
  /** 清理一次只跑一个 */
  private maintainChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly ctx: HostContext) {
    if (!ctx.opts.checkpoints) return
    const run = (): void => void this.maintain().catch(err => log.warn('清理检查点失败', { error: describeError(err) }))
    this.timer = setTimeout(() => {
      run()
      this.timer = setInterval(run, MAINTAIN_EVERY)
      this.timer.unref?.()
    }, MAINTAIN_FIRST)
    this.timer.unref?.()
  }

  private slowKey(id: string): string {
    const cwd = this.ctx.records.get(id)?.cwd
    if (!cwd) return id
    const path = resolve(cwd)
    return process.platform === 'win32' ? path.toLowerCase() : path
  }

  private slow(id: string): boolean {
    return (this.timeouts.get(this.slowKey(id)) ?? 0) >= SLOW_LIMIT
  }

  /** 数据目录所在磁盘快满了：不拍新快照。半分钟内不重复查；查不了当成够用 */
  private async diskLow(): Promise<boolean> {
    const now = Date.now()
    if (now - this.disk.at < DISK_FRESH) return this.disk.low
    let free: number | null
    try {
      const dir = this.ctx.store.dir
      free = this.ctx.opts.diskFree ? await this.ctx.opts.diskFree(dir) : await freeBytes(dir)
    } catch {
      free = null
    }
    const low = free !== null && free < DISK_MIN
    if (low && !this.disk.low) log.warn('磁盘空间不足，不拍新快照', { free })
    this.disk = { at: now, low }
    return low
  }

  private state(id: string): State | null {
    const record = this.ctx.records.get(id)
    if (!record?.cwd) return null
    const known = this.states.get(id)
    if (known && known.data.cwd === record.cwd) return known
    let data = parseData(this.ctx.store.loadCheckpoints(id))
    const repo = new ShadowRepo(this.ctx.store.checkpointDir(id), record.cwd)
    if (data && data.cwd !== record.cwd) {
      // 会话换了工作目录：旧快照对不上
      void repo.destroy()
      data = null
    }
    const state = { repo, data: data ?? { version: 1 as const, cwd: record.cwd, turns: {} } }
    this.states.set(id, state)
    return state
  }

  private save(id: string, state: State): void {
    try {
      this.ctx.store.saveCheckpoints(id, state.data)
    } catch (err) {
      log.warn('保存检查点记录失败', { session: id, error: describeError(err) })
    }
  }

  /** 拍快照失败：连续超时几次就停用（这次运行），没装 git 这次运行不再试，其他错误只跳过这一次 */
  private failed(id: string, err: unknown): void {
    const reason = err instanceof CheckpointError ? err.reason : 'failed'
    log.warn('拍快照失败', { session: id, reason, error: describeError(err) })
    if (reason === 'no-git') this.noGit = true
    else if (reason === 'timeout') {
      const key = this.slowKey(id)
      this.timeouts.set(key, (this.timeouts.get(key) ?? 0) + 1)
    }
  }

  /** 拍快照，成功时清掉连续超时的计数；失败、磁盘快满返回 null */
  private async capture(id: string, state: State): Promise<string | null> {
    if (await this.diskLow()) return null
    try {
      const tree = await state.repo.capture(LATER_TIMEOUT)
      this.timeouts.delete(this.slowKey(id))
      return tree
    } catch (err) {
      this.failed(id, err)
      if (this.noGit) return null
      // git 自己出错退出（磁盘满）也会留下半截文件：马上清，不等下一次拍
      void state.repo.sweep().catch(() => undefined)
      // 超时也查大小：以前只在拍成功后查，一直超时就一直不查
      if (err instanceof CheckpointError && err.reason === 'timeout') void this.checkSize(id, state)
      return null
    }
  }

  /** 超过大小上限：删掉影子仓库并停用 */
  private async checkSize(id: string, state: State): Promise<void> {
    try {
      const size = await state.repo.size()
      if (size <= CHECKPOINT_LIMIT) return
      log.info('检查点超过大小上限，停用', { session: id, size })
      await state.repo.destroy()
      state.data = { version: 1, cwd: state.data.cwd, disabled: 'too-large', turns: {} }
      this.save(id, state)
    } catch (err) {
      log.warn('读检查点大小失败', { session: id, error: describeError(err) })
    }
  }

  /** 停用原因：持久的（超过大小）或这次运行里的（没装 git、连续超时） */
  private disabledReason(state: State | null, id: string): CheckpointDisabled | null {
    if (this.noGit) return 'no-git'
    if (this.slow(id)) return 'slow'
    if (state?.data.disabled) return state.data.disabled
    return this.disk.low ? 'disk-low' : null
  }

  /** 能用已有的快照（撤回、回退）：没装 git、超过大小（影子仓库已删）就不能 */
  private usable(id: string): State | null {
    if (!this.ctx.opts.checkpoints || this.noGit) return null
    const state = this.state(id)
    return state && !state.data.disabled ? state : null
  }

  /** 能拍新的快照：还要没在退出、没有连续超时 */
  private capturable(id: string): State | null {
    if (this.ctx.closing || this.slow(id)) return null
    return this.usable(id)
  }

  /**
   * 清理（docs/ui/checkpoint-disk.md）：清掉被结束的 git 留下的半截文件；所有会话的影子仓库合计超过上限时，
   * 从最久没用的会话开始删，正在运行的不动。limit 传 0：删掉所有空闲会话的（设置 › 存储的「清理检查点」）。
   * 返回释放的字节数
   */
  maintain(limit = CHECKPOINT_TOTAL_LIMIT): Promise<number> {
    const next = this.maintainChain.then(() => this.runMaintain(limit))
    this.maintainChain = next.catch(() => undefined)
    return next
  }

  private async runMaintain(limit: number): Promise<number> {
    let freed = 0
    const rows: { id: string; bytes: number; used: number }[] = []
    for (const id of this.ctx.store.checkpointIds()) {
      if (this.ctx.closing) return freed
      const dir = this.ctx.store.checkpointDir(id)
      const known = this.states.get(id)
      // 这次运行里用过的会话排进它自己的命令队列，不和正在跑的 git 抢；没用过的没有 git 在跑，直接清
      freed += known ? await known.repo.sweep().catch(() => 0) : sweepLeftovers(dir)
      rows.push({ id, bytes: await dirBytes(dir), used: this.ctx.records.get(id)?.updatedAt ?? 0 })
    }
    let total = rows.reduce((sum, row) => sum + row.bytes, 0)
    for (const row of rows.sort((a, b) => a.used - b.used)) {
      if (total <= limit || this.ctx.closing) break
      // 正在运行、正在撤回 / 回退（changingSessions）的不动：它们正用着这个仓库
      const rt = this.ctx.runtimes.get(row.id)
      if (this.ctx.changingSessions.has(row.id)) continue
      if (rt && (rt.snapshot.state !== 'idle' || rt.pumping || rt.stopping || rt.activeId)) continue
      if (!(await this.drop(row.id))) continue
      total -= row.bytes
      freed += row.bytes
    }
    if (freed > 0) log.info('清理检查点', { freed, limit, sessions: rows.length })
    return freed
  }

  /**
   * 删掉一个会话的影子仓库、清空它的快照记录（之后再用这个会话从头拍）；删不掉返回 false。
   * 撤回记录（reverts）留着：「恢复」用的是内存里存的内容，不靠影子仓库
   */
  private async drop(id: string): Promise<boolean> {
    try {
      // 有会话记录的排进它自己的命令队列删：删的期间发了消息，新的快照排在后面、从头建库，不会建在删到一半的目录上。
      // 没有记录的（删了一半的会话留下的目录）没人会用，直接删
      const state = this.state(id)
      if (!state) {
        await removeRepo(this.ctx.store.checkpointDir(id))
        return true
      }
      // 先清记录再等删除：等的期间新拍的那一轮记在清空之后，不会被盖掉
      state.data = {
        version: 1,
        cwd: state.data.cwd,
        ...(state.data.disabled ? { disabled: state.data.disabled } : {}),
        turns: {},
      }
      this.save(id, state)
      await state.repo.destroy()
      return true
    } catch (err) {
      log.warn('删除检查点失败', { session: id, error: describeError(err) })
      return false
    }
  }

  /**
   * 开始在输入框里打字时调用：这个会话还没拍过快照就在后台先拍一次，发消息时就不用从头算整个工作目录。
   * 只建影子仓库和索引，结果不记
   */
  prepare(id: string): void {
    if (this.prepared.has(id)) return
    const state = this.capturable(id)
    if (!state || state.repo.exists()) return
    this.prepared.add(id)
    void this.capture(id, state)
  }

  /** 发消息前拍一次（turn.ts pump）：最多等 BEFORE_WAIT，失败或没拍完都不挡发消息 */
  async beforeTurn(id: string, itemId: string): Promise<void> {
    const state = this.capturable(id)
    if (!state) return
    const started = Date.now()
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<'late'>(resolve => {
      timer = setTimeout(() => resolve('late'), BEFORE_WAIT)
    })
    const tree = await Promise.race([this.capture(id, state), late])
    clearTimeout(timer)
    if (tree === 'late') {
      log.info('快照没拍完，这一轮先不等', { session: id, ms: Date.now() - started })
      return
    }
    if (!tree || this.states.get(id) !== state) return
    state.data.turns[itemId] = { before: tree, at: Date.now() }
    this.save(id, state)
    log.debug('拍快照', { session: id, ms: Date.now() - started })
    void this.checkSize(id, state)
  }

  /**
   * 一轮结束时（events.ts turn_completed）：记下结束时间，再拍一次、记下这一轮改了哪些文件；不等它。
   * 开始前没拍到（没拍完、出错）也拍、停用了拍不了也记时间：判断「之后手改过」要用（lastEnd）
   */
  afterTurn(id: string, itemId: string): void {
    const state = this.usable(id)
    if (!state) return
    const now = Date.now()
    const entry: TurnData = { ...(state.data.turns[itemId] ?? { at: now }), endedAt: now }
    state.data.turns[itemId] = entry
    this.save(id, state)
    if (!this.capturable(id)) return
    void (async () => {
      const after = await this.capture(id, state)
      if (!after) return
      try {
        const files =
          entry.before && !entry.lost ? (await state.repo.diff(entry.before, after)).map(c => c.path) : undefined
        // 期间会话换了目录、被停用、这条消息重新发了（开始前的快照换了）：不写
        const current = state.data.turns[itemId]
        if (this.states.get(id) !== state || state.data.disabled || !current || current.before !== entry.before) return
        state.data.turns[itemId] = { ...current, after, ...(files ? { files } : {}) }
        this.save(id, state)
        void this.checkSize(id, state)
      } catch (err) {
        this.failed(id, err)
      }
    })()
  }

  /** 这条消息有开始前的快照 */
  has(id: string, itemId: string): boolean {
    const turn = this.usable(id)?.data.turns[itemId]
    return !!turn?.before && !turn.lost
  }

  /** 这条消息原来有快照、但已经失效 */
  expired(id: string, itemId: string): boolean {
    return !!this.usable(id)?.data.turns[itemId]?.lost
  }

  /** 用快照前查一遍内容还全不全；缺了就记下失效（以后不再列出、不再用）。查不了（git 出错）时当成完整，交给后面的命令报错 */
  private async intact(id: string, state: State, itemId: string): Promise<boolean> {
    const turn = state.data.turns[itemId]
    if (!turn?.before || turn.lost) return false
    let incomplete = false
    try {
      incomplete = await state.repo.incomplete(turn.before, LATER_TIMEOUT)
    } catch (err) {
      log.warn('检查快照失败', { session: id, error: describeError(err) })
    }
    if (!incomplete) return true
    log.info('快照缺了内容，记为失效', { session: id, item: itemId })
    if (this.states.get(id) === state && state.data.turns[itemId] === turn) {
      state.data.turns[itemId] = { ...turn, lost: true }
      this.save(id, state)
    }
    return false
  }

  list(id: string): CheckpointList {
    const state = this.usable(id)
    const disabled = this.ctx.opts.checkpoints ? this.disabledReason(this.state(id), id) : null
    const items = this.ctx.m.sessions.runtime(id).snapshot.items
    const present = new Set(items.map(item => item.id))
    const turns: CheckpointList['turns'] = []
    // 连续超时停用只是不再拍新的，已有的照样列出、能用
    if (state)
      for (const item of items) {
        const turn = item.kind === 'user' ? state.data.turns[item.id] : undefined
        if (turn?.before && !turn.lost) turns.push({ itemId: item.id, files: turn.files ?? null, at: turn.at })
      }
    const reverted = [...(this.reverts.get(id)?.entries() ?? [])]
      .filter(([, r]) => present.has(r.itemId))
      .map(([revertId, r]) => ({ revertId, itemId: r.itemId, paths: r.paths }))
    return {
      disabled,
      ...(state?.data.message ? { message: state.data.message } : {}),
      turns,
      reverted,
    }
  }

  /**
   * 对话里还在的各轮（按顺序）和它们的快照；回退移除的轮次不算。
   * 失效的轮次也留着：失效的是开始前的快照，结束时的可能还好好的，跳过它会把它改的文件当成手改
   */
  private presentTurns(id: string, state: State): { itemId: string; turn: TurnData }[] {
    return this.ctx.m.sessions
      .runtime(id)
      .snapshot.items.flatMap(item =>
        item.kind === 'user' && state.data.turns[item.id]
          ? [{ itemId: item.id, turn: state.data.turns[item.id]! }]
          : [],
      )
  }

  /**
   * 判断「最后一轮之后手改过」用什么比：对话里还在的轮次中最近结束的那一轮。
   * 按结束时间挑、不按消息顺序：中途插入的引导、断线重连发的「继续」没有自己的记录（结束记在原消息上），
   * 「关掉」的原消息可能跑过一半、结束照样记了。
   * - 它有结束时的快照：比内容；没拍到（快照停用、出错）：比修改时间；
   * - 之后又开始过一轮、没等到结束（应用中途关了），或者都没记结束时间（旧记录）：
   *   退回和最近一次拍到的结束快照比，之后几轮改的也会算进去
   */
  private lastEnd(id: string, state: State): { tree?: string; endedAt?: number } | null {
    const turns = this.presentTurns(id, state)
    let latest: TurnData | undefined
    for (const { turn } of turns) if (turn.endedAt && (!latest || turn.endedAt > latest.endedAt!)) latest = turn
    const end = latest?.endedAt
    const unfinished = !!end && turns.some(({ turn }) => turn.before && !turn.endedAt && turn.at > end)
    if (latest && !unfinished) return { tree: latest.after, endedAt: end }
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.turn.after) return { tree: turns[i]!.turn.after }
    return null
  }

  /** 这些改动里在 endedAt 之后被改过的文件（修改时间晚于它；删掉的不算：还原只是放回来，不丢内容） */
  private changedSince(cwd: string, paths: string[], endedAt: number): string[] {
    return paths.filter(path => {
      try {
        return statSync(join(cwd, path)).mtimeMs > endedAt + MTIME_SLACK
      } catch {
        return false
      }
    })
  }

  /**
   * 这一轮结束时的样子：结束时没拍到（应用中途退出、快照停用）就用之后最近一轮开始前的。
   * 没有开始前快照的轮次跳过：用更后面的，它们改的文件会多报成冲突（宁可多问一次）
   */
  private endOf(id: string, state: State, itemId: string): { tree: string; at?: number } | null {
    const turns = this.presentTurns(id, state)
    const i = turns.findIndex(t => t.itemId === itemId)
    if (i < 0) return null
    const turn = turns[i]!.turn
    // at：拍这份快照的时间（结束快照缺了内容时退回比修改时间用）
    if (turn.after) return { tree: turn.after, at: turn.endedAt }
    const next = turns.slice(i + 1).find(t => t.turn.before)
    return next ? { tree: next.turn.before!, at: next.turn.at } : null
  }

  /** 回退到这条消息之前要还原哪些文件（branch.ts 有快照时用它） */
  async preview(id: string, itemId: string): Promise<RewindCodePreview> {
    const state = this.usable(id)
    const before = state?.data.turns[itemId]?.before
    if (!state || !before) return { ok: false, reason: 'no-checkpoint' }
    try {
      if (!(await this.intact(id, state, itemId))) return { ok: false, reason: 'expired', message: CHECKPOINT_EXPIRED }
      const current = await state.repo.capture(LATER_TIMEOUT)
      const changes = await state.repo.diff(before, current)
      const last = this.lastEnd(id, state)
      const paths = changes.map(c => c.path)
      const names = new Set(paths)
      const byTime = (): string[] => (last?.endedAt ? this.changedSince(state.data.cwd, paths, last.endedAt) : [])
      // 结束时的快照也可能缺了内容：退回比修改时间，都不行就不标，不挡回退
      const edited = last?.tree
        ? await state.repo
            .diff(last.tree, current)
            .then(list => list.map(c => c.path).filter(p => names.has(p)), byTime)
        : byTime()
      let size = 0
      for (const c of changes) size += fileSize(join(state.data.cwd, c.path))
      return {
        ok: true,
        files: changes.map(c => c.path),
        insertions: changes.reduce((n, c) => n + c.insertions, 0),
        deletions: changes.reduce((n, c) => n + c.deletions, 0),
        undoable: size <= UNDO_LIMIT,
        edited,
        checkpoint: true,
      }
    } catch (err) {
      return { ok: false, reason: 'failed', message: describeError(err) }
    }
  }

  /**
   * 把文件还原到这条消息之前（branch.ts 回退）；paths 只还原这些（相对工作目录）。
   * 返回还原前的内容（撤销用），总共超过 UNDO_LIMIT 时为 null；快照失效时整个返回 null（没动文件，可以改用引擎自己的检查点）
   */
  async restore(id: string, itemId: string, paths?: string[]): Promise<{ saved: Saved | null; count: number } | null> {
    const state = this.usable(id)
    const before = state?.data.turns[itemId]?.before
    if (!state || !before) throw new Error('这条消息没有代码快照，代码保持不变')
    if (!(await this.intact(id, state, itemId))) return null
    const current = await state.repo.capture(LATER_TIMEOUT)
    const only = paths ? new Set(paths) : null
    const changes = (await state.repo.diff(before, current)).filter(c => !only || only.has(c.path))
    // 先取齐快照里的内容再写：取的时候 git 可能超时，不能留下改了一半的文件
    const files: string[] = []
    const blobs: (Buffer | null)[] = []
    for (const c of changes) {
      const blob = await state.repo.blob(before, c.path)
      if (blob === 'special') continue
      files.push(join(state.data.cwd, c.path))
      blobs.push(blob)
    }
    // 撤销用的当前内容在所有 await 之后、紧挨着写入再读：取快照期间用户又保存的，也算进撤销里
    const saved: Saved = files.map(path => ({ path, data: readOrNull(path) }))
    const size = saved.reduce((n, s) => n + (s.data?.length ?? 0), 0)
    let written = 0
    try {
      for (; written < saved.length; written++) writeBlob(saved[written]!.path, blobs[written]!)
    } catch (err) {
      // 写到一半失败（文件被占用、磁盘满）：已经写了的改回去，报「代码没变」才是真的。
      // 从失败的那个开始：writeFileSync 先清空再写，失败时它可能已经被清空了
      for (let i = written; i >= 0; i--) {
        try {
          writeBlob(saved[i]!.path, saved[i]!.data)
        } catch {
          /* 改不回去的只能留着，错误照样报出去 */
        }
      }
      throw err
    }
    return { saved: size <= UNDO_LIMIT ? saved : null, count: saved.length }
  }

  /**
   * 改动卡片撤回文件：改回这一轮开始前的内容（这一轮新建的删掉）。这一轮结束之后文件又被改过、force 不为真时，
   * 只返回会丢掉的内容，不改文件
   */
  async revertFiles(id: string, itemId: string, paths: string[], force: boolean): Promise<RevertFilesResult> {
    return this.holding(id, () => this.doRevert(id, itemId, paths, force))
  }

  private async doRevert(id: string, itemId: string, paths: string[], force: boolean): Promise<RevertFilesResult> {
    const state = this.usable(id)
    const turn = state?.data.turns[itemId]
    const skipped: Extract<RevertFilesResult, { kind: 'done' }>['skipped'] = []
    const skip = (path: string, reason: RevertSkip): void => {
      skipped.push({ path, reason, message: SKIP_TEXT[reason] })
    }
    if (!state || !turn?.before) {
      for (const path of paths) skip(path, 'no-checkpoint')
      return { kind: 'done', revertId: null, reverted: [], skipped }
    }
    if (!(await this.intact(id, state, itemId))) {
      for (const path of paths) skipped.push({ path, reason: 'no-checkpoint', message: CHECKPOINT_EXPIRED })
      return { kind: 'done', revertId: null, reverted: [], skipped }
    }
    const before = turn.before
    const targets: { input: string; rel: string; file: string; blob: TreeBlob }[] = []
    const inside = paths.flatMap(input => {
      const rel = workPath(state.data.cwd, input)
      if (!rel) skip(input, 'outside')
      return rel ? [{ input, rel }] : []
    })
    const ignored = await state.repo.ignored(inside.map(p => p.rel))
    for (const { input, rel } of inside) {
      const blob = await state.repo.blob(before, rel)
      // 快照里没有、又被排除的文件：不知道它原来是什么样（不能当成新建的删掉）
      if (blob === null && ignored.has(rel)) skip(input, 'excluded')
      else if (blob === 'special') skip(input, 'special')
      else targets.push({ input, rel, file: join(state.data.cwd, rel), blob })
    }
    const end = force ? null : this.endOf(id, state, itemId)
    if (end) {
      const conflicts: Extract<RevertFilesResult, { kind: 'conflict' }>['conflicts'] = []
      // 结束时的快照缺没缺内容：第一次读失败时才查
      let missing: boolean | undefined
      for (const t of targets) {
        let then: TreeBlob
        try {
          then = await state.repo.blob(end.tree, t.rel)
        } catch (err) {
          // 结束时的快照缺了内容（项目的 git 清理了借来的对象）：比不了内容，退回和 preview 一样比修改时间；
          // 别的错误（git 出错、超时）不猜，撤回失败、不动文件
          missing ??= await state.repo.incomplete(end.tree, LATER_TIMEOUT).catch(() => false)
          if (!missing) throw err
          // 没有快照时间（旧记录）：和结束时没拍到一样，当作没手改过
          if (end.at === undefined || !this.changedSince(state.data.cwd, [t.rel], end.at).length) continue
          // 没有结束时的内容：给出撤回会丢掉的全部改动（这一轮开始前 → 现在）
          conflicts.push({ path: t.input, ...conflictDiff(t.blob as Buffer | null, readOrNull(t.file)) })
          continue
        }
        if (then === 'special') continue
        const now = readOrNull(t.file)
        if (sameContent(then, now)) continue
        conflicts.push({ path: t.input, ...conflictDiff(then, now) })
      }
      if (conflicts.length) return { kind: 'conflict', conflicts }
    }
    const saved: Saved = []
    const reverted: string[] = []
    for (const t of targets) {
      try {
        const data = readOrNull(t.file)
        writeBlob(t.file, t.blob as Buffer | null)
        saved.push({ path: t.file, data })
        reverted.push(t.input)
      } catch (err) {
        skipped.push({ path: t.input, reason: 'failed', message: describeError(err) })
      }
    }
    if (!reverted.length) return { kind: 'done', revertId: null, reverted, skipped }
    const revertId = randomUUID()
    let map = this.reverts.get(id)
    if (!map) this.reverts.set(id, (map = new Map()))
    map.set(revertId, { itemId, paths: reverted, files: saved })
    return { kind: 'done', revertId, reverted, skipped }
  }

  /** 恢复撤回的文件：写回撤回前一刻的内容；paths 只恢复其中这些（撤回时传的路径） */
  async restoreFiles(id: string, revertId: string, paths?: string[]): Promise<void> {
    return this.holding(id, async () => this.doRestore(id, revertId, paths))
  }

  private doRestore(id: string, revertId: string, paths?: string[]): void {
    const entry = this.reverts.get(id)?.get(revertId)
    if (!entry) throw new Error('撤回记录已经没有了（重启过应用）')
    const only = paths ? new Set(paths) : null
    const keepPaths: string[] = []
    const keepFiles: Saved = []
    entry.paths.forEach((path, i) => {
      const file = entry.files[i]!
      if (only && !only.has(path)) {
        keepPaths.push(path)
        keepFiles.push(file)
      } else writeBlob(file.path, file.data)
    })
    if (keepPaths.length) this.reverts.get(id)!.set(revertId, { ...entry, paths: keepPaths, files: keepFiles })
    else this.reverts.get(id)!.delete(revertId)
  }

  /** 空闲时才能改文件；改的期间占住会话（changingSessions），不派发新消息 */
  private async holding<T>(id: string, task: () => Promise<T>): Promise<T> {
    const { ctx } = this
    if (ctx.closing) throw new Error('应用正在退出')
    if (ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const rt = ctx.m.sessions.runtime(id)
    if (rt.snapshot.state !== 'idle' || rt.pumping || rt.stopping || rt.activeId)
      throw new Error('请先停止当前任务再撤回')
    ctx.changingSessions.add(id)
    try {
      return await task()
    } finally {
      ctx.changingSessions.delete(id)
      // 占住期间排队的消息接着发
      queueMicrotask(() => void ctx.m.turn.pump(id))
    }
  }

  /** 应用退出：结束各会话正在跑的 git */
  async shutdown(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      clearInterval(this.timer)
      this.timer = null
    }
    await Promise.all([...this.states.values()].map(state => state.repo.stop()))
  }

  /** 会话删掉了：结束后台的 git 再删目录（影子仓库跟着会话目录删） */
  async forget(id: string): Promise<void> {
    const state = this.states.get(id)
    this.states.delete(id)
    this.reverts.delete(id)
    this.prepared.delete(id)
    // 不等它拍完：结束正在跑的 git，排着的不再跑
    await state?.repo.stop()
  }
}

async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir)
  return s.bavail * s.bsize
}

/** 目录一共占多少字节；不跟符号链接，读不了的（正在被删）当 0 */
async function dirBytes(path: string): Promise<number> {
  let total = 0
  const pending = [path]
  while (pending.length) {
    const batch = pending.splice(0, 64)
    await Promise.all(
      batch.map(async p => {
        try {
          const st = await lstat(p)
          if (st.isSymbolicLink()) return
          if (!st.isDirectory()) total += st.size
          else for (const name of await readdir(p)) pending.push(join(p, name))
        } catch {
          // 读不了：跳过
        }
      }),
    )
  }
  return total
}

function parseData(raw: unknown): FileData | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<FileData>
  if (o.version !== 1 || typeof o.cwd !== 'string' || !o.turns || typeof o.turns !== 'object') return null
  // 「太慢」以前会存下来、永久停用；现在只在这次运行里算，旧记录里的不认
  if (o.disabled === 'slow') delete o.disabled
  return o as FileData
}

function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function readOrNull(file: string): Buffer | null {
  return existsSync(file) ? readFileSync(file) : null
}

function writeBlob(file: string, data: Buffer | null): void {
  if (data === null) rmSync(file, { force: true })
  else {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
}

function sameContent(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b)
}

const isBinary = (b: Buffer | null): boolean => !!b && b.subarray(0, 8000).includes(0)

/** 冲突确认框里的 diff：这一轮结束时 → 现在 */
function conflictDiff(then: Buffer | null, now: Buffer | null): { diff: string; added: number; removed: number } {
  if (isBinary(then) || isBinary(now)) return { diff: '', added: 0, removed: 0 }
  const d = diffText(then?.toString('utf8') ?? '', now?.toString('utf8') ?? '')
  // 只留改动的行和前后各 2 行上下文
  const lines = d.diff.split('\n')
  const keep = new Set<number>()
  lines.forEach((line, i) => {
    if (line[0] === '+' || line[0] === '-') for (let j = i - 2; j <= i + 2; j++) keep.add(j)
  })
  const out: string[] = []
  let last = -2
  lines.forEach((line, i) => {
    if (!keep.has(i)) return
    if (i !== last + 1 && out.length) out.push('…')
    out.push(line)
    last = i
  })
  const diff = out.join('\n')
  return {
    diff: diff.length > CONFLICT_DIFF_LIMIT ? diff.slice(0, CONFLICT_DIFF_LIMIT) + '\n…' : diff,
    added: d.added,
    removed: d.removed,
  }
}
