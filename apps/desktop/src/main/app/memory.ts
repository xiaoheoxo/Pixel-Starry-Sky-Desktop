// 内存遥测（docs/ui/renderer-memory.md §3.2）：界面每次 log.sample() 进来，主进程当场取自己这边的数合成一条采样，
// 只在换档、首条、心跳时写日志；崩溃时把最近 10 条和整机内存写进「渲染进程退出」。
import { app, type WebContents } from 'electron'
import { logger } from '@pixelsky/engine'
import type { RendererMemorySample } from '../../shared/types/memory'

const log = logger('perf')

export const NORMAL_MS = 60_000
/** 内存紧张时的采样间隔 */
export const FAST_MS = 10_000
/** 两次写盘至少隔这么久（首条和关键指标变差除外） */
export const WRITE_GAP_MS = 60_000
export const HEARTBEAT_MS = 30 * 60_000
export const RING_SIZE = 10

const mb = (kb: number): number => Math.round(kb / 1024)
const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 100)

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** privateBytes 在 Electron 类型里是可选的（macOS 不提供），没有就保持缺省，判断时改用工作集 */
export interface ProcMem {
  privateMb?: number
  workingSetMb: number
}
export interface SystemMem {
  totalMb: number
  freeMb: number
  freePct: number
  /** Windows 上 swapTotal / swapFree 就是提交上限和剩余可提交量；其他平台留空 */
  commitTotalMb?: number
  commitFreeMb?: number
  commitFreePct?: number
}
export interface EngineMem {
  runtimes: number
  processes: number
  running: number
}
export interface MemorySample {
  at: number
  /** 界面没按时报时为 null（界面卡住） */
  renderer: RendererMemorySample | null
  processes: { renderer?: ProcMem; gpu?: ProcMem; browser?: ProcMem; otherMb: number }
  system: SystemMem
  main: { heapUsedMb: number; rssMb: number }
  engine: EngineMem
}
/** getAppMetrics() 里用到的部分 */
export interface AppMetric {
  pid: number
  type: string
  memory: { workingSetSize: number; privateBytes?: number }
}

// ---------------------------------------------------------------------------
// 纯函数：分档、取数
// ---------------------------------------------------------------------------

export type Metric = 'private' | 'heap' | 'elements' | 'snapshot' | 'free'

/** 第 k 档（k ≥ 1）的下边界；free 是百分比，取负数让「越低越差」和其他指标同向 */
function edge(metric: Metric, k: number): number {
  switch (metric) {
    case 'private':
      return k === 1 ? 512 : 1024 + 512 * (k - 2)
    case 'heap':
      return 256 * k
    case 'elements':
      return [10_000, 25_000, 50_000][k - 1] ?? Infinity
    case 'snapshot':
      return 64 * k
    case 'free':
      return [-20, -10, -5][k - 1] ?? Infinity
  }
}
const HYSTERESIS: Record<Metric, number> = { private: 64, heap: 32, elements: 1_000, snapshot: 8, free: 1 }

/** 当前在第几档；越过「边界 ± 回差」才换档，免得在边界上来回锯齿 */
export function bandOf(metric: Metric, value: number, current: number): number {
  const x = metric === 'free' ? -value : value
  const h = HYSTERESIS[metric]
  let level = current
  while (x >= edge(metric, level + 1) + h) level++
  while (level > 0 && x < edge(metric, level) - h) level--
  return level
}

/** 界面传来的数：不信任，数字取有限非负值，其余按 0 / false */
export function parseRendererSample(raw: unknown): RendererMemorySample | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const n = (key: string): number => {
    const v = r[key]
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : 0
  }
  return {
    heapUsedMb: n('heapUsedMb'),
    heapTotalMb: n('heapTotalMb'),
    heapLimitMb: n('heapLimitMb'),
    elements: n('elements'),
    mountedTabs: n('mountedTabs'),
    sessionViews: n('sessionViews'),
    shownTurnsMax: n('shownTurnsMax'),
    snapshots: n('snapshots'),
    snapshotItems: n('snapshotItems'),
    snapshotTextMb: n('snapshotTextMb'),
    imageB64Mb: n('imageB64Mb'),
    terminals: n('terminals'),
    terminalLines: n('terminalLines'),
    codeEditors: n('codeEditors'),
    lightweight: r.lightweight === true,
  }
}

