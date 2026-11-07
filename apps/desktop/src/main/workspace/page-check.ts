// 「做完自动检查」的页面检查（docs/ui/desktop-parity.md）：在后台打开本机页面，收控制台错误和失败的请求，截一张图。
// 离屏视图挂在不显示的 BaseWindow 上：不挂窗口截不到图，隐藏的 BrowserWindow 又会进 getAllWindows、收广播；独立的内存会话，不带用户的登录状态
import { BaseWindow, WebContentsView, session, type Session } from 'electron'
import { pageCheckUrl, type CheckPageResult } from '../../shared/types/checks'
import { redact } from '../core/project-tools/services'

const PARTITION = 'pixelsky-page-check'
const LOAD_TIMEOUT_MS = 20_000
/** 加载完再等一会儿：单页应用的错误常在首屏之后才出来 */
const SETTLE_MS = 1500
const SHOT_TIMEOUT_MS = 3000
const LINES_MAX = 10
const LINE_CHARS = 400
const SHOT_WIDTH = 640
const VIEW = { width: 1280, height: 800 }
/** 连不上：开发服务多半没开，不算项目的问题（ERR_CONNECTION_REFUSED / FAILED / RESET / ADDRESS_UNREACHABLE / TIMED_OUT、EMPTY_RESPONSE） */
const UNREACHABLE = new Set([-102, -104, -101, -109, -118, -324])
/** 控制台里的这句和失败的请求是同一件事，只记请求 */
const NETWORK_NOISE = /^Failed to load resource/

const clean = (text: string): string => redact(text, []).slice(0, LINE_CHARS)

let configured: Session | null = null
function checkSession(): Session {
  const ses = session.fromPartition(PARTITION)
  if (configured === ses) return ses
  configured = ses
  ses.setPermissionRequestHandler((_c, _p, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event, item) => {
    event.preventDefault()
    item.cancel()
  })
  return ses
}

async function open(url: string): Promise<CheckPageResult> {
  const started = Date.now()
  const ses = checkSession()
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      // 页面弹 alert 没人点，会一直卡到超时
      disableDialogs: true,
    },
  })
  view.setBounds({ x: 0, y: 0, ...VIEW })
  const host = new BaseWindow({ show: false, ...VIEW })
  host.contentView.addChildView(view)
  const wc = view.webContents
  wc.setAudioMuted(true)
  const errors: string[] = []
  const requests: string[] = []
  const add = (list: string[], line: string): void => {
    if (list.length < LINES_MAX) list.push(clean(line))
  }
  let reason: CheckPageResult['reason']
  let detail: string | undefined
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  // 只留在这台电脑上：跳到外面的地址不跟
  const stay = (event: Electron.Event, target: string): void => {
    if (!pageCheckUrl(target)) event.preventDefault()
  }
  wc.on('will-navigate', stay)
  wc.on('will-redirect', stay)
  wc.on('console-message', details => {
    if (details.level !== 'error' || NETWORK_NOISE.test(details.message)) return
    add(errors, details.message + (details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : ''))
  })
  wc.on('render-process-gone', (_e, gone) => {
    reason = 'error'
    detail = gone.reason
  })
  const all = { urls: ['<all_urls>'] }
  ses.webRequest.onCompleted(all, d => {
    if (d.webContentsId !== wc.id || d.statusCode < 400) return
    if (d.resourceType === 'mainFrame') {
      reason = 'http'
      detail = String(d.statusCode)
    } else if (!/\/favicon\.ico(\?|$)/.test(d.url)) add(requests, `${d.statusCode} ${d.url}`)
  })
  ses.webRequest.onErrorOccurred(all, d => {
    if (d.webContentsId !== wc.id || d.resourceType === 'mainFrame' || d.error === 'net::ERR_ABORTED') return
    add(requests, `${d.error} ${d.url}`)
  })
  let skipped = false
  let shot: string | null = null
  try {
    const loaded = wc.loadURL(url).then(
      () => 'loaded' as const,
      (error: { errno?: number; code?: string; message?: string }) => {
        if (UNREACHABLE.has(error.errno ?? 0)) skipped = true
        else if (!reason) {
          reason = 'error'
          detail = error.code ?? error.message
        }
        return 'failed' as const
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      loaded,
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), LOAD_TIMEOUT_MS)
      }),
    ])
    clearTimeout(timer)
    if (outcome === 'timeout') reason = 'timeout'
    if (!skipped) {
      if (outcome === 'loaded') await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
      // 页面一帧都没画出来时（超时、空响应）capturePage 不会返回
      const image = await Promise.race([
        wc.capturePage(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), SHOT_TIMEOUT_MS)),
      ]).catch(() => null)
      if (image && !image.isEmpty())
        shot = `data:image/jpeg;base64,${image.resize({ width: SHOT_WIDTH }).toJPEG(60).toString('base64')}`
    }
  } finally {
    ses.webRequest.onCompleted(null)
    ses.webRequest.onErrorOccurred(null)
    if (!wc.isDestroyed()) wc.close()
    host.destroy()
    await ses.clearStorageData().catch(() => {})
  }
  const ms = Date.now() - started
  if (skipped)
    return { kind: 'page', url, status: 'skipped', ms, errors: [], requests: [], reason: 'unreachable', shot }
  const status = reason || errors.length || requests.length ? 'fail' : 'pass'
  return { kind: 'page', url, status, ms, errors, requests, ...(reason ? { reason, detail } : {}), shot }
}

/** 同时只开一个页面：请求监听挂在共用的会话上；出错不影响前面命令检查的结果 */
let queue: Promise<unknown> = Promise.resolve()
export function probePage(url: string): Promise<CheckPageResult> {
  const job = queue.then(() =>
    open(url).catch(
      (error: Error): CheckPageResult => ({
        kind: 'page',
        url,
        status: 'fail',
        ms: 0,
        errors: [],
        requests: [],
        reason: 'error',
        detail: clean(error.message),
        shot: null,
      }),
    ),
  )
  queue = job
  return job
}
