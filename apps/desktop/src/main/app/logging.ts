// 本机日志（docs/ui/logging.md）：启动时装上日志服务，接管 console、记录崩溃，退出时写完
import { readFile, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { app, BrowserWindow, dialog, shell, type WebContents } from 'electron'
import { localRoot } from './data-dir'
import { logTime, type LogQuery } from '@pixelsky/protocol'
import { describeError, logger, redact, setLogSink, type LogLevel } from '@pixelsky/engine'
import { LogService } from '../core/log/service'
import * as ipc from '../ipc/guard'
import type { AppContext } from './context'
import { appInfo } from './info'
import { crashFields, onRendererSample, systemNow } from './memory'
import { sendTo } from './rendererHealth'
import { recoveryStep } from './crashRecovery'

let service: LogService | null = null

export function logService(): LogService | null {
  return service
}

function logsDir(): string {
  try {
    // 日志删了能重建：放 Local（docs/ui/data-location.md §3.2）
    app.setAppLogsPath(join(localRoot(), 'logs'))
    return app.getPath('logs')
  } catch {
    return join(localRoot(), 'logs')
  }
}

/** 主进程原有的 console.* 同时写进日志（scope console），原来的输出不变 */
function captureConsole(): void {
  const log = logger('console')
  const levels: [keyof Console & ('log' | 'info' | 'warn' | 'error' | 'debug'), LogLevel][] = [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['debug', 'debug'],
  ]
  for (const [method, level] of levels) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      original(...args)
      if (log.enabled(level)) log[level](format(...args))
    }
  }
}

function captureCrashes(svc: LogService): void {
  const log = logger('crash')
  // Monitor 只旁听，不改变原来的崩溃处理；进程可能马上退出，所以同步写完
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    log.error('未捕获的异常', { origin, error })
    svc.flushSync()
  })
  process.on('unhandledRejection', reason => {
    log.error('未处理的 Promise 拒绝', { error: reason instanceof Error ? reason : describeError(reason) })
    process.stderr.write(`Unhandled rejection: ${format(reason)}\n`)
  })
  const crashTimes = new WeakMap<WebContents, number[]>()
  app.on('render-process-gone', (_event, contents, details) => {
    if (details.reason === 'clean-exit') return
    // 主窗口的界面进程：带上崩溃前最近的内存采样和这一刻的整机内存（docs/ui/renderer-memory.md §3.2.5）；内置浏览器的页面不带
    const isWindow = BrowserWindow.fromWebContents(contents) !== null
    let extra: Record<string, unknown> = {}
    if (isWindow) {
      const step = recoveryStep(crashTimes.get(contents) ?? [], Date.now())
      crashTimes.set(contents, step.times)
      extra = { ...crashFields(contents), recoveries: step.n }
    }
    log.error('渲染进程退出', { reason: details.reason, exitCode: details.exitCode, url: contents.getURL(), ...extra })
    // 崩溃后用户可能直接关掉程序
    if (isWindow) svc.flushSync()
  })
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    log.error('子进程退出', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      ...(details.serviceName ? { serviceName: details.serviceName } : {}),
      ...(details.name ? { name: details.name } : {}),
      ...(details.type === 'GPU' ? { system: systemNow() } : {}),
    })
  })
}

const EXPORT_DAYS = 3
/** 渲染进程报错：每个窗口每分钟最多记这么多条 */
const RENDERER_PER_MINUTE = 30

function parseQuery(raw: unknown): LogQuery {
  const q = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown, max = 200): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const level = q.minLevel
  return {
    ...(level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? { minLevel: level } : {}),
    ...(str(q.scope, 80) ? { scope: str(q.scope, 80) } : {}),
    ...(str(q.text) ? { text: str(q.text) } : {}),
    ...(str(q.sessionId, 120) ? { sessionId: str(q.sessionId, 120) } : {}),
    ...(num(q.since) !== undefined ? { since: num(q.since) } : {}),
    ...(num(q.until) !== undefined ? { until: num(q.until) } : {}),
    ...(num(q.limit) !== undefined ? { limit: num(q.limit) } : {}),
  }
}

/** 诊断文件：开头是「关于」页的版本和运行环境，后面是最近几天的日志，写出前逐行再脱敏一遍 */
async function exportDiagnostics(svc: LogService, path: string): Promise<void> {
  await svc.flush()
  const since = logTime(Date.now() - (EXPORT_DAYS - 1) * 86_400_000).slice(0, 10)
  const info = appInfo()
  const header = [
    `# ${info.name} 诊断信息 · ${logTime(Date.now())}`,
    `# 版本 ${info.version}（${info.channel}） · Electron ${info.electron} · Node ${info.node} · ${info.os} ${info.arch}`,
    `# 日志：最近 ${EXPORT_DAYS} 天`,
    '',
  ].join('\n')
  const parts: string[] = [header]
  for (const file of svc.files.list()) {
    if (file.day < since) continue
    try {
      const text = await readFile(file.path, 'utf8')
      parts.push(`# ${file.name}\n` + text.split('\n').map(redact).join('\n'))
    } catch {
      parts.push(`# ${file.name}（读取失败）\n`)
    }
  }
  await writeFile(path, parts.join('\n'), 'utf8')
}

