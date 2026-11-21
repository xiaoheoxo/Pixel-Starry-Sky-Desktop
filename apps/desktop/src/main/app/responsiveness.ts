// 卡顿诊断（docs/ui/logging.md §4.9）：窗口没响应、主进程被占住、内存涨得很高时写进本机日志，
// 下次卡死能从日志看出卡在哪一边、卡在哪段代码。用户卡住后多半直接结束进程，所以窗口没响应的记录马上同步写盘。
// 画面停住（GPU 那边）另记显卡、锁屏、显示器变化，用来分辨是驱动、换显示器还是内存。
import { app, BrowserWindow, powerMonitor, screen, type Display, type Session, type WebContents } from 'electron'
import { logger } from '@pixelsky/engine'
import * as ipc from '../ipc/guard'
import { logService } from './logging'
import { systemNow } from './memory'

const log = logger('perf')

/** 页面声明了这条 Document-Policy，主进程才能取到它正在跑的 JS 调用栈（还要打开下面的 Chromium 开关） */
const CALL_STACK_POLICY = 'include-js-call-stacks-in-crash-reports'
const CALL_STACK_FEATURE = 'DocumentPolicyIncludeJSCallStacksInCrashReports'
/** 取调用栈最多等这么久：页面里没有 JS 在跑时它一直不返回 */
const STACK_TIMEOUT_MS = 3_000
const STACK_LINES = 25
/** 窗口一直没响应时，隔这么久再记一次（看内存和调用栈有没有变），最多记这么多次 */
const REPEAT_MS = 30_000
const MAX_REPEATS = 10

/** 主进程计时器每秒跳一次，晚到超过这么久算卡住 */
const TICK_MS = 1_000
const LAG_MS = 2_000

/** 进程内存每分钟看一次；超过 1.5 GB 记一条，之后每再涨 512 MB 记一条，回落到 1 GB 以下重新开始 */
const MEMORY_EVERY_MS = 60_000
export const MEMORY_WARN_MB = 1_536
export const MEMORY_STEP_MB = 512

const mb = (kb: number): number => Math.round(kb / 1024)

/** 在 app ready 之前调用：打开取调用栈要用的 Chromium 开关（目前没有别处设 enable-features） */
export function enableCallStacks(): void {
  app.commandLine.appendSwitch('enable-features', CALL_STACK_FEATURE)
}

/** 应用自己的页面加上 Document-Policy 响应头（本地文件也会经过这里）；只动顶层页面 */
export function allowCallStacks(session: Session, isAppUrl: (url: string) => boolean): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame' || !isAppUrl(details.url)) return callback({})
    callback({ responseHeaders: { ...details.responseHeaders, 'Document-Policy': [CALL_STACK_POLICY] } })
  })
}

type ProcessMetric = ReturnType<typeof app.getAppMetrics>[number]

/** 某个进程的内存（MB）；进程已经没了时为 null */
function processMemory(
  find: (p: ProcessMetric) => boolean,
  metrics = app.getAppMetrics(),
): { workingSetMb: number; privateMb?: number } | null {
  const memory = metrics.find(find)?.memory
  if (!memory) return null
  return {
    workingSetMb: mb(memory.workingSetSize),
    ...(memory.privateBytes !== undefined ? { privateMb: mb(memory.privateBytes) } : {}),
  }
}

/** 调用栈只留前几行；拿不到时为 null */
export function trimStack(stack: string | void): string | null {
  const text = stack?.trim()
  return text ? text.split('\n').slice(0, STACK_LINES).join('\n') : null
}

async function callStack(win: BrowserWindow): Promise<string | null> {
  try {
    const stack = await Promise.race([
      win.webContents.mainFrame.collectJavaScriptCallStack(),
      new Promise<void>(resolve => setTimeout(resolve, STACK_TIMEOUT_MS).unref()),
    ])
    return trimStack(stack)
  } catch {
    return null
  }
}

