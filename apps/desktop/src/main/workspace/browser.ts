import {
  BrowserWindow,
  WebContentsView,
  dialog,
  session,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import * as ipc from '../ipc/guard'
import { createHash, randomUUID } from 'node:crypto'
import { join, basename, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  browserShortcut,
  cleanPreview,
  deviceSize,
  fitDevice,
  type BrowserPage,
  type BrowserPreview,
  type BrowserState,
} from '../../shared/types/project-browser'
import type { WorkspaceRef } from '../../shared/types/workspace'
import { JsonStore, value, type ToolsHost } from '../core/project-tools/common'
import { workspaceRef } from '../core/workspace-files'
import { nativeText } from '../app/ui-language'
import type { AppContext } from '../app/context'
import { machineOf } from '../machines/identity'
import { browserRemoteUrl, browserTunnelUrl, remoteBrowserPort } from '../machines/browser-url'
import {
  PICK_WORLD_ID,
  SHOT_MAX_EDGE,
  clampRect,
  elementExtra,
  parsePickMessage,
  pickerScript,
  sanitizePickConfig,
  type PickMessage,
  type PickRect,
} from './elementPicker'
import {
  addIssue,
  consoleEntry,
  consoleIssue,
  failedRequest,
  pushEntry,
  type IssueEntry,
  type PageIssues,
} from './page-issues'
import {
  capturePage,
  clearSiteData,
  findOnce,
  isZoomMove,
  nextZoom,
  opensInside,
  reloadsPage,
  rememberZoom,
  toggleDevTools,
  zoomSiteOf,
  type ZoomMove,
} from './browser-tools'
import { pushRecent } from './browser-recent'
import { applyEmulation, emulatingDevice, staleEmulation } from './browser-emulation'
import { createTreeWatcher } from './tree-watch'
import { sendTo } from '../app/rendererHealth'

const ANNOTATION_LIMIT = 100
/** 每个工作区最多开这么多个网页标签 */
const PAGE_LIMIT = 12
/** 第二批的通道（docs/ui/browser-v2.md §3.2）：只对已经开着的网页，调用前不重新转发远端端口 */
const TOOL_CHANNELS = [
  'issues',
  'clearIssues',
  'find',
  'stopFind',
  'zoom',
  'devtools',
  'capture',
  'clearSiteData',
  'preview',
]
/** 网站图标最大字节数 */
const FAVICON_MAX = 32 * 1024
const sameOrigin = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

interface StoredScope {
  pages: BrowserPage[]
  activeId: string | null
  /** 最近打开过的地址（docs/ui/browser-v2.md §3.1） */
  recent?: string[]
  /** 设备尺寸、网页主题（docs/ui/browser-v2.md §3.3） */
  preview?: BrowserPreview
}
export function browserUrl(raw: unknown): string {
  const input = value(raw, 4000, true)
  // 只输端口号（5173、:5173、5173/settings）：本机这个端口（docs/ui/browser-v2.md §3.1）
  const port = /^:?(\d+)(\/.*)?$/.exec(input)
  if (port) {
    const n = Number(port[1])
    if (n < 1 || n > 65535) throw new Error('端口号要在 1–65535 之间')
    return new URL(port[2] ?? '/', `http://localhost:${n}`).href
  }
  const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(input)
    ? input
    : /^(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(input)
      ? 'http://' + input
      : /^[a-z][a-z\d+.-]*:/i.test(input)
        ? input
        : 'https://' + input
  const url = new URL(normalized)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('只支持 HTTP 或 HTTPS 地址')
  return url.href
}
/**
 * 网页标签能打开的地址：http / https；本机项目还能用 file:// 打开项目目录里面的文件（对话里点 HTML 路径直接看效果）。
 * root 是本机项目的根目录，远程机器、没有项目时为 null（只认 http / https）
 */
export function pageUrl(raw: unknown, root: string | null): string {
  const input = value(raw, 4000, true)
  if (!/^file:/i.test(input)) return browserUrl(input)
  const url = new URL(input)
  let file: string
  try {
    file = fileURLToPath(url)
  } catch {
    throw new Error('只支持 HTTP 或 HTTPS 地址')
  }
  const inside = root ? relative(root, file) : ''
  if (!root || !inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('只能打开项目目录里的文件')
  return url.href
}
/** 标签标题：网页没写标题时用主机名，本地文件用文件名 */
const pageTitle = (url: string): string => {
  const parsed = new URL(url)
  return parsed.protocol === 'file:' ? decodeURIComponent(basename(parsed.pathname)) : parsed.hostname
}
export async function initProjectBrowser(ctx: AppContext, dir: string, host: ToolsHost): Promise<void> {
  // zoom：按网站（主机名，和 Chromium 自己同步缩放的范围一致）记住的缩放，所有工作区共用
  const store = new JsonStore<{ scopes: Record<string, StoredScope>; zoom?: Record<string, number> }>(
    join(dir, 'browser.json'),
    { scopes: {} },
  )
  await store.init()
  for (const scope of Object.values(store.data.scopes))
    for (const p of scope.pages) {
      p.loading = false
      p.error = null
      p.canBack = false
      p.canForward = false
      p.picking = false
      p.annotations ??= []
      delete p.failed
      delete p.favicon
    }
  type View = {
    view: WebContentsView
    scope: string
    id: string
    owner: BrowserWindow
    /** 点选脚本回传消息的口令前缀（每个视图一个，只存在主进程和隔离 world 里） */
    channel: string
    /** 注入过点选脚本（关掉选取时要通知它） */
    injected: boolean
    /** 设备尺寸下网页缩小的比例（视图像素 / 网页 CSS 像素，不含网页缩放）；自适应时 1 */
    scale: number
  }
  const views = new Map<string, View>(),
    configured = new Set<string>()
  /** 每个窗口的网页区（窗口像素）和界面的缩放（设备框按界面的 CSS 像素算，见 fitDevice） */
  const bounds = new Map<number, { scope: string; rect: Electron.Rectangle; zoom: number }>()
  const scopeMachines = new Map<string, string>()
  /** 点选批注：界面最近一次传来的主题色和文案；页面里找不到元素的批注（页面标签 id → 批注 id，只在内存里） */
  let pickConfig = sanitizePickConfig(null)
  const missing = new Map<string, Set<string>>()
  /** 本机项目的根目录（file:// 只放行这里面的文件）；远程机器不记 */
  const scopeRoots = new Map<string, string>()
  /** 每个网页标签这一页的控制台错误和失败请求（运行胶囊用，docs/ui/panel-pill.md §8.1）；只在内存里，主框架跳转时清零 */
  const issues = new Map<string, PageIssues>()
  /** 控制台抽屉的明细（docs/ui/browser-v2.md §3.2）：抽屉打开时才取，不进广播；和 issues 一起清 */
  const entries = new Map<string, IssueEntry[]>()
  const issueTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 报错常一下来一串：每个工作区 500ms 最多广播一次 */
  const broadcastSoon = (scope: string): void => {
    if (issueTimers.has(scope)) return
    issueTimers.set(
      scope,
      setTimeout(() => {
        issueTimers.delete(scope)
        broadcast(scope)
      }, 500),
    )
  }
  /** 每个网页标签的网站图标（data URL）；取到的按图标地址缓存，同一个站换页不重新取（没取到的不记，下次再试） */
  const favicons = new Map<string, string>()
  const faviconCache = new Map<string, string>()
  const loadFavicon = async (ses: Electron.Session, url: string): Promise<string | null> => {
    const cached = faviconCache.get(url)
    if (cached) return cached
    let found: string | null = null
    if (url.startsWith('data:image/')) found = url.length <= FAVICON_MAX * 1.4 ? url : null
    else if (/^https?:/i.test(url))
      try {
        const res = await ses.fetch(url, { signal: AbortSignal.timeout(5000) })
        const type = res.headers.get('content-type') ?? ''
        // 写明了太大的不下载
        const big = Number(res.headers.get('content-length') ?? 0) > FAVICON_MAX
        const body = res.ok && !big && type.startsWith('image/') ? Buffer.from(await res.arrayBuffer()) : null
        if (body && body.length <= FAVICON_MAX) found = `data:${type.split(';')[0]};base64,${body.toString('base64')}`
      } catch {}
    if (!found) return null
    if (faviconCache.size >= 100) faviconCache.delete(faviconCache.keys().next().value!)
    faviconCache.set(url, found)
    return found
  }
  /** 记一条：错误和失败请求进计数和胶囊的最近几条（line 是胶囊里那行）；警告只记个数 */
  const noteIssue = (scope: string, id: string, entry: IssueEntry, line: string): void => {
    const prior = issues.get(id) ?? { errors: 0, requests: 0, last: [] }
    issues.set(
      id,
      entry.kind === 'warning'
        ? { ...prior, warnings: (prior.warnings ?? 0) + 1 }
        : addIssue(prior, entry.kind === 'error' ? 'errors' : 'requests', line),
    )
    entries.set(id, pushEntry(entries.get(id), entry))
    broadcastSoon(scope)
  }
  const forgetIssues = (id: string): boolean => {
    entries.delete(id)
    return issues.delete(id)
  }
  /**
   * 记缩放用的网站：http / https 的主机名（远端工作区换成原地址）。shown：网页实际的地址（wc.getURL()）——
   * 跳转加载中 p.url 还是上一页的，不传时才用记下的地址
   */
  const zoomSite = (p: BrowserPage, shown?: string): string | null => {
    try {
      return zoomSiteOf(
        shown === undefined
          ? (p.remoteUrl ?? p.url)
          : p.remoteUrl
            ? (browserRemoteUrl(shown, p.remoteUrl, p.url) ?? shown)
            : shown,
      )
    } catch {
      return null
    }
  }
  const zoomOf = (p: BrowserPage, shown?: string): number => {
    const site = zoomSite(p, shown)
    return (site && store.data.zoom?.[site]) || 1
  }
  const scopeOf = (ref: WorkspaceRef): string => {
    const target = host.resolve(ref)
    const machine = machineOf(target.projectId)
    const key = createHash('sha256')
      .update(
        target.projectId +
          ':' +
          (machine === 'local' && process.platform === 'win32' ? target.path.toLowerCase() : target.path),
      )
      .digest('hex')
    scopeMachines.set(key, machine)
    if (machine === 'local') scopeRoots.set(key, target.path)
    return key
  }
  const state = (scope: string): BrowserState => {
    const s = store.data.scopes[scope] ?? { pages: [], activeId: null }
    return {
      scope,
      pages: s.pages,
      activeId: s.activeId,
      ...(s.recent?.length ? { recent: s.recent } : {}),
      ...(s.preview ? { preview: s.preview } : {}),
    }
  }
  const broadcast = (scope: string): void => {
    ctx.events.broadcast('projectBrowser:changed', displayState(state(scope)))
  }
  const displayState = (value: BrowserState): BrowserState => ({
    ...value,
    pages: value.pages.map(page => {
      const gone = missing.get(page.id)
      const found = issues.get(page.id),
        icon = favicons.get(page.id),
        zoom = zoomOf(page)
      return {
        ...page,
        ...(found ? { issues: found } : {}),
        ...(icon ? { favicon: icon } : {}),
        ...(zoom !== 1 ? { zoom } : {}),
        url: page.remoteUrl ?? page.url,
        annotations: gone?.size
          ? page.annotations.map(a => (gone.has(a.id) ? { ...a, missing: true as const } : a))
          : page.annotations,
      }
    }),
  })
  const transport = async (scope: string, url: string): Promise<string> => {
    const machine = scopeMachines.get(scope) ?? 'local',
      port = remoteBrowserPort(url)
    if (machine === 'local' || port === null) return url
    return browserTunnelUrl(url, await ctx.machines!.connection(machine).forwardPort(port))
  }
  // 本地文件自动刷新（docs/ui/browser-v2.md §3.3）：文件树那套监听另开一个实例，变化停下 300ms 推一次
  const fileWatcher = createTreeWatcher({ quietMs: 300, maxWaitMs: 1000 })
  const fileWatches = new Map<string, () => void>()
  const filePages = (scope: string): View[] =>
    [...views.values()].filter(
      v => v.scope === scope && !v.view.webContents.isDestroyed() && v.view.webContents.getURL().startsWith('file:'),
    )
  /** 本机工作区有 file:// 网页时监听项目目录，网页相关文件变了就刷新这些网页；没有了就退订（Windows 上开着会占住目录） */
  const syncFileWatch = (scope: string): void => {
    const root = scopeRoots.get(scope),
      need = !!root && filePages(scope).length > 0,
      off = fileWatches.get(scope)
    if (need && !off)
      fileWatches.set(
        scope,
        fileWatcher.subscribe([{ path: root!, prefix: '' }], change => {
          if (!change.overflow && ![...change.added, ...change.changed].some(reloadsPage)) return
          for (const v of filePages(scope)) v.view.webContents.reload()
        }),
      )
    else if (!need && off) {
      off()
      fileWatches.delete(scope)
    }
  }
  const persist = (): void => {
    void store.transaction(() => {}).catch(() => {})
  }
  const hide = (owner: BrowserWindow): void => {
    for (const v of views.values()) if (v.owner === owner) v.view.setVisible(false)
  }
  const place = (v: View): void => {
    const b = bounds.get(v.owner.id),
      current = state(v.scope)
    const show = !!b && b.scope === v.scope && current.activeId === v.id && b.rect.width > 0 && b.rect.height > 0
    if (show && b) {
      // 选了设备（docs/ui/browser-v2.md §10）：视图只占设备框，按界面的 CSS 像素算缩小比例，再换回窗口像素
      const size = deviceSize(current.preview),
        z = b.zoom || 1
      const fit = size
        ? fitDevice({ x: b.rect.x / z, y: b.rect.y / z, width: b.rect.width / z, height: b.rect.height / z }, size)
        : null
      v.scale = fit ? fit.scale * z : 1
      v.view.setBounds(
        fit
          ? {
              x: Math.round(fit.x * z),
              y: Math.round(fit.y * z),
              width: Math.max(1, Math.round(fit.width * z)),
              height: Math.max(1, Math.round(fit.height * z)),
            }
          : b.rect,
      )
      void emulate(v, size)
    }
    v.view.setVisible(show)
  }
  /** 按工作区的设备、网页主题模拟；手机 / 平板标识变了重新加载（服务器按标识出页面） */
  const emulate = (v: View, size = deviceSize(state(v.scope).preview)): Promise<void> => {
    const wc = v.view.webContents,
      p = state(v.scope).pages.find(item => item.id === v.id)
    if (wc.isDestroyed() || !p) return Promise.resolve()
    return applyEmulation(wc, {
      size,
      scale: v.scale,
      theme: state(v.scope).preview?.theme ?? 'system',
      picking: !!p.picking,
    }).then(
      uaChanged => {
        if (uaChanged && !wc.isDestroyed() && wc.getURL() && !wc.isLoadingMainFrame()) wc.reload()
      },
      () => {},
    )
  }
  const markersOf = (p: BrowserPage) =>
    p.annotations.flatMap((a, i) =>
      a.selector && a.route ? [{ id: a.id, n: i + 1, route: a.route, selector: a.selector }] : [],
    )
  /** 把选取状态、编号标记交给网页里的脚本（没有要显示的、也没注入过就不碰网页） */
  const syncPicker = async (v: View): Promise<void> => {
    const wc = v.view.webContents,
      p = state(v.scope).pages.find(item => item.id === v.id)
    if (!p || wc.isDestroyed()) return
    const markers = markersOf(p)
    if (!p.picking && !markers.length && !v.injected) return
    const code = pickerScript({ config: pickConfig, channel: v.channel, picking: !!p.picking, markers })
    await wc.executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code }]).then(
      () => (v.injected = true),
      () => {},
    )
  }
  const refreshPicker = (scope: string, id: string): void => {
    for (const v of views.values()) if (v.scope === scope && v.id === id) void syncPicker(v)
  }
  /** 元素区域截图：夹在视图里，长边缩到 SHOT_MAX_EDGE，存成 JPEG */
  const captureShot = async (v: View, css: PickRect) => {
    // 网页里量的是 CSS 坐标，视图坐标要乘网页缩放和设备缩小比例
    const k = v.view.webContents.getZoomFactor() * v.scale,
      rect = { x: css.x * k, y: css.y * k, width: css.width * k, height: css.height * k }
    const size = v.view.getBounds(),
      r = clampRect(rect, size.width, size.height)
    const image = r ? await v.view.webContents.capturePage(r).catch(() => null) : null
    if (!image || image.isEmpty()) return null
    const { width, height } = image.getSize(),
      scale = Math.min(1, SHOT_MAX_EDGE / Math.max(width, height))
    const out =
      scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
          })
        : image
    const done = out.getSize()
    return {
      shot: `data:image/jpeg;base64,${out.toJPEG(70).toString('base64')}`,
      shotSize: { width: done.width, height: done.height },
    }
  }
  /** 网页里点选脚本回传的消息 */
  const onPick = async (v: View, msg: PickMessage | null): Promise<void> => {
    const page = state(v.scope).pages.find(item => item.id === v.id)
    if (!msg || !page) return
    if (msg.t === 'exit') {
      page.picking = false
      void emulate(v)
      broadcast(v.scope)
    } else if (msg.t === 'missing') {
      const prior = missing.get(page.id)
      if (prior?.size === msg.ids.length && msg.ids.every(id => prior.has(id))) return
      missing.set(page.id, new Set(msg.ids))
      broadcast(v.scope)
    } else {
      try {
        if (page.annotations.length >= ANNOTATION_LIMIT) throw new Error('批注数量已达到上限')
        const shot = msg.rect && !msg.extra.off?.includes('shot') ? await captureShot(v, msg.rect) : null
        const extra = elementExtra({ ...msg.extra, ...shot })
        await store.transaction(() => {
          const p = find(v.scope, v.id)
          if (p.annotations.length >= ANNOTATION_LIMIT) throw new Error('批注数量已达到上限')
          p.annotations.push({ id: randomUUID(), text: msg.note, url: p.remoteUrl ?? p.url, ...extra })
        })
      } catch (error) {
        page.error = (error as Error).message
      }
      broadcast(v.scope)
      await syncPicker(v)
    }
  }
  const find = (scope: string, id: string): BrowserPage => {
    const p = state(scope).pages.find(p => p.id === id)
    if (!p) throw new Error('网页标签不存在')
    return p
  }
  const getView = (win: BrowserWindow, scope: string, p: BrowserPage): View => {
    const key = win.id + ':' + scope + ':' + p.id,
      prior = views.get(key)
    if (prior) {
      if (p.remoteUrl && !prior.view.webContents.isLoadingMainFrame() && prior.view.webContents.getURL() !== p.url)
        void prior.view.webContents.loadURL(p.url).catch(() => {})
      return prior
    }
    const partition = 'persist:pixelsky-web-' + scope,
      browserSession = session.fromPartition(partition)
    if (!configured.has(partition)) {
      configured.add(partition)
      const grants = new Set<string>()
      browserSession.setPermissionCheckHandler(
        (contents, permission, origin) => !!contents && grants.has(origin + ':' + permission),
      )
      browserSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
        const entry = [...views.values()].find(v => v.view.webContents === contents)
        if (!entry || !['media', 'notifications', 'geolocation', 'clipboard-sanitized-write'].includes(permission)) {
          callback(false)
          return
        }
        const origin = details.requestingUrl || contents.getURL()
        hide(entry.owner)
        const r = await dialog.showMessageBox(entry.owner, {
          type: 'question',
          title: nativeText(entry.owner, '网站权限'),
          message: origin + '\n' + permission,
          buttons: [nativeText(entry.owner, '拒绝'), nativeText(entry.owner, '允许')],
          defaultId: 0,
          cancelId: 0,
        })
        if (r.response === 1) {
          try {
            grants.add(new URL(origin).origin + ':' + permission)
          } catch {}
        }
        callback(r.response === 1)
        if (!entry.owner.isDestroyed()) place(entry)
      })
      // 失败的请求记到发出请求的那个网页标签上（每个分区只能挂一个监听，这里是唯一的）
      const owner = (id: number | undefined): View | undefined =>
        id === undefined
          ? undefined
          : [...views.values()].find(v => !v.view.webContents.isDestroyed() && v.view.webContents.id === id)
      const all = { urls: ['<all_urls>'] }
      const request = (d: Parameters<typeof failedRequest>[0] & { webContentsId?: number; method: string }): void => {
        const v = owner(d.webContentsId),
          line = v && failedRequest(d)
        if (v && line)
          noteIssue(
            v.scope,
            v.id,
            { kind: 'request', text: `${d.method} ${line}`, source: d.resourceType, at: Date.now() },
            line,
          )
      }
      browserSession.webRequest.onCompleted(all, request)
      browserSession.webRequest.onErrorOccurred(all, request)
      browserSession.on('will-download', (event, item, contents) => {
        const entry = [...views.values()].find(v => v.view.webContents === contents)
        if (!entry) {
          event.preventDefault()
          return
        }
        hide(entry.owner)
        // Electron owns the save dialog while the download is pending.
        item.setSaveDialogOptions({
          title: nativeText(entry.owner, '保存下载文件'),
          defaultPath: basename(item.getFilename()),
        })
        item.once('done', () => {
          if (!entry.owner.isDestroyed()) place(entry)
        })
      })
    }
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    const entry: View = {
      view,
      scope,
      id: p.id,
      owner: win,
      channel: 'pixelsky-pick:' + randomUUID() + ':',
      injected: false,
      scale: 1,
    }
    views.set(key, entry)
    win.contentView.addChildView(view)
    view.setVisible(false)
    const wc = view.webContents
    // 新窗口链接（docs/ui/browser-v2.md §3.3）：本机、同一个主机、项目里的文件直接新开网页标签；外部的照旧问
    const openFailed = (error: unknown): void => {
      p.error = error instanceof Error ? error.message : String(error)
      broadcast(scope)
    }
    /** 用户看到的地址（远端工作区把本机转发的地址换回原地址） */
    const shownUrl = (url: string): string => (p.remoteUrl ? (browserRemoteUrl(url, p.remoteUrl, p.url) ?? url) : url)
    wc.setWindowOpenHandler(({ url }) => {
      let inside: string | null = null
      try {
        const target = pageUrl(url, root)
        if (target.startsWith('file:') || opensInside(target, wc.getURL())) inside = shownUrl(target)
      } catch {}
      if (inside && state(scope).pages.length < PAGE_LIMIT) {
        void openInBrowser(win, scope, inside).catch(openFailed)
        return { action: 'deny' }
      }
      try {
        const safe = browserUrl(url)
        hide(win)
        void dialog
          .showMessageBox(win, {
            type: 'question',
            title: nativeText(win, '打开外部链接'),
            message: safe,
            detail: nativeText(win, '需要和原网页互相通信的弹窗（比如第三方登录）在内置浏览器里用不了'),
            buttons: [
              nativeText(win, '取消'),
              nativeText(win, '在内置浏览器打开'),
              nativeText(win, '用系统浏览器打开'),
            ],
            defaultId: 0,
            cancelId: 0,
          })
          .then(r => {
            if (r.response === 1) return openInBrowser(win, scope, shownUrl(safe)).catch(openFailed)
            if (r.response === 2) return shell.openExternal(safe)
          })
          .finally(() => {
            if (!win.isDestroyed()) place(entry)
          })
      } catch {}
      return { action: 'deny' }
    })
    const root = scopeRoots.get(scope) ?? null
    const allowed = (event: Electron.Event, url: string): void => {
      try {
        pageUrl(url, root)
      } catch {
        event.preventDefault()
      }
    }
    wc.on('will-navigate', allowed)
    wc.on('will-redirect', allowed)
    wc.on('will-frame-navigate', event => {
      try {
        pageUrl(event.url, root)
      } catch {
        event.preventDefault()
      }
    })
    const update = (): void => {
      if (wc.isDestroyed() || !state(scope).pages.some(item => item.id === p.id)) return
      const url = wc.getURL()
      if (!p.loading && url && url !== 'about:blank') {
        try {
          const actual = pageUrl(url, root),
            remote = p.remoteUrl ? browserRemoteUrl(actual, p.remoteUrl, p.url) : null
          if (p.remoteUrl) p.remoteUrl = remote ?? actual
          p.url = actual
        } catch {}
      }
      p.title = wc.getTitle() || pageTitle(p.url)
      p.canBack = wc.navigationHistory.canGoBack()
      p.canForward = wc.navigationHistory.canGoForward()
      broadcast(scope)
    }
    wc.on('did-start-loading', () => {
      p.loading = true
      p.error = null
      delete p.failed
      update()
    })
    wc.on('did-stop-loading', () => {
      p.loading = false
      update()
      // 打开成功的记进最近地址（地址栏下拉）
      const s = store.data.scopes[scope]
      if (s && p.failed === undefined && !p.error) s.recent = pushRecent(s.recent, p.remoteUrl ?? p.url)
      persist()
    })
    wc.on('page-favicon-updated', (_e, urls) => {
      const url = urls.find(u => /^(https?:|data:image\/)/i.test(u))
      if (!url) return
      const at = wc.getURL()
      void loadFavicon(browserSession, url).then(icon => {
        // 取图标期间换了网站：这个图标是上一个站的，不用
        if (!icon || wc.isDestroyed() || !sameOrigin(at, wc.getURL())) return
        if (favicons.get(p.id) === icon || !state(scope).pages.some(item => item.id === p.id)) return
        favicons.set(p.id, icon)
        broadcast(scope)
      })
    })
    // 网页有焦点时应用窗口收不到按键：浏览器快捷键在这里截下来交给界面（docs/ui/browser-v2.md §3.1），其余照常给网页
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return
      const mac = process.platform === 'darwin'
      const shortcut = browserShortcut(
        { key: input.key, code: input.code, mod: mac ? input.meta : input.control, shift: input.shift, alt: input.alt },
        mac,
      )
      if (!shortcut || win.isDestroyed()) return
      event.preventDefault()
      // 要在界面里打字的（地址栏、查找条）：焦点先从网页回到应用窗口
      if (shortcut === 'address' || shortcut === 'newPage' || shortcut === 'find') win.webContents.focus()
      sendTo(win.webContents, 'projectBrowser:key', { scope, pageId: p.id, shortcut })
    })
    wc.on('did-navigate', (_e, url) => {
      update()
      setImmediate(update)
      // 按网站记住的缩放（docs/ui/browser-v2.md §3.2）；加载中 p.url 还是上一页的，按跳到的地址算
      const zoom = zoomOf(p, url)
      if (Math.abs(wc.getZoomFactor() - zoom) > 0.001) wc.setZoomFactor(zoom)
      // 打开 / 离开本地文件：开始 / 停止监听项目目录
      syncFileWatch(scope)
    })
    // 网页里 Ctrl+滚轮、触控板捏合。一下滚轮会连着来两次（真实实例里量到相隔不到 1ms），15ms 内的只认第一次
    let lastWheel = 0
    wc.on('zoom-changed', (_e, direction) => {
      const now = performance.now()
      if (now - lastWheel < 15) return
      lastWheel = now
      setZoom(scope, p, wc, direction === 'in' ? 'in' : 'out')
    })
    wc.on('did-navigate-in-page', () => {
      update()
      setImmediate(update)
    })
    wc.on('page-title-updated', update)
    wc.on('dom-ready', () => void syncPicker(entry))
    wc.on('console-message', details => void onPick(entry, parsePickMessage(details.message, entry.channel)))
    wc.on('console-message', details => {
      const entry = consoleEntry(details, Date.now())
      if (entry) noteIssue(scope, p.id, entry, consoleIssue(details) ?? entry.text)
    })
    // 换了一页（不是页内跳转）：上一页的错误清掉
    wc.on('did-start-navigation', details => {
      if (!details.isMainFrame || details.isSameDocument) return
      const cleared = forgetIssues(p.id)
      // 换了网站：上一个站的图标不留着
      const icon = favicons.get(p.id)
      if (icon && !sameOrigin(details.url, wc.getURL()) && favicons.delete(p.id)) broadcastSoon(scope)
      else if (cleared) broadcastSoon(scope)
    })
    wc.on('did-fail-load', (_e, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        p.error = description
        p.failed = code
        p.loading = false
        update()
      }
    })
    wc.on('render-process-gone', (_e, details) => {
      p.error = details.reason
      p.failed = 0
      p.loading = false
      broadcast(scope)
    })
    win.once('closed', () => {
      for (const [id, v] of views)
        if (v.owner === win) {
          if (!v.view.webContents.isDestroyed()) v.view.webContents.close()
          views.delete(id)
        }
      bounds.delete(win.id)
      for (const scope of fileWatches.keys()) syncFileWatch(scope)
    })
    void wc.loadURL(p.url).catch(() => {})
    place(entry)
    // 不在前台的标签也设好模拟，切过去不用再刷新。要在开始加载之后：还没加载过的网页连调试器发模拟，实测主进程会崩溃。
    // 手机 / 平板第一次加载用的还是电脑标识，emulate 设好后会重新加载一次（触摸也要新页面才认）
    void emulate(entry)
    return entry
  }
  const handle = (name: string, fn: (e: IpcMainInvokeEvent, scope: string, ...args: unknown[]) => unknown): void => {
    ipc.handle(`projectBrowser:${name}` as ipc.InvokeChannel, async (e, ref, ...args) => {
      const scope = scopeOf(workspaceRef(ref))
      if (
        name !== 'navigate' &&
        !['state', 'annotate', 'removeAnnotation', ...TOOL_CHANNELS].includes(name) &&
        !(name === 'viewport' && args[0] === null) &&
        !(name === 'action' && ['close', 'stop', 'back', 'forward'].includes(String(args[1])))
      ) {
        const id = name === 'viewport' ? state(scope).activeId : args[0]
        const page = typeof id === 'string' ? find(scope, id) : null
        if (page?.remoteUrl) page.url = await transport(scope, page.remoteUrl)
      }
      const result = await fn(e, scope, ...args)
      return result && typeof result === 'object' && 'pages' in result ? displayState(result as BrowserState) : result
    })
  }
  handle('state', (_, scope) => state(scope))
  /** 打开地址：pageId 为 null 时新开一个网页标签（original 已经校验过，是用户看到的地址） */
  const openUrl = async (win: BrowserWindow, scope: string, pageId: string | null, original: string) => {
    const url = await transport(scope, original)
    let page!: BrowserPage
    await store.transaction(data => {
      const s = (data.scopes[scope] ??= { pages: [], activeId: null })
      if (pageId !== null) {
        page = find(scope, pageId)
        page.url = url
        page.remoteUrl = original === url ? undefined : original
        page.error = null
      } else {
        if (s.pages.length >= PAGE_LIMIT) throw new Error('最多打开 12 个网页标签')
        page = {
          id: randomUUID(),
          url,
          remoteUrl: original === url ? undefined : original,
          title: pageTitle(original),
          loading: false,
          error: null,
          canBack: false,
          canForward: false,
          annotations: [],
        }
        s.pages.push(page)
      }
      s.activeId = page.id
    })
    return { page, url }
  }
  /** 网页里点的新窗口链接：新开一个网页标签（docs/ui/browser-v2.md §3.3） */
  async function openInBrowser(win: BrowserWindow, scope: string, original: string): Promise<void> {
    await openUrl(win, scope, null, original)
    hide(win)
    const id = state(scope).activeId
    if (id) place(getView(win, scope, find(scope, id)))
    broadcast(scope)
  }
  handle('navigate', async (e, scope, rawId, rawUrl) => {
    const original = pageUrl(rawUrl, scopeRoots.get(scope) ?? null),
      win = BrowserWindow.fromWebContents(e.sender)!
    const { page, url } = await openUrl(win, scope, rawId === null ? null : value(rawId, 200), original)
    hide(win)
    const existed = views.has(win.id + ':' + scope + ':' + page.id)
    const view = getView(win, scope, page)
    if (existed && view.view.webContents.getURL() !== url) void view.view.webContents.loadURL(url).catch(() => {})
    place(view)
    broadcast(scope)
    return state(scope)
  })
  handle('select', async (e, scope, rawId) => {
    const id = rawId === null ? null : value(rawId, 200)
    if (id) find(scope, id)
    await store.transaction(data => {
      const s = (data.scopes[scope] ??= { pages: [], activeId: null })
      s.activeId = id
    })
    const win = BrowserWindow.fromWebContents(e.sender)!
    hide(win)
    if (id) place(getView(win, scope, find(scope, id)))
    broadcast(scope)
    return state(scope)
  })
  handle('action', async (e, scope, rawId, action) => {
    const id = value(rawId, 200),
      p = find(scope, id),
      win = BrowserWindow.fromWebContents(e.sender)!
    if (action === 'close') {
      await store.transaction(data => {
        const s = data.scopes[scope]
        s.pages = s.pages.filter(p => p.id !== id)
        if (s.activeId === id) s.activeId = s.pages.at(-1)?.id ?? null
      })
      for (const [key, v] of views)
        if (v.scope === scope && v.id === id) {
          v.owner.contentView.removeChildView(v.view)
          v.view.webContents.close()
          views.delete(key)
        }
      missing.delete(id)
      forgetIssues(id)
      favicons.delete(id)
      syncFileWatch(scope)
      const next = state(scope).activeId
      if (next) place(getView(win, scope, find(scope, next)))
    } else {
      const wc = getView(win, scope, p).view.webContents
      if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
      else if (action === 'reload') wc.reload()
      else if (action === 'hardReload') wc.reloadIgnoringCache()
      else if (action === 'stop') wc.stop()
    }
    broadcast(scope)
    return state(scope)
  })
  handle('viewport', async (e, scope, raw, opts) => {
    const win = BrowserWindow.fromWebContents(e.sender)!
    // 被弹出层挡住要藏（docs/ui/browser-overlay-settings-window.md §A.2）：先给正在显示的网页截一张图，界面拿它顶替，看起来网页没动
    let snapshot: string | null = null
    if (raw === null && (opts as { freeze?: unknown } | undefined)?.freeze === true) {
      const b = bounds.get(win.id)
      const shown =
        b && [...views.values()].find(v => v.owner === win && v.scope === b.scope && state(v.scope).activeId === v.id)
      if (shown && !shown.view.webContents.isDestroyed()) {
        // 模拟设备时不带区域截到的是设备大小的画布、内容只在左上角缩小的那块：按视图大小截
        const { width, height } = shown.view.getBounds()
        const image = await shown.view.webContents.capturePage({ x: 0, y: 0, width, height }).catch(() => null)
        if (image && !image.isEmpty()) snapshot = `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`
      }
    }
    hide(win)
    if (raw === null) {
      bounds.delete(win.id)
      return { snapshot }
    }
    const r = raw as Electron.Rectangle,
      [width, height] = win.getContentSize(),
      zoom = e.sender.getZoomFactor()
    if (![r?.x, r?.y, r?.width, r?.height].every(Number.isFinite)) throw new Error('网页区域不正确')
    const x = Math.max(0, Math.round(r.x * zoom)),
      y = Math.max(48, Math.round(r.y * zoom))
    const rect = {
      x,
      y,
      width: Math.max(0, Math.min(Math.round(r.width * zoom), width - x)),
      height: Math.max(0, Math.min(Math.round(r.height * zoom), height - y)),
    }
    bounds.set(win.id, { scope, rect, zoom })
    const id = state(scope).activeId
    if (id && rect.width && rect.height) place(getView(win, scope, find(scope, id)))
  })
  handle('annotate', async (_, scope, rawId, text, extra) => {
    const id = value(rawId, 200)
    await store.transaction(() => {
      const p = find(scope, id)
      if (p.annotations.length >= ANNOTATION_LIMIT) throw new Error('批注数量已达到上限')
      p.annotations.push({
        id: randomUUID(),
        text: value(text, 4000, true),
        url: p.remoteUrl ?? p.url,
        ...elementExtra(extra),
      })
    })
    refreshPicker(scope, id)
    broadcast(scope)
    return state(scope)
  })
  // 点选元素批注（docs/ui/element-annotation.md）：开 / 关选取；config 是界面传来的主题色和文案
  handle('pick', async (e, scope, rawId, on, rawConfig) => {
    const page = find(scope, value(rawId, 200)),
      win = BrowserWindow.fromWebContents(e.sender)!
    pickConfig = sanitizePickConfig(rawConfig)
    const was = !!page.picking
    page.picking = on === true
    const entry = getView(win, scope, page)
    await syncPicker(entry)
    // 手机 / 平板模拟时点选期间鼠标不当手指用（点选靠悬停）
    void emulate(entry)
    if (page.picking && !was && !entry.view.webContents.isDestroyed()) entry.view.webContents.focus()
    broadcast(scope)
    return state(scope)
  })
  handle('removeAnnotation', async (_, scope, rawId, rawAnnotationId) => {
    await store.transaction(() => {
      const p = find(scope, value(rawId, 200))
      p.annotations = p.annotations.filter(a => a.id !== rawAnnotationId)
    })
    refreshPicker(scope, value(rawId, 200))
    broadcast(scope)
    return state(scope)
  })
  // ---- 第二批（docs/ui/browser-v2.md §3.2）：只对这个窗口里已经开着的网页 ----
  const openView = (e: IpcMainInvokeEvent, scope: string, rawId: unknown): { p: BrowserPage; wc: WebContents } => {
    const p = find(scope, value(rawId, 200)),
      win = BrowserWindow.fromWebContents(e.sender),
      wc = win && views.get(win.id + ':' + scope + ':' + p.id)?.view.webContents
    if (!wc || wc.isDestroyed()) throw new Error('网页还没打开')
    return { p, wc }
  }
  function setZoom(scope: string, p: BrowserPage, wc: WebContents, move: ZoomMove): void {
    const zoom = nextZoom(wc.getZoomFactor(), move),
      site = zoomSite(p, wc.getURL())
    wc.setZoomFactor(zoom)
    if (site) {
      store.data.zoom = rememberZoom(store.data.zoom, site, zoom)
      persist()
    }
    broadcast(scope)
  }
  handle('issues', (_, scope, rawId) => entries.get(find(scope, value(rawId, 200)).id) ?? [])
  handle('clearIssues', (_, scope, rawId) => {
    forgetIssues(find(scope, value(rawId, 200)).id)
    broadcast(scope)
    return state(scope)
  })
  handle('find', (e, scope, rawId, text, opts) => {
    const o = (opts ?? {}) as { forward?: unknown; next?: unknown }
    // 查找的文字不去空格（找「 a 」和找「a」不一样）
    if (typeof text !== 'string' || text.length > 500) throw new Error('参数不正确')
    return findOnce(openView(e, scope, rawId).wc, text, {
      forward: o.forward !== false,
      next: o.next === true,
    })
  })
  handle('stopFind', (e, scope, rawId) => {
    openView(e, scope, rawId).wc.stopFindInPage('clearSelection')
  })
  handle('zoom', (e, scope, rawId, move) => {
    if (!isZoomMove(move)) throw new Error('参数不正确')
    const { p, wc } = openView(e, scope, rawId)
    setZoom(scope, p, wc, move)
    return state(scope)
  })
  handle('devtools', (e, scope, rawId) => toggleDevTools(openView(e, scope, rawId).wc))
  handle('capture', async (e, scope, rawId, full) => {
    const { wc } = openView(e, scope, rawId)
    const device = emulatingDevice(wc)
    try {
      return await capturePage(wc, full === true, device)
    } finally {
      // 整页截图会关掉触摸模拟：截完重发一遍
      if (device && full === true) {
        staleEmulation(wc)
        for (const v of views.values()) if (v.view.webContents === wc) void emulate(v)
      }
    }
  })
  handle('clearSiteData', async (e, scope, rawId) => {
    const { wc } = openView(e, scope, rawId)
    await clearSiteData(wc.session, wc.getURL())
    wc.reloadIgnoringCache()
    return state(scope)
  })
  // ---- 第三批（docs/ui/browser-v2.md §3.3、§10）：设备尺寸、网页主题按工作区记 ----
  handle('preview', async (_, scope, raw) => {
    const next = cleanPreview(raw)
    await store.transaction(data => {
      const s = (data.scopes[scope] ??= { pages: [], activeId: null })
      if (next) s.preview = next
      else delete s.preview
    })
    for (const v of views.values())
      if (v.scope === scope) {
        if (state(scope).activeId === v.id) place(v)
        else void emulate(v)
      }
    broadcast(scope)
    return state(scope)
  })
  ctx.lifecycle.onShutdown(() => {
    for (const off of fileWatches.values()) off()
    fileWatches.clear()
    for (const v of views.values()) if (!v.view.webContents.isDestroyed()) v.view.webContents.close()
    views.clear()
  })
}