function procMem(m: AppMetric['memory']): ProcMem {
  return {
    workingSetMb: mb(m.workingSetSize),
    ...(m.privateBytes !== undefined ? { privateMb: mb(m.privateBytes) } : {}),
  }
}

/** 各进程的内存：界面进程按 pid 找；GPU、主进程各一个；其余合计（有私有内存用私有内存，没有用工作集） */
export function summarizeProcesses(metrics: readonly AppMetric[], rendererPid: number): MemorySample['processes'] {
  const out: MemorySample['processes'] = { otherMb: 0 }
  for (const p of metrics) {
    if (p.pid === rendererPid) out.renderer = procMem(p.memory)
    else if (p.type === 'GPU') out.gpu = procMem(p.memory)
    else if (p.type === 'Browser') out.browser = procMem(p.memory)
    else out.otherMb += p.memory.privateBytes !== undefined ? mb(p.memory.privateBytes) : mb(p.memory.workingSetSize)
  }
  return out
}

/**
 * process.getSystemMemoryInfo()（KB）换成 MB；commit 只在 Windows 上取 swapTotal / swapFree 原值，不要再加物理内存。
 * Linux 的 free 是 MemFree（不含页缓存，平时就很低），改用 MemAvailable（available）；老内核上它是 0，退回 free
 */
export function systemMemory(
  info: { total: number; free: number; available?: number; swapTotal?: number; swapFree?: number },
  platform: string = process.platform,
): SystemMem {
  const free = platform === 'linux' && info.available ? info.available : info.free
  const out: SystemMem = { totalMb: mb(info.total), freeMb: mb(free), freePct: pct(free, info.total) }
  if (platform === 'win32' && info.swapTotal !== undefined && info.swapFree !== undefined && info.swapTotal > 0) {
    out.commitTotalMb = mb(info.swapTotal)
    out.commitFreeMb = mb(info.swapFree)
    out.commitFreePct = pct(info.swapFree, info.swapTotal)
  }
  return out
}

/** 界面进程的内存档位依据：有私有内存用私有内存，没有（macOS）用工作集 */
export function rendererBasis(p: ProcMem | undefined): { mb: number; basis: 'private' | 'ws' } {
  if (!p) return { mb: 0, basis: 'private' }
  return p.privateMb !== undefined ? { mb: p.privateMb, basis: 'private' } : { mb: p.workingSetMb, basis: 'ws' }
}

const pair = (p: ProcMem | undefined): string | undefined => (p ? `${p.privateMb ?? '-'}/${p.workingSetMb}` : undefined)

/** 写进日志的字段：压成短键，一条一行 */
export function sampleFields(s: MemorySample): Record<string, unknown> {
  const r = s.renderer
  const basis = rendererBasis(s.processes.renderer).basis
  return {
    ...(r
      ? {
          renderer: {
            heap: r.heapUsedMb,
            heapLimit: r.heapLimitMb,
            els: r.elements,
            tabs: r.mountedTabs,
            views: r.sessionViews,
            turns: r.shownTurnsMax,
            snaps: r.snapshots,
            items: r.snapshotItems,
            textMb: r.snapshotTextMb,
            imgMb: r.imageB64Mb,
            terms: r.terminals,
            termLines: r.terminalLines,
            editors: r.codeEditors,
            ...(r.lightweight ? { lightweight: true } : {}),
          },
        }
      : { renderer: null }),
    procs: {
      r: pair(s.processes.renderer),
      gpu: pair(s.processes.gpu),
      main: pair(s.processes.browser),
      otherMb: s.processes.otherMb,
    },
    sys: {
      free: `${s.system.freePct}%`,
      ...(s.system.commitFreePct !== undefined ? { commit: `${s.system.commitFreePct}%` } : {}),
    },
    mainHeapMb: s.main.heapUsedMb,
    engine: { rt: s.engine.runtimes, proc: s.engine.processes, run: s.engine.running },
    ...(basis === 'ws' ? { basis: 'ws' } : {}),
  }
}