interface WindowTimes {
  focus?: number
  blur?: number
  restore?: number
  show?: number
}
/** watchWindow 记的各窗口上次切回、切走、还原的时刻；「画面停止刷新」也要用 */
const windowTimes = new WeakMap<BrowserWindow, WindowTimes>()

/** 离上次切回、切走、还原（没最小化过就是显示）窗口多久；没发生过为 null */
function sinceSwitch(at: WindowTimes, now: number): Record<string, number | null> {
  const ago = (t: number | undefined): number | null => (t === undefined ? null : now - t)
  return { sinceFocusMs: ago(at.focus), sinceBlurMs: ago(at.blur), sinceRestoreMs: ago(at.restore ?? at.show) }
}

/** 窗口没响应、恢复响应时记日志；带上离上次切回窗口多久、页面进程的内存和正在跑的 JS 调用栈 */
export function watchWindow(win: BrowserWindow): void {
  const at: WindowTimes = {}
  windowTimes.set(win, at)
  win.on('focus', () => (at.focus = Date.now()))
  win.on('blur', () => (at.blur = Date.now()))
  win.on('restore', () => (at.restore = Date.now()))
  win.on('show', () => (at.show = Date.now()))
  let since: number | null = null
  let repeat: NodeJS.Timeout | null = null
  const stop = (): void => {
    if (repeat) clearInterval(repeat)
    repeat = null
    since = null
  }

  const report = async (message: string): Promise<void> => {
    if (since === null || win.isDestroyed()) return
    const started = since
    const stack = await callStack(win)
    if (since !== started || win.isDestroyed()) return
    const now = Date.now()
    log.warn(message, {
      window: win.id,
      // 从 Chromium 判定没响应算起（它要等输入十几秒没有回应才判定，实际卡住比这更久）
      unresponsiveMs: now - started,
      focused: win.isFocused(),
      minimized: win.isMinimized(),
      visible: win.isVisible(),
      ...sinceSwitch(at, now),
      memory: processMemory(p => p.pid === win.webContents.getOSProcessId()),
      ...(stack ? { stack } : {}),
    })
    logService()?.flushSync()
  }

  win.on('unresponsive', () => {
    if (since !== null) return
    since = Date.now()
    void report('窗口没有响应')
    let count = 0
    repeat = setInterval(() => {
      if (++count >= MAX_REPEATS && repeat) clearInterval(repeat)
      void report('窗口仍然没有响应')
    }, REPEAT_MS)
    repeat.unref()
  })
  win.on('responsive', () => {
    if (since === null) return
    log.info('窗口恢复响应', { window: win.id, unresponsiveMs: Date.now() - since })
    stop()
  })
  win.on('closed', stop)
}

/** 页面每分钟最多报这么多条画面停止 / 恢复刷新 */
const FRAMES_PER_MINUTE = 10

/** 页面报来的画面停止 / 恢复刷新：不信任，数字取有限非负值取整，布尔只认 true；state 不对为 null */
export function parseFrameReport(raw: unknown): { stalled: boolean; fields: Record<string, unknown> } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.state !== 'stalled' && r.state !== 'recovered') return null
  const fields: Record<string, unknown> = {}
  for (const key of ['stalledMs', 'sinceInputMs', 'sinceVisibleMs', 'elements', 'heapMb']) {
    const v = r[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) fields[key] = Math.round(v)
  }
  if (r.inactiveDuring === true) fields.inactiveDuring = true
  return { stalled: r.state === 'stalled', fields }
}

/**
 * 画面停止 / 恢复刷新（log:frames）：页面量的数补上窗口状态、界面进程和 GPU 进程的内存、整机内存再写；
 * 停住那条马上同步写盘（屏幕不动了，用户多半直接关掉）
 */
