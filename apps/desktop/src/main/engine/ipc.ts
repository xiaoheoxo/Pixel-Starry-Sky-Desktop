// 引擎系统（主进程）：把 EngineHost 接到 IPC。规格见 docs/engines.md §3、§5
//
// EngineHost 在 @pixelsky/engine 里，不依赖 Electron；这里只做三件事：
// 1. 收到渲染进程的请求就交给 core/engine/ops.ts 的操作表（只接受应用自己页面发来的请求）；
// 2. 把 EngineHost 的事件广播给所有窗口；
// 3. 「添加项目」「导出用量」弹出系统对话框；退出应用前关掉所有引擎进程。
// 同时按原顺序带起依赖引擎的模块：平台额度、SSH 机器、扩展、终端、产物面板的本机操作。
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, net, powerMonitor, session, shell, type IpcMainInvokeEvent } from 'electron'
import * as ipc from '../ipc/guard'
import { nativeText, windowLocale } from '../app/ui-language'
import { EngineHost } from '@pixelsky/engine'
import { ENGINES, isChatProject, type HostEvent, type SessionRecord } from '@pixelsky/protocol'
import type { AppContext } from '../app/context'
import { platformCalls, platformCharges, accountCalls, accountSummary } from '../platform/billing'
import { onAccountChange, signedInEmail } from '../account/account'
import { fetchStore, openStore } from '../account/store'
import {
  checkoutCancel,
  checkoutCreate,
  checkoutGet,
  checkoutOpenPayUrl,
  checkoutPending,
  checkoutVerify,
  panelStatus,
  panelVerify,
} from '../account/checkout'
import { closePayWindow, openPayWindow } from '../account/pay-window'
import { logger } from '@pixelsky/engine'
import { initPlatform, platformFallbackRoute, validateQueuedInput } from '../platform/platform'
import { initProviders } from '../providers/providers'
import { initSubagents } from '../subagents/ipc'
import { initAi } from '../ai/ipc'
import { Extensions } from '../extensions/ipc'
import { historyEnabled, historyServer } from './history-mcp'
import { threadsServer } from './threads-mcp'
import { bundledPixelCli } from './pixel-cli'
import { registerQuotaIpc } from './quota-ipc'
import { spawnTui } from './tui-spawn'
import { initTerminalIpc, localTerminals } from '../terminal/ipc'
import { initMachines } from '../machines/service'
import { machineOf } from '../machines/identity'
import { initArtifacts } from '../artifacts/ipc'
import { chatName, resolveTerminalTarget, workspaceToolsHost } from '../workspace/resolve'
import { ENGINE_OPS, addProjectPaths, type EngineOpContext } from '../core/engine/ops'
import { listImportCandidates } from '../core/importProjects'
import { opEntries, type InvokeName, type OpTable } from '../core/ops'
import { SearchRegistry } from '../core/search-registry'
import { usageQuery } from '../core/args'
import { npmLatest, scheduleEngineUpdateChecks } from './npm-latest'
import { logHostEvent } from '../core/log/host-events'
import { initProjectImport } from './project-import-ipc'
import { SystemProxy } from './systemProxy'
import { createNodeRuntime } from './node-runtime'
import { initSessionStatus } from '../session-status'

