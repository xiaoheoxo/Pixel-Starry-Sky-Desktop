import { join } from 'node:path'
import { BrowserWindow, dialog, webContents } from 'electron'
import { codedError, isExtId, isExtVersion } from '@pixelsky/protocol'
import type { ExtStoreDetail, ExtStoreLocal, ExtStoreSort, ExtStoreState } from '@pixelsky/protocol'
import { object } from '@pixelsky/engine'
import * as ipc from '../../ipc/guard'
import type { AppContext } from '../../app/context'
import { baseUrl, signedInEmail } from '../../account/account'
import { nativeText } from '../../app/ui-language'
import type { ExtensionPacks } from '../service'
import { storeApi, StoreError } from './api'
import { createBlocklistSync } from './blocklist-sync'
import { createCheckHost, forkCheckProcess } from './check-host'
import { createInstaller } from './install'
import { downloadCapped } from './net'
import { createPublisher } from './publish'
import type { StoreHost } from './types'
import { AUTO_CHECK_INTERVAL_MS, createUpdates } from './updates'

// 扩展商店的主进程一侧（docs/ui/extension-store-client.md §3.10）。
// 公开通道（目录、详情、安装、取消、检查更新、状态）直接用 api / installer / updates；停用名单的定时读取是
// blocklist-sync.ts；要登录的通道（我的发布、举报）交给 publish.ts 的 createPublisher，参数检查在它里面。

const QUERY_MAX = 100
const SORTS = ['recommended', 'downloads', 'updated']

/** 扩展 id 和版本号按协议包的格式规则检查（和云端一致） */
const idArg = (value: unknown): string => {
  if (!isExtId(value)) throw codedError('extstore.badRequest')
  return value
}
const versionArg = (value: unknown): string => {
  if (!isExtVersion(value)) throw codedError('extstore.badRequest')
  return value
}

function optionalStr(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw codedError('extstore.badRequest')
  return value
}

function catalogQuery(raw: unknown): void {
  const q = object(raw)
  optionalStr(q.q, QUERY_MAX * 4) // 云端按 100 字截断，这里放宽到不会误拒，只防过大的参数
  optionalStr(q.category, 40)
  const sort = optionalStr(q.sort, 20)
  if (sort !== undefined && !SORTS.includes(sort)) throw codedError('extstore.badRequest')
  optionalStr(q.before, 40)
}

/** 本机装的同 id 的那一份：商店 > 文件夹 > 内置（详情页要显示「本机装的版本」） */
function localOf(service: ExtensionPacks, id: string): ExtStoreLocal | null {
  const packs = service.state().packs.filter(p => p.id === id)
  const pick = packs.find(p => p.source === 'store') ?? packs.find(p => p.source === 'folder') ?? packs[0]
  if (!pick) return null
  return {
    key: pick.key,
    version: pick.store?.version ?? pick.manifest?.version ?? null,
    source: pick.source,
    enabled: pick.enabled,
    ...(pick.blocked && { blocked: pick.blocked }),
  }
}

/**
 * 「选择 zip 或文件夹」：macOS 一个对话框能同时选；Windows / Linux 的对话框不能又选文件又选文件夹
 * （同时写两个属性只会出文件夹选择器），所以先问一句选哪种。取消返回 null
 */
async function pickUploadPath(sender: Electron.WebContents | undefined): Promise<string | null> {
  const win = sender ? BrowserWindow.fromWebContents(sender) : null
  const show = (opts: Electron.OpenDialogOptions) =>
    win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts)
  let properties: Array<'openFile' | 'openDirectory'> = ['openFile', 'openDirectory']
  if (process.platform !== 'darwin') {
    const ask = {
      type: 'question' as const,
      title: nativeText(win, '选择要上传的扩展'),
      message: nativeText(win, '要上传 zip 文件还是扩展文件夹？'),
      buttons: [nativeText(win, 'zip 文件'), nativeText(win, '扩展文件夹'), nativeText(win, '取消')],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    }
    const { response } = win ? await dialog.showMessageBox(win, ask) : await dialog.showMessageBox(ask)
    if (response === 2) return null
    properties = response === 0 ? ['openFile'] : ['openDirectory']
  }
  const r = await show({
    title: nativeText(win, '选择要上传的扩展'),
    properties,
    ...(properties.length === 1 && properties[0] === 'openFile'
      ? { filters: [{ name: 'zip', extensions: ['zip'] }] }
      : {}),
  })
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
}