export function watchFrames(): void {
  const budget = new WeakMap<WebContents, { minute: number; count: number }>()
  ipc.on('log:frames', (event, raw: unknown) => {
    const report = parseFrameReport(raw)
    if (!report) return
    const minute = Math.floor(Date.now() / 60_000)
    const used = budget.get(event.sender)
    if (used?.minute === minute && used.count >= FRAMES_PER_MINUTE) return
    budget.set(event.sender, { minute, count: used?.minute === minute ? used.count + 1 : 1 })
    const win = BrowserWindow.fromWebContents(event.sender)
    const metrics = app.getAppMetrics()
    const pid = event.sender.getOSProcessId()
    const times = win ? windowTimes.get(win) : undefined
    const fields = {
      ...report.fields,
      window: event.sender.id,
      ...(win ? { focused: win.isFocused(), visible: win.isVisible(), minimized: win.isMinimized() } : {}),
      ...(times ? sinceSwitch(times, Date.now()) : {}),
      renderer: processMemory(p => p.pid === pid, metrics),
      gpu: processMemory(p => p.type === 'GPU', metrics),
      system: systemNow(),
      ...(gpus ? { gpus } : {}),
      // 只读主进程缓存的状态，不经过 GPU 进程（它可能正卡着）
      compositing: app.getGPUFeatureStatus().gpu_compositing,
    }
    if (!report.stalled) return log.info('画面恢复刷新', fields)
    log.warn('画面停止刷新', fields)
    logService()?.flushSync()
  })
}

/** Windows 自带的软件渲染器（Microsoft Basic Render Driver）的厂商号 */
const MICROSOFT_VENDOR = 0x1414
/** 启动后多久记显卡信息：GPU 进程起来之前 getGPUFeatureStatus 全是「软件」 */
const GPU_INFO_DELAY_MS = 10_000

/** getGPUInfo('basic') 里用到的部分 */
export interface GpuDevice {
  vendorId?: number
  deviceString?: string
  driverVersion?: string
}

/** 启动时查到的显卡（gpuList），「画面停止刷新」带上；还没查到为 null */
let gpus: string[] | null = null

/** 每块显卡「型号 · 驱动版本」：同一块会列好几次，合并；有别的显卡时不列 Windows 自带的软件渲染器 */
export function gpuList(devices: readonly GpuDevice[]): string[] {
  const real = devices.filter(d => d.vendorId !== MICROSOFT_VENDOR)
  const names = (real.length ? real : devices).map(d =>
    [d.deviceString || `vendor ${d.vendorId ?? '?'}`, d.driverVersion].filter(Boolean).join(' · '),
  )
  return [...new Set(names)]
}

/** 启动后 10 秒记一次显卡、驱动版本和硬件加速开没开（docs/ui/logging.md §4.9） */
export function logGpuInfo(delayMs = GPU_INFO_DELAY_MS): void {
  setTimeout(() => {
    app.getGPUInfo('basic').then(
      raw => {
        const info = raw as { gpuDevice?: GpuDevice[]; auxAttributes?: Record<string, unknown> }
        gpus = gpuList(info.gpuDevice ?? [])
        const status = app.getGPUFeatureStatus()
        log.info('显卡信息', {
          gpus,
          compositing: status.gpu_compositing,
          raster: status.rasterization,
          ...(info.auxAttributes?.optimus === true ? { optimus: true } : {}),
          ...(info.auxAttributes?.amdSwitchable === true ? { amdSwitchable: true } : {}),
        })
      },
      (err: unknown) => log.warn('读不到显卡信息', { error: err instanceof Error ? err.message : String(err) }),
    )
  }, delayMs).unref()
}

/** 显示器的日志字段 */
export function displayFields(
  d: Pick<Display, 'id' | 'size' | 'scaleFactor' | 'rotation'>,
  displays: number,
): Record<string, unknown> {
  return {
    id: d.id,
    size: `${d.size.width}x${d.size.height}`,
    scale: d.scaleFactor,
    ...(d.rotation ? { rotation: d.rotation } : {}),
    displays,
  }
}

/** 显示器变化每分钟最多记这么多条（驱动出问题时可能来回跳） */
const DISPLAY_PER_MINUTE = 20