// ---------------------------------------------------------------------------
// 写盘节流（纯状态机，memory.test.ts）
// ---------------------------------------------------------------------------

type Levels = Record<'private' | 'gpu' | 'heap' | 'elements' | 'snapshot' | 'phys' | 'commit', number>
const ZERO: Levels = { private: 0, gpu: 0, heap: 0, elements: 0, snapshot: 0, phys: 0, commit: 0 }

export interface Decision {
  write: boolean
  level: 'info' | 'warn'
  /** 回复给界面的下一次采样间隔 */
  intervalMs: number
}

export function createTelemetry() {
  const ring: MemorySample[] = []
  let current: Levels = { ...ZERO }
  let written: Levels = { ...ZERO }
  let lastWriteAt = -Infinity
  let first = true
  let fast = false

  return {
    /** 每次界面加载后的第一条一定写 */
    markLoaded(): void {
      first = true
    },
    recent(count = RING_SIZE): MemorySample[] {
      return ring.slice(-count)
    },
    get fast(): boolean {
      return fast
    },
    push(s: MemorySample, now: number): Decision {
      ring.push(s)
      if (ring.length > RING_SIZE) ring.shift()
      const r = s.renderer
      const next = { ...current }
      const { mb: privateMb } = rendererBasis(s.processes.renderer)
      if (s.processes.renderer) next.private = bandOf('private', privateMb, current.private)
      if (s.processes.gpu)
        next.gpu = bandOf('private', s.processes.gpu.privateMb ?? s.processes.gpu.workingSetMb, current.gpu)
      if (r) {
        next.heap = bandOf('heap', r.heapUsedMb, current.heap)
        next.elements = bandOf('elements', r.elements, current.elements)
        next.snapshot = bandOf('snapshot', r.snapshotTextMb + r.imageB64Mb, current.snapshot)
      }
      next.phys = bandOf('free', s.system.freePct, current.phys)
      if (s.system.commitFreePct !== undefined) next.commit = bandOf('free', s.system.commitFreePct, current.commit)
      current = next

      // 快采：私有内存 ≥ 1024 MB，或整机物理 / 可提交余量 < 10%；回落到 896 MB 以下且两个百分比都 ≥ 12% 才回到 60 秒
      const commit = s.system.commitFreePct
      const wasFast = fast
      if (!fast) fast = privateMb >= 1024 || s.system.freePct < 10 || (commit !== undefined && commit < 10)
      else if (privateMb < 896 && s.system.freePct >= 12 && (commit === undefined || commit >= 12)) fast = false

      const changed = (Object.keys(current) as (keyof Levels)[]).some(k => current[k] !== written[k])
      // 关键指标往差的方向换档可以突破 60 秒限速：界面私有内存升档，整机物理 / 可提交余量降档
      const worse = current.private > written.private || current.phys > written.phys || current.commit > written.commit
      const since = now - lastWriteAt
      const write = first || (changed && (worse || since >= WRITE_GAP_MS)) || since >= HEARTBEAT_MS
      if (write) {
        first = false
        written = { ...current }
        lastWriteAt = now
      }
      const tight = s.system.freePct < 10 || (commit !== undefined && commit < 10)
      return { write, level: (fast && !wasFast) || tight ? 'warn' : 'info', intervalMs: fast ? FAST_MS : NORMAL_MS }
    },
  }
}

// ---------------------------------------------------------------------------
// 内存紧张时释放闲置引擎进程（纯状态机，docs/engine-idle-release.md §3 #2）
// ---------------------------------------------------------------------------