export async function initEngine(ctx: AppContext): Promise<void> {
  ctx.providers = initProviders(ctx)
  const subagents = initSubagents(ctx)
  initAi(ctx)
  const sessionEnv = await initPlatform(
    id =>
      machineOf(id) === 'local'
        ? (ctx.engine?.executionRecord(id) ?? null)
        : (ctx.machines?.call<SessionRecord | null>(machineOf(id), 'platform:record', [id]).catch(() => null) ?? null),
    () => ctx.engine?.engineConfig().claude.compactModel ?? null,
    record => {
      const machine = machineOf(record.id)
      if (machine === 'local') return ctx.engine?.platformRequestContext(record)
      return async (requestId, model, chargeId) => {
        if (!ctx.machines) throw new Error('SSH_NOT_CONNECTED')
        await ctx.machines.call(machine, 'platform:request', [record.id, requestId, model, chargeId])
      }
    },
    ctx.providers,
    (record, report) => {
      const machine = machineOf(record.id)
      if (machine === 'local') ctx.engine?.compactionRequest(record.id, report)
      else void ctx.machines?.call(machine, 'platform:compaction', [record.id, report]).catch(() => {})
    },
    () => subagents.get(),
    () => ctx.engine?.engineConfig().pixel.contextWindows.platform ?? {},
  )
  // 对话历史 MCP 服务：第一次有换过引擎的对话要派发消息时才启动
  const history = historyServer(ctx)
  app.on('will-quit', () => history.close())
  // 查看本机其他会话的 MCP 服务：设置里开了、有会话要派发消息时才启动（docs/ui/import-collab.md 第 5 项③）
  const threads = threadsServer(ctx)
  app.on('will-quit', () => threads.close())
  const extensions = new Extensions(ctx, history, threads)
  // 系统代理补给本机引擎（Claude Code / Codex 只认环境变量）；远程机器的宿主不传
  const proxyLog = logger('proxy')
  const systemProxy = new SystemProxy({
    resolve: url => session.defaultSession.resolveProxy(url),
    dir: app.getPath('userData'),
    log: (message, fields) => proxyLog.info(message, fields),
  })
  systemProxy.start()
  app.on('will-quit', () => systemProxy.stop())
  ipc.handle('engine:systemProxy', async () => {
    await systemProxy.refresh()
    return systemProxy.status()
  })
  ipc.handle('engine:setSystemProxy', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('参数不对')
    return systemProxy.setEnabled(enabled)
  })
  const h = new EngineHost({
    systemProxy: engine => systemProxy.forEngine(engine),
    // 没装 Node.js 时一键安装 Codex / Claude Code 先装一份私有的（docs/ui/engine-update.md §7）；net.fetch 走系统代理
    nodeRuntime: createNodeRuntime({
      root: join(app.getPath('userData'), 'runtime'),
      fetch: (url, init) => net.fetch(url, init),
    }),
    dataDir: join(app.getPath('userData'), 'engine'),
    // 删对话时它的文件夹里有文件：移到系统回收站
    trash: path => shell.trashItem(path),
    checkpoints: true,
    pixelCli: bundledPixelCli(),
    // 有 SSH 机器时由它合并本机与远端的项目 / 会话再广播
    emit: (e: HostEvent) => {
      logHostEvent(e)
      for (const listener of ctx.hostListeners) listener(e)
      if (ctx.machines) ctx.machines.hostEvent(e)
      else ctx.events.broadcast('engine:event', e)
    },
    sessionEnv,
    validateInput: record => validateQueuedInput(record, ctx.providers),
    // 订阅额度都用完时改用平台：挑线路和模型（docs/ui/engine-accounts.md §5.2）
    platformRoute: ({ engine, model }) => platformFallbackRoute(engine, model),
    priceRef: (record, model) =>
      // 上下文超过 200K 的自定义模型在 Claude Code 里叫「模型名[1m]」（docs/ui/custom-api.md §10）
      record.provider
        ? ctx.providers?.get(record.provider.id)?.models.find(m => m.id === model.replace(/\[1m\]$/i, ''))?.priceRef
        : null,
    costMultiplier: record => (record.provider ? ctx.providers?.get(record.provider.id)?.costMultiplier : null),
    extensions: record => extensions.prepare(record),
    historyTool: historyEnabled,
    platformCharges,
    platformCalls,
    latestVersion: npmLatest,
    // 断线自动重连时替用户发的那句，按界面语言
    continueText: () => (windowLocale() === 'en-US' ? 'Continue' : '继续'),
    // 账号额度变了广播给所有窗口（只在本机；docs/ui/account-quota.md §5）
    onQuota: quota => ctx.events.broadcast('quota:changed', quota),
  })
  ctx.engine = h
  registerQuotaIpc(h)
  watchSleep(h)
  backfillAfterSignIn(h)
  // 引擎有新版本时设置 › 本机引擎提示「更新」（docs/ui/engine-update.md）
  scheduleEngineUpdateChecks(() => h.checkEngineUpdates())
  // 侧栏对话的状态图标：工作文件夹还在不在、对话关联的 PR（docs/ui/sidebar-status-icons.md）
  await initSessionStatus(ctx)
  const machines = await initMachines(ctx, h, sessionEnv)
  extensions.register()
  const shutdownTerminals = await initTerminalIpc(machines, ref => resolveTerminalTarget(ctx, ref))

  const handle = (channel: ipc.InvokeChannel, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    ipc.handle(channel, (event, ...args) =>
      channel.startsWith('engine:') && ctx.machines
        ? ctx.machines.invoke(channel, args, () => fn(event, ...args))
        : fn(event, ...args),
    )
  }

  handle('account:calls', (_e, query) => accountCalls(query))
  handle('account:summary', (_e, query) => accountSummary(query))
  handle('account:store', () => fetchStore())
  handle('account:openStore', (_e, kind, params) => openStore(kind, params))
  // 软件内付款（docs/ui/in-app-payment.md §6.6）：参数校验、订单号白名单、地址校验都在 main/account/checkout.ts
  handle('account:checkoutCreate', (_e, input) => checkoutCreate(input))
  handle('account:checkoutGet', (_e, orderId) => checkoutGet(orderId))
  handle('account:checkoutVerify', (_e, orderId) => checkoutVerify(orderId))
  handle('account:checkoutCancel', (_e, orderId) => checkoutCancel(orderId))
  handle('account:checkoutPending', () => checkoutPending())
  handle('account:checkoutOpenPayUrl', (_e, orderId) => checkoutOpenPayUrl(orderId))
  // 付款窗口（pay_url 订单在软件里直接显示收银台页，main/account/pay-window.ts）：作为发起请求的窗口的子窗口
  handle('account:checkoutOpenPayWindow', (e, orderId) =>
    openPayWindow(BrowserWindow.fromWebContents(e.sender), orderId),
  )
  handle('account:checkoutClosePayWindow', (_e, orderId) => closePayWindow(orderId))
  handle('account:panelStatus', () => panelStatus())
  handle('account:panelVerify', () => panelVerify())
  // 搜索 / 产物扫描按窗口分桶；窗口关闭时中止它还没跑完的查询
  const searches = new SearchRegistry(),
    scans = new SearchRegistry()
  const observed = new Set<number>()
  const owner = (event: IpcMainInvokeEvent): string => {
    const sender = event.sender,
      key = String(sender.id)
    if (!observed.has(sender.id)) {
      observed.add(sender.id)
      sender.once('destroyed', () => {
        searches.release(key)
        scans.release(key)
        observed.delete(sender.id)
      })
    }
    return key
  }
  const context: Omit<EngineOpContext, 'owner'> = {
    host: h,
    searches,
    scans,
    tools: workspaceToolsHost(ctx),
    copyPath: async (projectId, copyId) => ctx.projectTools?.copyPath(projectId, copyId),
    projectTools: () => ctx.projectTools ?? undefined,
  }
  // 会话 ⇄ 终端（TUI）（docs/ui/tui-toggle.md §4.1）：只本机，不经 Machines.invoke
  ipc.handle('engine:tuiCheck', (_e, sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('会话不正确')
    return h.tuiBlock(sessionId)
  })
  ipc.handle('engine:tuiOpen', async (e, sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('会话不正确')
    const owner = e.sender.id
    const launch = await h.prepareTui(sessionId)
    const record = h.record(sessionId)
    if (!record) throw new Error('会话不存在')
    const project = h.projects().find(p => p.id === record.projectId)
    const term = await spawnTui(localTerminals(), id => h.clearTui(id), {
      owner,
      cwd: launch.cwd,
      command: launch.command,
      args: launch.args,
      env: launch.env,
      label: ENGINES[record.engine].name,
      sessionId,
      projectId: record.projectId,
      projectName: project?.name ?? (isChatProject(record.projectId) ? chatName() : record.projectId),
    })
    h.setTuiTerminal(sessionId, term.id)
    return { terminalId: term.id, engineSessionId: launch.engineSessionId }
  })
  ipc.handle('engine:tuiClose', async (e, sessionId, opts) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('会话不正确')
    const force = !!(opts && typeof opts === 'object' && (opts as { force?: boolean }).force)
    const record = h.record(sessionId)
    if (!record?.tui) return { added: 0, mismatched: false }
    const owner = e.sender.id
    const terminals = localTerminals()
    const term = record.tui.terminalId ? terminals.get(owner, record.tui.terminalId) : null
    if (term && (term.status === 'running' || term.status === 'starting') && !force) {
      throw Object.assign(new Error('tui.running'), { code: 'tui.running' })
    }
    if (term) {
      try {
        await terminals.change(owner, term.id, false, true)
      } catch {
        /* already gone */
      }
    }
    const sync = await h.syncFromTui(sessionId)
    h.clearTui(sessionId)
    return sync
  })

  for (const [channel, op] of opEntries(ENGINE_OPS))
    handle(channel, (event, ...args) => op({ ...context, owner: owner(event) }, ...args))
  // 手机端（main/mobile/）的调用：同一张操作表、同一层路由，按调用方分桶
  const ops: OpTable<EngineOpContext> = ENGINE_OPS
  ctx.engineCall = async (channel, args, caller) => {
    const op = Object.hasOwn(ops, channel) ? ops[channel as InvokeName] : undefined
    if (!op) throw new Error('UNSUPPORTED: ' + channel)
    const run = () => op({ ...context, owner: caller }, ...args)
    return ctx.machines ? ctx.machines.invoke(channel, args, run) : run()
  }
  initArtifacts(h)
  initProjectImport(ctx, h)
  // 选项目文件夹：可以按住 Ctrl / Shift 一次选几个（docs/ui/multi-root-projects.md §2）
  handle('engine:addProject', async e => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: nativeText(win, '选择项目文件夹'),
      properties: ['openDirectory' as const, 'multiSelections' as const],
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths.length) return null
    return h.addProjects(r.filePaths)
  })
  handle('engine:addProjects', (_e, paths: unknown) => addProjectPaths(h, paths))
  // 给项目加附加文件夹时选文件夹（只选，不加成项目；docs/ui/multi-root-projects.md §3.4）
  handle('engine:pickFolders', async e => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: nativeText(win, '选择要加进项目的文件夹'),
      properties: ['openDirectory' as const, 'multiSelections' as const],
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || !r.filePaths.length ? null : r.filePaths
  })
  // 「从一个文件夹导入…」：先选上级文件夹，再列出子文件夹给界面勾选
  handle('engine:importCandidates', async e => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: nativeText(win, '选择一个包含多个项目的文件夹'),
      properties: ['openDirectory' as const],
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    return listImportCandidates(
      r.filePaths[0],
      h.projects().map(p => p.path),
    )
  })
  handle('engine:usageExport', async (e, q) => {
    const query = usageQuery(q)
    const d = new Date(query.now)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const opts = {
      title: '导出用量记录',
      defaultPath: join(app.getPath('downloads'), `pixelsky-usage-${day}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    opts.title = nativeText(win, opts.title)
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return false
    await writeFile(r.filePath, h.usageCsv(query), 'utf8')
    return true
  })

  ctx.lifecycle.onShutdown(shutdownTerminals)
  ctx.lifecycle.onShutdown(() => h.shutdown())
}

/**
 * 旧的云端记录按时间补录实扣（docs/ui/usage.md §11.2）：登录状态下启动后 30 秒跑一次，
 * 之后每换一次登录账号再跑一次；失败只记日志，下次启动再试
 */
function backfillAfterSignIn(h: EngineHost): void {
  const log = logger('usage')
  let done: string | null = null
  let timer: NodeJS.Timeout | null = null
  const run = () => {
    timer = null
    const account = signedInEmail()
    if (!account || account === done) return
    done = account
    h.backfillPlatformCosts(account, AbortSignal.timeout(120_000)).then(
      turns => turns > 0 && log.info('旧记录已按时间补录实扣', { turns }),
      (e: unknown) => {
        done = null
        log.warn('旧记录补录实扣失败', { error: String((e as Error)?.message ?? e) })
      },
    )
  }
  const schedule = () => {
    if (!timer && signedInEmail() && signedInEmail() !== done) {
      timer = setTimeout(run, 30_000)
      timer.unref()
    }
  }
  onAccountChange(schedule)
  schedule()
}

/**
 * 待机 / 唤醒（docs/ui/claude-login-recovery.md §1）：记日志，唤醒时告诉宿主待机了多久——Claude 读不到登录到期时间（macOS）时，
 * 待机够久后下一次后台读取前先刷新登录
 */
function watchSleep(host: EngineHost): void {
  const log = logger('app')
  let since: number | null = null
  powerMonitor.on('suspend', () => {
    since = Date.now()
    log.info('待机')
  })
  powerMonitor.on('resume', () => {
    const sleptMs = since === null ? 0 : Date.now() - since
    since = null
    log.info('唤醒', { sleptMin: Math.round(sleptMs / 60_000) })
    host.resumed(sleptMs)
  })
}
