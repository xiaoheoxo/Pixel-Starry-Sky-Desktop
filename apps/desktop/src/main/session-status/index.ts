// 侧栏对话状态图标的数据（docs/ui/sidebar-status-icons.md §4）：把 SessionStatusService 接到 Electron 上。
// 对话列表和事件来自本机引擎宿主（ctx.engine / ctx.hostListeners），窗口获得焦点用 app 的 browser-window-focus。
import { join } from 'node:path'
import { app, BrowserWindow, net } from 'electron'
import { dataRoot } from '../app/data-dir'
import type { HostEvent } from '@pixelsky/protocol'
import type { AppContext } from '../app/context'
import { runGit } from '../core/project-tools/git'
import * as ipc from '../ipc/guard'
import { machineOf } from '../machines/identity'
import { createGhRunner } from './gh'
import { createsPr } from './github'
import { PrLinkStore } from './links'
import { SessionStatusService, type RestResponse } from './service'

const MIN_FOLDER_FOCUS_MS = 2_000
const MIN_PR_FOCUS_MS = 60_000
const FOLDER_DEBOUNCE_MS = 1_000
const PR_DEBOUNCE_MS = 2_000
const FOLDER_EVERY_MS = 60_000
const PR_EVERY_MS = 5 * 60_000
const FIRST_PR_MS = 5_000
/** 某个对话一轮结束后等一会儿再查：智能体可能刚推了分支、建了 PR */
const AFTER_TURN_MS = 10_000

async function git(cwd: string, args: string[]): Promise<string | null> {
  const run = await runGit(cwd, args, { timeout: 10_000, limit: 64 * 1024 })
  return run.code === 0 ? run.stdout.toString('utf8').trim() : null
}

/** 公开接口的 GET：走系统代理；不带任何登录信息 */
async function fetchJson(url: string): Promise<RestResponse | null> {
  try {
    const response = await net.fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'PixelSky-Desktop' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return { status: response.status, body: null }
    }
    return { status: response.status, body: (await response.json()) as unknown }
  } catch {
    return null
  }
}

/** 创建服务并注册 IPC；返回停止函数（退出时也会自己停） */
export async function initSessionStatus(ctx: AppContext): Promise<() => void> {
  const links = new PrLinkStore(join(dataRoot(), 'session-status', 'prs.json'))
  await links.load()
  const service = new SessionStatusService({
    sessions: () =>
      (ctx.engine?.sessions() ?? []).map(s => ({
        id: s.record.id,
        cwd: s.record.cwd,
        archived: !!s.record.archivedAt,
      })),
    git,
    runGh: createGhRunner(),
    fetchJson,
    links,
    broadcast: state => ctx.events.broadcast('sessionStatus:changed', state),
    now: () => Date.now(),
  })

  const timers = new Set<NodeJS.Timeout>()
  const later = (ms: number, fn: () => void): NodeJS.Timeout => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timer.unref?.()
    timers.add(timer)
    return timer
  }
  // 同一件事连着触发只留最后一次
  const debounced = (ms: number, fn: () => void): (() => void) => {
    let timer: NodeJS.Timeout | null = null
    return () => {
      if (timer) clearTimeout(timer)
      timer = later(ms, () => {
        timer = null
        fn()
      })
    }
  }
  const folders = (): void => void service.refreshFolders()
  const prs = (): void => void service.refreshPrs()
  const foldersSoon = debounced(FOLDER_DEBOUNCE_MS, folders)
  const prsSoon = debounced(PR_DEBOUNCE_MS, prs)
  const afterTurn = new Map<string, NodeJS.Timeout>()
  const sessionPrsSoon = (id: string, ms: number): void => {
    const old = afterTurn.get(id)
    if (old) clearTimeout(old)
    afterTurn.set(
      id,
      later(ms, () => {
        afterTurn.delete(id)
        void service.refreshPrs(id)
      }),
    )
  }

  let pruned = false
  const onHostEvent = (e: HostEvent): void => {
    if (e.kind === 'sessions') {
      const changed = service.sessionsChanged()
      if (changed.folders) foldersSoon()
      if (changed.prs) prsSoon()
      // 第一次拿到对话列表时，清掉已经不存在的对话留下的链接记录
      if (!pruned && e.sessions.length) {
        pruned = true
        links.retain(new Set(e.sessions.map(s => s.record.id)))
      }
      return
    }
    if (e.kind !== 'session' || machineOf(e.sessionId) !== 'local') return
    const event = e.event
    if (event.type === 'turn_completed') sessionPrsSoon(e.sessionId, AFTER_TURN_MS)
    else if (event.type === 'item_completed') {
      const item = event.item
      const text =
        item.kind === 'command' || item.kind === 'tool' ? item.output : item.kind === 'assistant' ? item.text : ''
      // 只有建 PR 的那一步输出里的链接算这个对话自己的；其余（回复、别的命令输出）只是提到
      const own = (item.kind === 'command' || item.kind === 'tool') && createsPr(item)
      if (text && service.noteLinks(e.sessionId, text, own)) sessionPrsSoon(e.sessionId, PR_DEBOUNCE_MS)
    }
  }
  ctx.hostListeners.add(onHostEvent)

  const onFocus = (): void => {
    const now = Date.now()
    if (now - service.lastFolders >= MIN_FOLDER_FOCUS_MS) folders()
    if (now - service.lastPrRefresh >= MIN_PR_FOCUS_MS) prs()
  }
  app.on('browser-window-focus', onFocus)

  // 启动：先查文件夹（很快），PR 等几秒别和启动抢资源
  service.sessionsChanged()
  folders()
  later(FIRST_PR_MS, prs)
  // 定时查只在有窗口看得见时做：软件收在托盘、窗口最小化时不起 git / gh（docs/perf-audit-2026-10-18.md D10）；
  // 窗口回到前台时 onFocus 会补查（超过最小间隔的话）
  const shown = (): boolean =>
    BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.isVisible() && !w.isMinimized())
  const everyFolders = setInterval(() => shown() && folders(), FOLDER_EVERY_MS),
    everyPrs = setInterval(() => shown() && prs(), PR_EVERY_MS)
  everyFolders.unref?.()
  everyPrs.unref?.()

  ipc.handle('sessionStatus:get', () => service.state())
  ipc.handle('sessionStatus:refresh', async (_e, sessionId: unknown) => {
    if (sessionId !== undefined && sessionId !== null && (typeof sessionId !== 'string' || sessionId.length > 200))
      throw new Error('参数错误')
    const id = typeof sessionId === 'string' ? sessionId : undefined
    await Promise.all([service.refreshFolders(), service.refreshPrs(id, true)])
  })

  const dispose = (): void => {
    ctx.hostListeners.delete(onHostEvent)
    app.removeListener('browser-window-focus', onFocus)
    clearInterval(everyFolders)
    clearInterval(everyPrs)
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    void links.flush()
  }
  app.on('will-quit', dispose)
  return dispose
}
