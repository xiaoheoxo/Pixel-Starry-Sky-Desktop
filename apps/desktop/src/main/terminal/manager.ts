import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import type {
  TerminalEvent,
  TerminalProfile,
  TerminalProfileInput,
  TerminalRecord,
  TerminalState,
} from '../../shared/types/terminal'
import type { WorkspaceRef } from '../../shared/types/workspace'
import { detectBuiltin, probeCustom, profileInput, terminalEnvironment, terminalTitle } from './profiles'
import { shellIntegration, writeIntegrationFiles, type ShellIntegration } from './integration'
import { createMarkParser, type MarkParser, type ShellMark } from './shellMarks'

export interface TerminalTarget {
  projectId: string
  projectName: string
  cwd: string
}
interface Runtime {
  child: pty.IPty
  record: TerminalRecord
  owner: number
  generation: number
  seq: number
  pending: string
  inflight: Map<number, number>
  bytes: number
  paused: boolean
  closing: boolean
  /** shell 集成注入成功时才有：从输出里认提示符标记 */
  marks?: MarkParser
  /** 这种 shell 报告命令的退出码（cmd 不报） */
  exitCodes: boolean
  /** 已收到「命令结束」、等紧跟着的提示符开始 */
  ended: { exitCode: number | null } | null
  timer?: ReturnType<typeof setTimeout>
  done: Promise<void>
  finish: () => void
}
const HIGH = 256 * 1024,
  LOW = 64 * 1024,
  HARD = 4 * 1024 * 1024