/** 锁屏 / 解锁、显示器接上 / 拔掉 / 分辨率缩放旋转变了各记一条：GPU 卡住常常紧跟在这些之后 */
export function watchDisplays(): void {
  powerMonitor.on('lock-screen', () => log.info('锁屏'))
  powerMonitor.on('unlock-screen', () => log.info('解锁'))
  let minute = -1
  let count = 0
  const note = (message: string, d: Display, extra: Record<string, unknown> = {}): void => {
    const now = Math.floor(Date.now() / 60_000)
    if (now !== minute) {
      minute = now
      count = 0
    }
    if (++count > DISPLAY_PER_MINUTE) return
    log.info(message, { ...displayFields(d, screen.getAllDisplays().length), ...extra })
  }
  screen.on('display-added', (_event, d) => note('接上显示器', d))
  screen.on('display-removed', (_event, d) => note('拔掉显示器', d))
  screen.on('display-metrics-changed', (_event, d, changed) => {
    // 只是任务栏让出的工作区变了不记
    const real = changed.filter(c => c !== 'workArea')
    if (real.length) note('显示器设置变化', d, { changed: real })
  })
}

/** 计时器晚到多少毫秒算主进程卡住；刚睡眠唤醒的不算 */
export function mainLag(lateMs: number, sleeping: boolean): number | null {
  return !sleeping && lateMs >= LAG_MS ? Math.round(lateMs) : null
}

/** 引擎运行时的计数（HostEngine.memoryStats 的形状）；卡住时顺带记下，看是不是会话 / 运行时堆多了 */
export interface EngineCounts {
  runtimes: number
  processes: number
  running: number
}

/** 「主进程卡住」那条日志的字段：卡了多久、那会儿没处理完的请求、卡住前后 5 秒内刚处理完的请求（含回复的粗略大小）、引擎运行时数量 */
export function stallFields(lagMs: number, engine?: () => EngineCounts | null | undefined): Record<string, unknown> {
  let counts: EngineCounts | null | undefined
  try {
    counts = engine?.()
  } catch {
    counts = null
  }
  return { lagMs, ipc: ipc.ipcInFlight(), recent: ipc.ipcRecent(lagMs), ...(counts ? { engine: counts } : {}) }
}

/**
 * 主进程卡住（计时器晚到 2 秒以上）时记一条，带上那会儿还没处理完的 IPC 请求、最近 5 秒内处理完的请求和引擎运行时数量。
 * 日志是卡住结束后才写的，所以「刚处理完」里常常就有罪魁（回复序列化发生在处理函数返回之后，不算在处理耗时里）。
 */
export function watchMainLoop(engine?: () => EngineCounts | null | undefined): void {
  let expected = performance.now() + TICK_MS
  // 睡眠期间计时器也停着，醒来第一跳会晚很久：从睡下到醒来后几秒内都不算
  let sleeping = false
  let wokeAt = -Infinity
  powerMonitor.on('suspend', () => (sleeping = true))
  powerMonitor.on('resume', () => {
    sleeping = false
    wokeAt = performance.now()
  })
  setInterval(() => {
    const now = performance.now()
    const lag = mainLag(now - expected, sleeping || now - wokeAt < TICK_MS * 5)
    expected = now + TICK_MS
    if (lag !== null) log.warn('主进程卡住', stallFields(lag, engine))
  }, TICK_MS).unref()
}

/** 内存到了第几档：0 是没到 1.5 GB，1 是 1.5 GB 起，之后每 512 MB 一档 */
export function memoryLevel(workingSetMb: number): number {
  return workingSetMb < MEMORY_WARN_MB ? 0 : Math.floor((workingSetMb - MEMORY_WARN_MB) / MEMORY_STEP_MB) + 1
}