/** 设置 › 日志用的 IPC（§4.7）；在 app ready 之后调用 */
export function initLogIpc(): void {
  const svc = service
  if (!svc) return
  const log = logger('app')
  /** 在看实时日志的页面 → 取消它身上的监听 */
  const watchers = new Map<WebContents, () => void>()
  svc.subscribe(entry => {
    for (const contents of watchers.keys()) sendTo(contents, 'log:entry', entry)
  })
  const unwatch = (contents: WebContents): void => {
    watchers.get(contents)?.()
    watchers.delete(contents)
  }
  ipc.handle('log:read', (_event, query: unknown) => svc.read(parseQuery(query)))
  ipc.handle('log:watch', (event, on: unknown) => {
    const contents = event.sender
    if (on !== true) {
      unwatch(contents)
      return
    }
    if (watchers.has(contents)) return
    // 页面重新加载（导航）或界面崩溃后，页面里已经没有监听：删掉，要看日志的页面会重新 log:watch
    const onNavigate = (_event: unknown, _url: string, _inPlace: boolean, isMain: boolean): void => {
      if (isMain) unwatch(contents)
    }
    const drop = (): void => unwatch(contents)
    contents.on('did-start-navigation', onNavigate)
    contents.on('render-process-gone', drop)
    contents.on('destroyed', drop)
    watchers.set(contents, () => {
      if (contents.isDestroyed()) return
      contents.removeListener('did-start-navigation', onNavigate)
      contents.removeListener('render-process-gone', drop)
      contents.removeListener('destroyed', drop)
    })
  })
  // 内存采样（docs/ui/renderer-memory.md §3.2.2）：界面报来的数，回复下一次采样的间隔；不占 log:write 的限额
  ipc.handle('log:sample', (event, raw: unknown) => onRendererSample(event.sender, raw))
  ipc.handle('log:settings', () => svc.settings())
  ipc.handle('log:setVerbose', (_event, on: unknown) => {
    const next = svc.setVerbose(on === true)
    log.info(on === true ? '详细日志已打开' : '详细日志已关闭', { until: next.verboseUntil })
    return next
  })
  ipc.handle('log:open', async () => {
    const err = await shell.openPath(svc.files.dir)
    if (err) throw new Error(`打不开日志文件夹：${err}`)
  })
  ipc.handle('log:export', async event => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const stamp = logTime(Date.now()).slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
    const options = {
      title: '导出诊断文件',
      defaultPath: join(app.getPath('downloads'), `pixelsky-diagnostics-${stamp}.log`),
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
    }
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return null
    await exportDiagnostics(svc, filePath)
    log.info('导出诊断文件', { path: filePath })
    return filePath
  })
  // 渲染进程报错（§4.5「renderer」）：限流，只收 warn / error
  const rendererLog = logger('renderer')
  // 按窗口记：WeakMap 跟着窗口释放，开关很多次窗口也不会越积越多
  const budget = new WeakMap<WebContents, { minute: number; count: number }>()
  ipc.on('log:write', (event, raw: unknown) => {
    const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const level = e.level === 'warn' || e.level === 'info' ? e.level : 'error'
    const message = typeof e.message === 'string' ? e.message.slice(0, 2000) : ''
    if (!message) return
    const minute = Math.floor(Date.now() / 60_000)
    const used = budget.get(event.sender)
    if (used?.minute === minute && used.count >= RENDERER_PER_MINUTE) return
    budget.set(event.sender, { minute, count: used?.minute === minute ? used.count + 1 : 1 })
    const fields = e.fields && typeof e.fields === 'object' && !Array.isArray(e.fields) ? e.fields : {}
    rendererLog[level](message, { ...(fields as Record<string, unknown>), window: event.sender.id })
  })
}

/** 越早越好：在其他模块初始化之前调用 */
export function initLogging(ctx: AppContext): void {
  const svc = (service = new LogService({ dir: logsDir() }))
  setLogSink(svc)
  captureConsole()
  captureCrashes(svc)
  const log = logger('app')
  log.info('应用启动', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron,
    os: `${process.platform} ${release()}`,
    arch: process.arch,
    pid: process.pid,
  })
  ctx.lifecycle.onShutdown(() => {
    log.info('应用退出')
    return svc.flush()
  })
}