/** 进入 / 退出「内存紧张」的百分比：macOS 的物理可用不含文件缓存、平时就偏低，用低一档 */
export const LOW_MEMORY_PCT = { enter: 15, exit: 18, macEnter: 5, macExit: 8 } as const
/** 一直紧张时，两次释放至少隔这么久（期间新变成闲置的下一次放） */
export const LOW_MEMORY_COOLDOWN_MS = 60_000

export interface LowMemoryDecision {
  /** 这次要不要释放 */
  release: boolean
  /** 这次进入 / 退出了紧张状态 */
  changed: 'enter' | 'exit' | null
}

export function createLowMemory(platform: string = process.platform) {
  const enter = platform === 'darwin' ? LOW_MEMORY_PCT.macEnter : LOW_MEMORY_PCT.enter
  const exit = platform === 'darwin' ? LOW_MEMORY_PCT.macExit : LOW_MEMORY_PCT.exit
  let low = false
  let lastReleaseAt = -Infinity
  return {
    get low(): boolean {
      return low
    },
    push(s: SystemMem, now: number): LowMemoryDecision {
      const commit = s.commitFreePct
      let changed: LowMemoryDecision['changed'] = null
      if (!low && (s.freePct < enter || (commit !== undefined && commit < enter))) {
        low = true
        changed = 'enter'
      } else if (low && s.freePct >= exit && (commit === undefined || commit >= exit)) {
        low = false
        changed = 'exit'
      }
      // 刚进入时马上放一次；一直紧张时隔一段再放
      const release = changed === 'enter' || (low && now - lastReleaseAt >= LOW_MEMORY_COOLDOWN_MS)
      if (release) lastReleaseAt = now
      return { release, changed }
    },
  }
}

// ---------------------------------------------------------------------------
// 接到主进程
// ---------------------------------------------------------------------------

export interface MemoryDeps {
  /** 本机引擎宿主的计数；引擎还没起来时为全 0 */
  engine: () => EngineMem
  /** 每次取到的 getAppMetrics() 同时喂给原来的「内存占用高」分档（responsiveness.ts memoryChecker） */
  check: (metrics: ReturnType<typeof app.getAppMetrics>) => void
  /** 看门狗：没人报时取哪个窗口的界面进程 */
  rendererPid: () => number | null
  /** 内存紧张时放掉本机所有闲置的引擎进程，返回放了几个；引擎还没起来时为 0。同步返回，关进程在后台 */
  releaseIdle?: () => number
}

let deps: MemoryDeps | null = null
const telemetry = createTelemetry()
const lowMemory = createLowMemory()
let intervalMs = NORMAL_MS
let lastSampleAt = Date.now()
/** 界面最近一次加载完的时刻，崩溃时算 sinceLoadMs */
const loadedAt = new WeakMap<WebContents, number>()

export function initMemory(d: MemoryDeps): void {
  deps = d
  lastSampleAt = Date.now()
}

/** 界面加载完（did-finish-load）：下一条采样一定写 */
export function noteLoaded(contents: WebContents): void {
  loadedAt.set(contents, Date.now())
  telemetry.markLoaded()
}

export function sinceLoadMs(contents: WebContents): number | null {
  const at = loadedAt.get(contents)
  return at === undefined ? null : Date.now() - at
}

function collect(renderer: RendererMemorySample | null, rendererPid: number, metrics: AppMetric[]): MemorySample {
  const usage = process.memoryUsage()
  return {
    at: Date.now(),
    renderer,
    processes: summarizeProcesses(metrics, rendererPid),
    system: systemMemory(process.getSystemMemoryInfo()),
    main: { heapUsedMb: Math.round(usage.heapUsed / 1048576), rssMb: Math.round(usage.rss / 1048576) },
    engine: deps?.engine() ?? { runtimes: 0, processes: 0, running: 0 },
  }
}

function record(sample: MemorySample): number {
  lastSampleAt = Date.now()
  const decision = telemetry.push(sample, sample.at)
  intervalMs = decision.intervalMs
  if (decision.write) log[decision.level]('内存采样', sampleFields(sample))
  relieve(sample)
  return decision.intervalMs
}