/** 把 extra 并进环境变量；Windows 上变量名不分大小写，先去掉同名的（免得 Prompt 和 PROMPT 并存） */
function mergeEnv(env: Record<string, string>, extra: Record<string, string>): void {
  for (const [key, value] of Object.entries(extra)) {
    if (process.platform === 'win32')
      for (const old of Object.keys(env)) if (old.toLowerCase() === key.toLowerCase()) delete env[old]
    env[key] = value
  }
}
/** terminals.json 里缓存的上次检测结果：下次启动先用它，不等检测 */
interface ProfileCacheEntry {
  id: string
  label: string
  command: string
  args: string[]
  available: boolean
}
function profileCache(value: unknown): ProfileCacheEntry[] {
  const list: ProfileCacheEntry[] = []
  for (const raw of Array.isArray(value) ? value.slice(0, 40) : []) {
    if (
      !raw ||
      typeof raw.id !== 'string' ||
      !raw.id ||
      typeof raw.label !== 'string' ||
      typeof raw.command !== 'string' ||
      !Array.isArray(raw.args) ||
      raw.args.some((v: unknown) => typeof v !== 'string') ||
      typeof raw.available !== 'boolean'
    )
      continue
    list.push({ id: raw.id, label: raw.label, command: raw.command, args: [...raw.args], available: raw.available })
  }
  return list
}
export class TerminalManager {
  private readonly file: string
  /** bash / zsh 注入脚本所在目录；写失败为 null（只影响 bash / zsh，PowerShell / cmd 不用文件） */
  private integrationDir: string | null = null
  private records: TerminalRecord[] = []
  /** 启动时是上次检测的缓存（terminals.json 的 profileCache），没有缓存就是空的；init 起的后台检测完成后换成新结果 */
  private profiles: TerminalProfile[] = []
  /** 内置 Shell 的检测结果是否可信（来自缓存或本次检测）；不可信时不往 terminals.json 写缓存 */
  private builtinKnown = false
  /** 用户存在 terminals.json 里的默认 Shell；检测完重算 defaultId 时优先采用 */
  private storedDefault: string | null = null
  private defaultId = ''
  /** 正在跑的后台检测；没在跑为 null */
  private detecting: Promise<void> | null = null
  private profileListeners = new Set<() => void>()
  private running = new Map<string, Runtime>()
  private owners = new Map<string, number>()
  private busy = new Set<string>()
  private creates = new Map<string, Promise<TerminalRecord>>()
  private writes: Promise<void> = Promise.resolve()
  private stopping = false
  constructor(
    dataDir: string,
    private resolve: (ref: WorkspaceRef) => TerminalTarget,
    private emit: (owner: number, event: TerminalEvent) => void,
  ) {
    this.file = join(dataDir, 'terminal', 'terminals.json')
    this.integrationDir = join(dataDir, 'terminal', 'integration')
  }
  async init(): Promise<void> {
    try {
      await writeIntegrationFiles(this.integrationDir!)
    } catch {
      this.integrationDir = null
    }
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'))
      const cache = profileCache(data.profileCache)
      const custom: TerminalProfile[] = []
      for (const raw of Array.isArray(data.profiles) ? data.profiles.slice(0, 20) : []) {
        try {
          const p = profileInput(raw)
          if (p.id)
            custom.push({ ...p, id: p.id, available: cache.find(c => c.id === p.id)?.available ?? false, custom: true })
        } catch {
          /* ignore invalid profile */
        }
      }
      const builtin = cache.filter(c => !c.id.startsWith('custom-')).map(c => ({ ...c }))
      this.builtinKnown = builtin.length > 0
      this.profiles = [...builtin, ...custom]
      if (typeof data.defaultProfileId === 'string' && data.defaultProfileId) this.storedDefault = data.defaultProfileId
      const ids = new Set<string>()
      for (const raw of Array.isArray(data.terminals) ? data.terminals.slice(0, 12) : []) {
        if (
          !raw ||
          !['id', 'projectId', 'projectName', 'cwd', 'profileId', 'profileLabel', 'title'].every(
            k => typeof raw[k] === 'string' && raw[k].length > 0 && raw[k].length <= 4096,
          ) ||
          ids.has(raw.id)
        )
          continue
        try {
          const record: TerminalRecord = {
            id: raw.id,
            projectId: raw.projectId,
            projectName: raw.projectName,
            cwd: raw.cwd,
            profileId: raw.profileId,
            profileLabel: raw.profileLabel,
            title: terminalTitle(raw.title),
            titleEdited: !!raw.titleEdited,
            status: 'stopped',
            generation: 0,
            createdAt: Number(raw.createdAt) || Date.now(),
          }
          this.records.push(record)
          ids.add(record.id)
        } catch {
          /* invalid metadata never starts a shell */
        }
      }
    } catch {
      /* first use or damaged state */
    }
    this.defaultId = this.pickDefault()
    // 不等检测：它可能要异步起一次 powershell.exe，别拖住启动；检测完有变化会通知界面重新取一次
    void this.detect()
  }
  /** 用户存的默认 Shell 优先（在列表里就算），否则第一个可用的 */
  private pickDefault(): string {
    if (this.storedDefault && this.profiles.some(p => p.id === this.storedDefault)) return this.storedDefault
    return this.profiles.find(p => p.available)?.id ?? (this.builtinKnown ? 'powershell' : '')
  }
  /** 换上新的 Shell 列表并重算默认值；有变化时通知，返回列表本身有没有变 */
  private applyProfiles(profiles: TerminalProfile[]): boolean {
    const changed = JSON.stringify(profiles) !== JSON.stringify(this.profiles)
    const previous = this.defaultId
    this.profiles = profiles
    this.defaultId = this.pickDefault()
    if (changed || previous !== this.defaultId) for (const fn of [...this.profileListeners]) fn()
    return changed
  }
  /** Shell 列表变了（后台检测完、手动刷新）时通知；界面收到后重新取一次状态 */
  onProfilesChanged(fn: () => void): () => void {
    this.profileListeners.add(fn)
    return () => {
      this.profileListeners.delete(fn)
    }
  }
  /** 等正在跑的检测完成；没在跑立刻返回 */
  profilesReady(): Promise<void> {
    return this.detecting ?? Promise.resolve()
  }
  /** 重新检测一次；已经在检测就并进那一次 */
  refresh(): Promise<void> {
    return this.detect()
  }
  private detect(): Promise<void> {
    return (this.detecting ??= this.runDetect().finally(() => {
      this.detecting = null
    }))
  }
  private async runDetect(): Promise<void> {
    const customs = this.profiles.filter(p => p.custom)
    try {
      const [builtin, probed] = await Promise.all([detectBuiltin(), probeCustom(customs)])
      // 检测期间自定义 Shell 可能被改过：只采用没变的那些的结果，其余保持现状
      const same = (a: TerminalProfile, b: TerminalProfile): boolean =>
        a.id === b.id && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args)
      const known = this.builtinKnown
      this.builtinKnown = true
      const changed = this.applyProfiles([
        ...builtin,
        ...this.profiles
          .filter(p => p.custom)
          .map(p => {
            const before = customs.find(c => same(c, p))
            const result = before && probed.find(c => c.id === p.id)
            return result ? { ...result, custom: true } : p
          }),
      ])
      // 和缓存不一样才写盘
      if (changed || !known) void this.save().catch(() => {})
    } catch {
      /* 检测出错就沿用现有列表（缓存），下次启动或手动刷新再试 */
    }
  }
  /** 请求的 Shell 现在还不可用、而检测还在跑时，等检测完再判断（首次启动没有缓存的情况） */
  private async settle(profileId: string): Promise<void> {
    if (this.detecting && !this.profiles.some(p => p.id === profileId && p.available)) await this.detecting
  }
  private save(): Promise<void> {
    const data = JSON.stringify(
      {
        version: 1,
        // 没存过用户选择时不写计算出来的默认值，这样之后装了 PowerShell 7 之类能自动换成更好的
        defaultProfileId: this.storedDefault ?? undefined,
        profileCache: this.builtinKnown
          ? this.profiles.map(p => ({
              id: p.id,
              label: p.label,
              command: p.command,
              args: [...p.args],
              available: p.available,
            }))
          : undefined,
        profiles: this.profiles.filter(p => p.custom),
        terminals: this.records.map(r => ({
          ...r,
          status: 'stopped',
          error: undefined,
          exitCode: undefined,
          generation: 0,
        })),
      },
      null,
      2,
    )
    const task = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(this.file + '.tmp', data, 'utf8')
        await rename(this.file + '.tmp', this.file)
      })
    this.writes = task
    return task
  }
  state(owner: number): TerminalState {
    return {
      profiles: this.profiles.map(p => ({ ...p, args: [...p.args] })),
      defaultProfileId: this.defaultId,
      terminals: this.records
        .filter(r => !this.owners.has(r.id) || this.owners.get(r.id) === owner)
        .map(r => ({ ...r })),
    }
  }
  private record(owner: number, id: string): TerminalRecord {
    const r = this.records.find(r => r.id === id)
    if (!r || (this.owners.has(id) && this.owners.get(id) !== owner)) throw new Error('终端已不存在或属于其他窗口')
    return r
  }
  private update(r: TerminalRecord): void {
    const owner = this.owners.get(r.id)
    if (owner !== undefined) this.emit(owner, { type: 'record', record: { ...r } })
  }
  async setDefault(owner: number, id: string): Promise<TerminalState> {
    await this.settle(id)
    if (!this.profiles.some(p => p.id === id && p.available)) throw new Error('所选 Shell 不可用')
    this.storedDefault = id
    this.defaultId = id
    await this.save()
    return this.state(owner)
  }
  async saveProfile(owner: number, input: TerminalProfileInput): Promise<TerminalState> {
    const p = profileInput(input)
    if (!p.id && this.profiles.filter(p => p.custom).length >= 20) throw new Error('最多保存 20 个自定义 Shell')
    if (p.id && !this.profiles.some(item => item.id === p.id && item.custom)) throw new Error('所选 Shell 不可用')
    const [profile] = await probeCustom([
      { ...p, id: p.id ?? 'custom-' + randomUUID(), custom: true, available: false },
    ])
    // 探测期间列表可能被后台检测换过，所以探测完再同步拼
    this.profiles = [
      ...this.profiles.filter(item => !item.custom || item.id !== profile.id),
      { ...profile, custom: true },
    ]
    this.defaultId = this.pickDefault()
    await this.save()
    return this.state(owner)
  }
  async removeProfile(owner: number, id?: string): Promise<TerminalState> {
    if (id && !this.profiles.some(p => p.id === id && p.custom)) throw new Error('只能修改自定义 Shell')
    this.profiles = this.profiles.filter(p => !p.custom || (id !== undefined && p.id !== id))
    if (!id || id === this.storedDefault) this.storedDefault = null
    this.defaultId = this.pickDefault()
    await this.save()
    return this.state(owner)
  }
  create(owner: number, ref: WorkspaceRef, profileId: string | undefined, requestId: string): Promise<TerminalRecord> {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 160)
      return Promise.reject(new Error('终端请求不正确'))
    const key = owner + ':' + requestId,
      old = this.creates.get(key)
    if (old) return old
    const task = this.createOnce(owner, ref, profileId)
    this.creates.set(key, task)
    if (this.creates.size > 64) this.creates.delete(this.creates.keys().next().value!)
    return task
  }
  private async createOnce(owner: number, ref: WorkspaceRef, profileId?: string): Promise<TerminalRecord> {
    // 先等检测，再做数量和关闭检查：检查到 push 记录之间不能再有 await，否则并发的创建会一起越过上限
    await this.settle(profileId ?? this.defaultId)
    if (this.stopping) throw new Error('终端正在关闭')
    if (this.records.length >= 12) throw new Error('最多打开 12 个终端，请先关闭部分标签')
    const target = this.resolve(ref)
    const profile = this.profiles.find(p => p.id === (profileId ?? this.defaultId))
    if (!profile?.available) throw new Error('所选 Shell 不可用')
    this.checkDirectory(target.cwd)
    const record: TerminalRecord = {
      id: randomUUID(),
      ...target,
      title: profile.label,
      titleEdited: false,
      profileId: profile.id,
      profileLabel: profile.label,
      status: 'stopped',
      generation: 0,
      createdAt: Date.now(),
    }
    this.records.push(record)
    this.owners.set(record.id, owner)
    await this.save()
    return this.start(owner, record)
  }
  private checkDirectory(cwd: string): void {
    try {
      if (statSync(cwd).isDirectory()) return
    } catch {}
    throw new Error('项目目录不存在')
  }
  private start(owner: number, record: TerminalRecord): TerminalRecord {
    if (this.stopping) throw new Error('终端正在关闭')
    record.generation++
    record.status = 'starting'
    record.error = undefined
    record.exitCode = undefined
    this.owners.set(record.id, owner)
    this.update(record)
    try {
      const target = this.resolve({ projectId: record.projectId })
      this.checkDirectory(target.cwd)
      this.checkDirectory(record.cwd)
      const profile = this.profiles.find(p => p.id === record.profileId)
      if (!profile?.available) throw new Error('所选 Shell 不可用')
      const env = terminalEnvironment(process.env)
      let integration: ShellIntegration | null = null
      try {
        integration = shellIntegration(profile, this.integrationDir, env)
      } catch {
        /* 注入出错就当没有，shell 照常启动 */
      }
      if (integration) mergeEnv(env, integration.env)
      const child = pty.spawn(profile.command, integration?.args ?? profile.args, {
        name: 'xterm-256color',
        cols: 100,
        rows: 24,
        cwd: record.cwd,
        env,
        useConpty: true,
      })
      let finish!: () => void
      const done = new Promise<void>(r => {
        finish = r
      })
      const run: Runtime = {
        child,
        record,
        owner,
        generation: record.generation,
        seq: 0,
        pending: '',
        inflight: new Map(),
        bytes: 0,
        paused: false,
        closing: false,
        marks: integration ? createMarkParser() : undefined,
        exitCodes: integration?.exitCodes ?? false,
        ended: null,
        done,
        finish,
      }
      this.running.set(record.id, run)
      const dataSub = child.onData(data => {
        if (this.running.get(record.id) !== run || run.closing) return
        if (run.marks) {
          const parsed = run.marks.push(data)
          for (const mark of parsed.marks) this.mark(run, mark)
          data = parsed.text
          if (!data) return
        }
        run.pending += data
        if (run.pending.length + run.bytes > HIGH && !run.paused) {
          child.pause()
          run.paused = true
        }
        if (run.pending.length > HARD) {
          record.error = '终端输出超过缓冲上限，进程已停止'
          void this.stop(run).catch(() => {})
          return
        }
        if (!run.timer)
          run.timer = setTimeout(() => {
            run.timer = undefined
            this.flush(run)
          }, 12)
      })
      const exitSub = child.onExit(({ exitCode }) => {
        if (this.running.get(record.id) === run) {
          this.flush(run)
          this.running.delete(record.id)
          record.status = 'exited'
          record.exitCode = exitCode
          this.update(record)
        }
        clearTimeout(run.timer)
        dataSub.dispose()
        exitSub.dispose()
        finish()
      })
      record.status = 'running'
      record.lastStartedAt = Date.now()
      record.profileLabel = profile.label
      this.update(record)
    } catch (cause) {
      record.status = 'error'
      record.error = String(cause instanceof Error ? cause.message : cause)
      this.update(record)
    }
    return { ...record }
  }
  /** 提示符标记：命令结束先记着，紧跟的提示符开始再一起发给界面（不排在输出后面，不受背压拖慢） */
  private mark(run: Runtime, mark: ShellMark): void {
    if (mark.kind === 'end') {
      run.ended = { exitCode: mark.exitCode }
      return
    }
    const ended = run.ended
    run.ended = null
    this.emit(run.owner, {
      type: 'prompt',
      terminalId: run.record.id,
      generation: run.generation,
      ran: ended ? true : run.exitCodes ? false : null,
      exitCode: ended?.exitCode ?? null,
    })
  }
  private flush(run: Runtime): void {
    while (run.pending && run.bytes < HIGH && !run.closing) {
      const data = run.pending.slice(0, 32768)
      run.pending = run.pending.slice(data.length)
      const seq = ++run.seq
      run.inflight.set(seq, data.length)
      run.bytes += data.length
      this.emit(run.owner, { type: 'data', terminalId: run.record.id, generation: run.generation, seq, data })
    }
  }
  ack(owner: number, id: string, generation: number, seq: number): void {
    const run = this.running.get(id)
    if (!run || run.owner !== owner || run.generation !== generation) return
    const size = run.inflight.get(seq)
    if (size === undefined) return
    run.bytes -= size
    run.inflight.delete(seq)
    this.flush(run)
    if (run.paused && run.bytes + run.pending.length < LOW) {
      run.paused = false
      run.child.resume()
    }
  }
  write(owner: number, id: string, generation: number, data: string): void {
    this.record(owner, id)
    const run = this.running.get(id)
    if (typeof data !== 'string' || data.length > 256 * 1024) throw new Error('终端输入过长')
    if (!run || run.closing || run.generation !== generation) throw new Error('终端尚未启动')
    run.child.write(data)
  }
  resize(owner: number, id: string, generation: number, cols: number, rows: number): void {
    this.record(owner, id)
    const run = this.running.get(id)
    if (!run || run.closing || run.generation !== generation) return
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300)
      throw new Error('终端尺寸不正确')
    try {
      run.child.resize(cols, rows)
    } catch {
      /* exit can race the last resize */
    }
  }
  async rename(owner: number, id: string, value: string): Promise<TerminalRecord> {
    const record = this.record(owner, id)
    record.title = terminalTitle(value)
    record.titleEdited = true
    this.update(record)
    await this.save()
    return { ...record }
  }
  private async stop(run: Runtime): Promise<void> {
    run.closing = true
    clearTimeout(run.timer)
    if (run.paused) run.child.resume()
    try {
      run.child.kill()
    } catch {
      run.finish()
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        run.done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('终端未能停止，请重试')), 5000)
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }
  async change(owner: number, id: string, restart: boolean, force = false): Promise<TerminalRecord | void> {
    const record = this.record(owner, id)
    if (this.busy.has(id)) throw new Error('终端正在关闭')
    const run = this.running.get(id)
    if (run && !force) throw new Error('TERMINAL_RUNNING')
    this.busy.add(id)
    try {
      if (run) await this.stop(run)
      if (restart) {
        await this.settle(record.profileId)
        return this.start(owner, record)
      }
      this.records = this.records.filter(r => r.id !== id)
      this.owners.delete(id)
      await this.save()
    } finally {
      this.busy.delete(id)
    }
  }
  /** 停掉工作目录在 path 里（含 path 本身）的运行中终端，保留终端记录（删除副本前释放目录占用，GitHub #37） */
  async stopUnder(path: string): Promise<void> {
    const fold = (v: string): string => (process.platform === 'win32' ? resolve(v).toLowerCase() : resolve(v))
    const root = fold(path)
    const runs = [...this.running.values()].filter(run => {
      const rel = relative(root, fold(run.record.cwd))
      return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
    })
    await Promise.all(runs.map(run => this.stop(run)))
  }
  hasRunning(owner?: number): boolean {
    return [...this.running.values()].some(run => owner === undefined || run.owner === owner)
  }
  async shutdown(owner?: number): Promise<void> {
    if (owner === undefined) this.stopping = true
    const runs = [...this.running.values()].filter(r => owner === undefined || r.owner === owner)
    await Promise.all(runs.map(run => this.stop(run)))
    for (const [id, owning] of this.owners) if (owner === undefined || owning === owner) this.owners.delete(id)
    await this.save()
  }
}