/** 扩展商店的 IPC；service 的方法拼成 StoreHost 交给 installer（install.ts 自己拿不到 service） */
export function initExtStore(ctx: AppContext, service: ExtensionPacks): void {
  const site = (): string => new URL(baseUrl()).origin
  const changed = (): void => ctx.events.broadcast('extstore:changed')

  const host: StoreHost = {
    mutate: fn => service.runExclusive(fn),
    replaceStorePack: (record, root) => service.replaceStorePack(record, root),
    removeStorePack: id => service.removeStorePack(id),
    storeInfo: id => service.storeInfo(id),
    appVersion: service.opts.appVersion,
    storeDir: service.storeDir,
    ready: () => service.ready(),
    packs: () => service.state().packs,
  }
  const blocked = (s: string, id: string, version: string) => service.storeBlocked(s, id, version)
  const installer = createInstaller({
    host,
    api: storeApi,
    net: { downloadCapped },
    site,
    blocked,
    onChange: changed,
  })
  service.attachStoreTasks({ cancel: id => installer.cancel(id) })
  const updates = createUpdates({
    api: storeApi,
    site,
    packs: host.packs,
    appVersion: host.appVersion,
    blocked,
    onChange: changed,
  })
  // 启动时静默安装 BOOTSTRAP_PACKS（默认空，什么都不做）；不 await，失败只写日志
  void installer.bootstrap().catch(e => console.warn('[extension-store] bootstrap failed', e))

  // 停用名单：启动 15 秒后读一次、之后每 6 小时；读到后交给 service 重算 blocked。文件就是 service 启动时同步读的那一份
  const blocklist = createBlocklistSync({
    file: join(service.opts.dataDir, 'blocklist.json'),
    site,
    api: storeApi,
    apply: list => service.applyBlocklist(list).then(changed),
  })
  // 退出发生在 ready 之前时，不能让 ready 之后的 start() 又把定时器开起来
  let shutDown = false
  void service.ready().then(() => {
    if (!shutDown) blocklist.start()
  })
  ctx.lifecycle.onShutdown(() => {
    shutDown = true
    blocklist.stop()
  })

  // 我的发布：选包的对话框、登录状态、检查进程都从这里注入（publish.ts 不碰 electron）
  const publisher = createPublisher({
    api: storeApi,
    // ext-check.js 和 main/index.js 在同一个文件夹；起不起来由 check-host 回「本机没检查完」
    runCheck: createCheckHost({
      fork: forkCheckProcess,
      workerPath: join(__dirname, 'ext-check.js'),
      tmpRoot: join(service.storeDir, '.tmp'),
      // 启动时的 cleanStoreDir 会清空 store/.tmp：等它跑完再建临时目录（它在内置扩展加载后、商店加载前执行）
      whenReady: () => service.builtinReady(),
    }),
    signedIn: signedInEmail,
    checksDir: join(service.opts.dataDir, 'publish-checks'),
    pickPath: owner => pickUploadPath(webContents.fromId(Number(owner))),
  })

  // 窗口关了就丢掉它没用过的 token 和字节；每个窗口只挂一次
  const watched = new Set<number>()
  const watchOwner = (sender: Electron.WebContents): void => {
    const id = sender.id
    if (watched.has(id)) return
    watched.add(id)
    sender.once('destroyed', () => {
      watched.delete(id)
      publisher.forget(id)
    })
  }

  ipc.handle('extstore:catalog', (_e, query: unknown) => {
    catalogQuery(query)
    const q = object(query)
    return storeApi.catalog({
      q: optionalStr(q.q, QUERY_MAX * 4),
      category: optionalStr(q.category, 40),
      sort: optionalStr(q.sort, 20) as ExtStoreSort | undefined,
      before: optionalStr(q.before, 40),
    })
  })
  ipc.handle('extstore:detail', async (_e, id: unknown): Promise<ExtStoreDetail | null> => {
    const detail = await storeApi.detail(idArg(id)).catch(e => {
      // 下架或停用后详情 404：回 null，渲染层显示本机那份
      if (e instanceof StoreError && e.status === 404) return null
      throw e
    })
    return detail && { ...detail, local: localOf(service, detail.extension.id) }
  })
  // 参数 { auto:true } 是打开扩展页时的自动检查：距上次查完不到 10 分钟就直接回上次的结果；不带参数（点「检查更新」）立刻查
  ipc.handle('extstore:checkUpdates', (_e, options: unknown) => {
    const auto = options === undefined || options === null ? undefined : object(options).auto
    if (auto !== undefined && typeof auto !== 'boolean') throw codedError('extstore.badRequest')
    return updates.check(auto ? { maxAgeMs: AUTO_CHECK_INTERVAL_MS } : {})
  })
  ipc.handle(
    'extstore:state',
    (): ExtStoreState => ({
      site: site(),
      updates: updates.last(),
      blocklistAt: blocklist.status().blocklistAt,
      installing: installer.installing(),
    }),
  )
  ipc.handle('extstore:refreshBlocklist', async () => ({ blocklistAt: (await blocklist.refresh()).blocklistAt }))
  ipc.handle('extstore:publisher', () => publisher.publisher())
  ipc.handle('extstore:publishCheck', (_e, id: unknown, version: unknown) => publisher.publishCheck(id, version))

  // 会写的
  ipc.handle('extstore:install', (_e, id: unknown, version: unknown, options: unknown) => {
    const rollback = object(options).rollback
    if (rollback !== undefined && typeof rollback !== 'boolean') throw codedError('extstore.badRequest')
    return installer.install(idArg(id), versionArg(version), { rollback: rollback === true })
  })
  ipc.handle('extstore:cancel', (_e, id: unknown) => installer.cancel(idArg(id)))
  ipc.handle('extstore:report', (_e, id: unknown, input: unknown) => publisher.report(id, input))
  ipc.handle('extstore:register', (_e, name: unknown) => publisher.register(name))
  // 每个窗口只留一份没用过的 token：以发起调用的窗口（sender.id）为主人
  ipc.handle('extstore:pickUpload', (e, input: unknown) => {
    watchOwner(e.sender)
    return publisher.pickUpload(input, e.sender.id)
  })
  ipc.handle('extstore:upload', (e, token: unknown) => publisher.upload(token, e.sender.id))
  ipc.handle('extstore:withdraw', (_e, id: unknown, version: unknown) => publisher.withdraw(id, version))
  ipc.handle('extstore:delist', (_e, id: unknown) => publisher.delist(id))
  ipc.handle('extstore:relist', (_e, id: unknown) => publisher.relist(id))
}
