import { BrowserWindow, WebContentsView, dialog, session, shell, type IpcMainInvokeEvent } from 'electron'
import * as ipc from '../ipc/guard'
import { createHash, randomUUID } from 'node:crypto'
import { join, basename, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserPage, BrowserState } from '../../shared/types/project-browser'
import type { WorkspaceRef } from '../../shared/types/workspace'
import { JsonStore, value, type ToolsHost } from '../core/project-tools/common'
import { workspaceRef } from '../core/workspace-files'
import { nativeText } from '../app/ui-language'
import type { AppContext } from '../app/context'
import { machineOf } from '../machines/identity'
import { browserRemoteUrl, browserTunnelUrl, remoteBrowserPort } from '../machines/browser-url'

interface StoredScope {
  pages: BrowserPage[]
  activeId: string | null
}
export function browserUrl(raw: unknown): string {
  const input = value(raw, 4000, true)
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
  const store = new JsonStore<{ scopes: Record<string, StoredScope> }>(join(dir, 'browser.json'), { scopes: {} })
  await store.init()
  for (const scope of Object.values(store.data.scopes))
    for (const p of scope.pages) {
      p.loading = false
      p.error = null
      p.canBack = false
      p.canForward = false
      p.annotations ??= []
    }
  type View = { view: WebContentsView; scope: string; id: string; owner: BrowserWindow }
  const views = new Map<string, View>(),
    configured = new Set<string>()
  const bounds = new Map<number, { scope: string; rect: Electron.Rectangle }>()
  const scopeMachines = new Map<string, string>()
  /** 本机项目的根目录（file:// 只放行这里面的文件）；远程机器不记 */
  const scopeRoots = new Map<string, string>()
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
    return { scope, pages: s.pages, activeId: s.activeId }
  }
  const broadcast = (scope: string): void => {
    ctx.events.broadcast('projectBrowser:changed', displayState(state(scope)))
  }
  const displayState = (value: BrowserState): BrowserState => ({
    ...value,
    pages: value.pages.map(page => ({ ...page, url: page.remoteUrl ?? page.url })),
  })
  const transport = async (scope: string, url: string): Promise<string> => {
    const machine = scopeMachines.get(scope) ?? 'local',
      port = remoteBrowserPort(url)
    if (machine === 'local' || port === null) return url
    return browserTunnelUrl(url, await ctx.machines!.connection(machine).forwardPort(port))
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
    if (show && b) v.view.setBounds(b.rect)
    v.view.setVisible(show)
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
    const entry = { view, scope, id: p.id, owner: win }
    views.set(key, entry)
    win.contentView.addChildView(view)
    view.setVisible(false)
    const wc = view.webContents
    wc.setWindowOpenHandler(({ url }) => {
      try {
        const safe = browserUrl(url)
        hide(win)
        void dialog
          .showMessageBox(win, {
            type: 'question',
            title: nativeText(win, '打开外部链接'),
            message: safe,
            buttons: [nativeText(win, '取消'), nativeText(win, '用系统浏览器打开')],
            defaultId: 0,
            cancelId: 0,
          })
          .then(r => {
            if (r.response === 1) return shell.openExternal(safe)
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
      update()
    })
    wc.on('did-stop-loading', () => {
      p.loading = false
      update()
      persist()
    })
    wc.on('did-navigate', () => {
      update()
      setImmediate(update)
    })
    wc.on('did-navigate-in-page', () => {
      update()
      setImmediate(update)
    })
    wc.on('page-title-updated', update)
    wc.on('did-fail-load', (_e, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        p.error = description
        p.loading = false
        update()
      }
    })
    wc.on('render-process-gone', (_e, details) => {
      p.error = details.reason
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
    })
    void wc.loadURL(p.url).catch(() => {})
    place(entry)
    return entry
  }
  const handle = (name: string, fn: (e: IpcMainInvokeEvent, scope: string, ...args: unknown[]) => unknown): void => {
    ipc.handle(`projectBrowser:${name}` as ipc.InvokeChannel, async (e, ref, ...args) => {
      const scope = scopeOf(workspaceRef(ref))
      if (
        name !== 'navigate' &&
        !['state', 'annotate', 'removeAnnotation'].includes(name) &&
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
  handle('navigate', async (e, scope, rawId, rawUrl) => {
    const original = pageUrl(rawUrl, scopeRoots.get(scope) ?? null),
      url = await transport(scope, original),
      win = BrowserWindow.fromWebContents(e.sender)!
    let page!: BrowserPage
    await store.transaction(data => {
      const s = (data.scopes[scope] ??= { pages: [], activeId: null })
      if (rawId !== null) {
        page = find(scope, value(rawId, 200))
        page.url = url
        page.remoteUrl = original === url ? undefined : original
        page.error = null
      } else {
        if (s.pages.length >= 12) throw new Error('最多打开 12 个网页标签')
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
      const next = state(scope).activeId
      if (next) place(getView(win, scope, find(scope, next)))
    } else {
      const wc = getView(win, scope, p).view.webContents
      if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
      else if (action === 'reload') wc.reload()
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
        const image = await shown.view.webContents.capturePage().catch(() => null)
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
    bounds.set(win.id, { scope, rect })
    const id = state(scope).activeId
    if (id && rect.width && rect.height) place(getView(win, scope, find(scope, id)))
  })
  handle('annotate', async (_, scope, rawId, text) => {
    const id = value(rawId, 200)
    await store.transaction(() => {
      const p = find(scope, id)
      if (p.annotations.length >= 100) throw new Error('批注数量已达到上限')
      p.annotations.push({ id: randomUUID(), text: value(text, 4000, true), url: p.remoteUrl ?? p.url })
    })
    broadcast(scope)
    return state(scope)
  })
  handle('removeAnnotation', async (_, scope, rawId, rawAnnotationId) => {
    await store.transaction(() => {
      const p = find(scope, value(rawId, 200))
      p.annotations = p.annotations.filter(a => a.id !== rawAnnotationId)
    })
    broadcast(scope)
    return state(scope)
  })
  ctx.lifecycle.onShutdown(() => {
    for (const v of views.values()) if (!v.view.webContents.isDestroyed()) v.view.webContents.close()
    views.clear()
  })
}