/** 内存紧张就放掉闲置的引擎进程；不能抛错（这里跑在 log:sample 的回复里） */
function relieve(sample: Pick<MemorySample, 'at' | 'system' | 'engine'>): void {
  const d = lowMemory.push(sample.system, sample.at)
  if (d.changed === 'exit') log.info('内存不再紧张', pickSystem(sample.system))
  if (!d.release) return
  let released = 0
  try {
    released = deps?.releaseIdle?.() ?? 0
  } catch (err) {
    log.warn('释放闲置引擎进程失败', { error: err instanceof Error ? err.message : String(err) })
  }
  if (d.changed === 'enter' || released > 0)
    log[d.changed === 'enter' ? 'warn' : 'info']('内存紧张，释放闲置引擎进程', {
      ...pickSystem(sample.system),
      released,
      engine: { rt: sample.engine.runtimes, proc: sample.engine.processes, run: sample.engine.running },
    })
}

/** 整机还能用的内存（MB）：物理可用和可提交余量取小的；界面按它定切走的对话保留几个（docs/ui/performance.md §5.3） */
export const roomMb = (s: SystemMem): number => Math.min(s.freeMb, s.commitFreeMb ?? Infinity)

/** log:sample 的处理：界面报来的数 + 主进程同一时刻的数；回复下一次采样的间隔和整机还能用的内存 */
export function onRendererSample(contents: WebContents, raw: unknown): { intervalMs: number; freeMb?: number } {
  if (!deps) return { intervalMs: NORMAL_MS }
  const metrics = app.getAppMetrics()
  deps.check(metrics)
  const sample = collect(parseRendererSample(raw), contents.getOSProcessId(), metrics)
  return { intervalMs: record(sample), freeMb: roomMb(sample.system) }
}

/**
 * responsiveness.ts 的 60 秒定时器每次调用：分档检查照旧；界面超过「间隔 × 2 + 5 秒」没报，
 * 就只取主进程这边的数记一条（renderer: null，说明界面可能卡住了）
 */
export function memoryTick(metrics: ReturnType<typeof app.getAppMetrics>): void {
  if (!deps) return
  deps.check(metrics)
  if (Date.now() - lastSampleAt <= intervalMs * 2 + 5_000) return
  const pid = deps.rendererPid()
  // 没有窗口（macOS 关掉了所有窗口）：不记采样，但内存紧张照样释放闲置的引擎进程
  if (pid === null) {
    relieve({ at: Date.now(), system: systemMemory(process.getSystemMemoryInfo()), engine: deps.engine() })
    return
  }
  record(collect(null, pid, metrics))
}

/** 渲染进程退出时补进日志的字段：最近 10 条采样、这一刻的整机内存和 GPU 进程；退出之后 getAppMetrics 里已经没有界面进程了 */
export function crashFields(contents: WebContents): Record<string, unknown> {
  const gpu = app.getAppMetrics().find(p => p.type === 'GPU')
  const system = systemMemory(process.getSystemMemoryInfo())
  const since = sinceLoadMs(contents)
  return {
    recent: telemetry.recent().map(s => ({ at: s.at, ...sampleFields(s) })),
    system: pickSystem(system),
    ...(gpu ? { gpu: procMem(gpu.memory) } : {}),
    ...(since !== null ? { sinceLoadMs: since } : {}),
  }
}

/** 这一刻的整机内存（日志字段）：GPU 进程退出时也记 */
export function systemNow(): Record<string, unknown> {
  return pickSystem(systemMemory(process.getSystemMemoryInfo()))
}

/** 整机内存的日志字段：物理可用、可提交余量 */
export function pickSystem(s: SystemMem): Record<string, unknown> {
  return {
    freeMb: s.freeMb,
    freePct: s.freePct,
    ...(s.commitFreeMb !== undefined ? { commitFreeMb: s.commitFreeMb, commitFreePct: s.commitFreePct } : {}),
  }
}
