// 脚本扩展的宿主（docs/ui/extension-commands-plan.md §2、§3）：不挂到窗口的 WebContentsView + 独立内存分区 + 每扩展一个来源。
// 不用隐藏 BrowserWindow：它会进 getAllWindows，退出时被显示、关窗不退出、还会收到广播。有命令在跑时才存在
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app, MessageChannelMain, session, WebContentsView, type Session } from 'electron'
import type { ScriptConnection, ScriptPort, ScriptRunTarget } from './runner'
import {
  EXT_HOST_SCHEME,
  FRAME_CSP,
  FRAME_HTML,
  FRAME_JS,
  HOST_CSP,
  HOST_HTML,
  HOST_JS,
  userScript,
  WORKER_CSP,
  WORKER_JS,
} from './source'

/** 必须在 app ready 之前登记（index.ts 的 registerSchemesAsPrivileged） */
export const EXT_HOST_SCHEME_PRIVILEGES: Electron.CustomScheme = {
  scheme: EXT_HOST_SCHEME,
  privileges: { standard: true, secure: true },
}

const MEMORY_LIMIT_MB = 512
/** 实测分配能到 10 GB/秒，5 秒看一次等于没看（§8.1）；只在宿主存在时才看 */
const MEMORY_POLL_MS = 100
const HOST_NAME = 'host'

const respond = (body: string, type: string, csp: string): Response =>
  new Response(body, {
    headers: { 'content-type': type, 'content-security-policy': csp, 'x-content-type-options': 'nosniff' },
  })

interface Run {
  runId: string
  host: string
  onMemoryLimit: () => void
}

export class ScriptHost {
  private view: WebContentsView | null = null
  private loading: Promise<WebContentsView> | null = null
  private ses: Session | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private seq = 0
  private readonly runs = new Map<string, Run>()
  /** 每个来源当前的脚本：协议只认这里有的，运行结束就删 */
  private readonly scripts = new Map<string, string>()

  private session(): Session {
    if (this.ses) return this.ses
    const ses = session.fromPartition('ext-host')
    ses.protocol.handle(EXT_HOST_SCHEME, req => this.serve(req))
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${EXT_HOST_SCHEME}:`) }))
    ses.setPermissionRequestHandler((_w, _p, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    ses.on('will-download', e => e.preventDefault())
    return (this.ses = ses)
  }

  private serve(req: Request): Response {
    const url = new URL(req.url)
    if (url.hostname === HOST_NAME) {
      if (url.pathname === '/host.html') return respond(HOST_HTML, 'text/html', HOST_CSP)
      if (url.pathname === '/host.js') return respond(HOST_JS, 'text/javascript', HOST_CSP)
      return new Response(null, { status: 404 })
    }
    const code = this.scripts.get(url.hostname)
    if (code === undefined) return new Response(null, { status: 404 })
    if (url.pathname === '/frame.html') return respond(FRAME_HTML, 'text/html', FRAME_CSP)
    if (url.pathname === '/frame.js') return respond(FRAME_JS, 'text/javascript', FRAME_CSP)
    if (url.pathname === '/worker.js') return respond(WORKER_JS, 'text/javascript', WORKER_CSP)
    if (url.pathname === '/user.js') return respond(userScript(code), 'text/javascript', WORKER_CSP)
    return new Response(null, { status: 404 })
  }

  private ensureView(): Promise<WebContentsView> {
    if (this.loading) return this.loading
    const view = new WebContentsView({
      webPreferences: {
        session: this.session(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        devTools: !app.isPackaged,
        preload: join(__dirname, '../preload/ext-host.js'),
      },
    })
    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', e => e.preventDefault())
    this.view = view
    this.loading = contents.loadURL(`${EXT_HOST_SCHEME}://${HOST_NAME}/host.html`).then(() => view)
    this.poll = setInterval(() => this.checkMemory(), MEMORY_POLL_MS)
    return this.loading
  }

  private closeView(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    const view = this.view
    this.view = null
    this.loading = null
    if (view && !view.webContents.isDestroyed()) view.webContents.close()
  }

  /** 超内存只杀那个扩展的进程：别的扩展不受影响，端口的 close 会结束它的运行 */
  private checkMemory(): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    const usage = new Map(app.getAppMetrics().map(m => [m.pid, m.memory.workingSetSize / 1024]))
    for (const frame of view.webContents.mainFrame.frames) {
      let host: string
      try {
        host = new URL(frame.url).hostname
      } catch {
        continue
      }
      const pid = frame.osProcessId
      if ((usage.get(pid) ?? 0) <= MEMORY_LIMIT_MB) continue
      for (const run of this.runs.values())
        if (run.host === host) {
          run.onMemoryLimit()
          try {
            process.kill(pid)
          } catch {
            // 进程已经没了
          }
        }
    }
  }

  async open(target: ScriptRunTarget, onMemoryLimit: () => void): Promise<ScriptConnection> {
    const runId = `r${++this.seq}`
    const host = createHash('sha256').update(target.id).digest('hex').slice(0, 32)
    this.scripts.set(host, target.code)
    this.runs.set(runId, { runId, host, onMemoryLimit })
    let view: WebContentsView
    try {
      view = await this.ensureView()
    } catch (e) {
      // 宿主没起来：不留运行记录，否则宿主永远关不掉，之后的命令都失败
      this.runs.delete(runId)
      this.scripts.delete(host)
      if (this.runs.size === 0) this.closeView()
      throw e
    }
    const { port1, port2 } = new MessageChannelMain()
    view.webContents.postMessage('extHost:control', { type: 'start', runId, host }, [port2])
    const stop = (): void => {
      if (!this.runs.delete(runId)) return
      this.scripts.delete(host)
      port1.close()
      if (this.runs.size === 0) this.closeView()
      else if (!view.webContents.isDestroyed()) view.webContents.postMessage('extHost:control', { type: 'stop', runId })
    }
    return { port: port1 as unknown as ScriptPort, stop }
  }
}