/** 各进程内存涨到新的一档就记一条；返回的函数每次喂一份 getAppMetrics() 的结果 */
export function memoryChecker(): (metrics: ReturnType<typeof app.getAppMetrics>) => void {
  const logged = new Map<number, number>()
  return metrics => {
    const alive = new Set<number>()
    for (const p of metrics) {
      alive.add(p.pid)
      const workingSetMb = mb(p.memory.workingSetSize)
      const level = memoryLevel(workingSetMb)
      const before = logged.get(p.pid) ?? 0
      if (level > before) {
        logged.set(p.pid, level)
        log.warn('内存占用高', {
          type: p.type,
          ...(p.name ? { name: p.name } : {}),
          ...(p.serviceName ? { serviceName: p.serviceName } : {}),
          pid: p.pid,
          workingSetMb,
          ...(p.memory.privateBytes !== undefined ? { privateMb: mb(p.memory.privateBytes) } : {}),
        })
      } else if (workingSetMb < MEMORY_WARN_MB - MEMORY_STEP_MB) logged.delete(p.pid)
    }
    for (const pid of logged.keys()) if (!alive.has(pid)) logged.delete(pid)
  }
}

/** 每分钟取一次各进程的内存交给 onTick；不传就只做「内存占用高」的分档（app/memory.ts 的 memoryTick 在里面也做这件事） */
export function watchMemory(onTick: (metrics: ReturnType<typeof app.getAppMetrics>) => void = memoryChecker()): void {
  setInterval(() => onTick(app.getAppMetrics()), MEMORY_EVERY_MS).unref()
}

export interface RemoteMemorySample {
  id: string
  rssMb: number
  processes: number
}

/** WSL 机器里的进程内存分档（和本机进程同一套阈值）；samples 没带的机器按断开清档，stats 失败但仍连着的放进 connected 保留档位 */
export function remoteMemoryChecker(
  writer: Pick<typeof log, 'warn'> = log,
): (samples: RemoteMemorySample[], connected?: string[]) => void {
  const logged = new Map<string, number>()
  return (samples, connected = []) => {
    const alive = new Set([...connected, ...samples.map(s => s.id)])
    for (const { id, rssMb, processes } of samples) {
      const level = memoryLevel(rssMb)
      const before = logged.get(id) ?? 0
      if (level > before) {
        logged.set(id, level)
        writer.warn('WSL 内存占用高', { machine: id, rssMb, processes })
      } else if (rssMb < MEMORY_WARN_MB - MEMORY_STEP_MB) logged.delete(id)
    }
    for (const id of logged.keys()) if (!alive.has(id)) logged.delete(id)
  }
}

const REMOTE_STATS_TIMEOUT_MS = 5_000

interface MachineStats {
  state(): { machines: { id: string; kind?: string; status: string }[] }
  stats(id: string): Promise<{ rssMb: number; processes: number } | null>
}

/** 每分钟问已连接的 WSL 机器（SSH 不占本机内存，不问）；上一轮没回来就跳过，单次最多等 5 秒 */
export function watchRemoteMemory(getMachines: () => MachineStats | null | undefined, every = MEMORY_EVERY_MS): void {
  const check = remoteMemoryChecker()
  let busy = false
  setInterval(() => {
    const machines = getMachines()
    if (!machines || busy) return
    const ids = machines
      .state()
      .machines.filter(m => m.kind === 'wsl' && m.status === 'connected')
      .map(m => m.id)
    busy = true
    void (async () => {
      const samples: RemoteMemorySample[] = []
      const connected: string[] = []
      await Promise.all(
        ids.map(async id => {
          let timer: NodeJS.Timeout | undefined
          try {
            const stats = await Promise.race([
              machines.stats(id),
              new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), REMOTE_STATS_TIMEOUT_MS))),
            ])
            if (stats) samples.push({ id, ...stats })
            else connected.push(id)
          } catch {
            connected.push(id)
          } finally {
            clearTimeout(timer)
          }
        }),
      )
      check(samples, connected)
    })().finally(() => (busy = false))
  }, every).unref()
}
