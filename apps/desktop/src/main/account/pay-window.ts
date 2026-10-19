// 软件内付款的「付款窗口」（docs/ui/in-app-payment.md §6.3、§6.6、§7）：支付FM 这类只给收银台网页（qr_source=pay_url）的订单，
// 在软件里开一个小子窗口直接显示支付商的收银台页，用户用手机扫收银台上的码付一次即可（不用先扫我们生成的码再扫一次）。
// 这个窗口加载的是第三方网页，所以：独立的内存 session、沙箱、没有 preload、所有权限拒绝、只许 https、下载取消、
// 窗口里没有软件的任何数据；pay_url 只放内存，这里不记日志。
import { BrowserWindow, session, shell, type Session, type WebContents } from 'electron'
import { accountEpoch, onAccountChange } from './account'
import { payPageOf } from './checkout'
import { markPayWindow } from '../app/payWindowRegistry'
import { sendTo } from '../app/rendererHealth'
import { windowLocale } from '../app/ui-language'
import { systemMessages } from '../../shared/i18n/systemMessages'
import type { PayWindowEvent } from '../../shared/types/account'

// 登记处在 app/payWindowRegistry.ts（account.ts、app/events.ts、app/tray.ts 要用，不能反过来依赖本文件）；这里重新导出
export { isPayWindow } from '../app/payWindowRegistry'

/** 不带 persist: 的分区 = 只在内存里，关软件就没了；和软件界面、内置浏览器（persist:pixelsky-web-*）都不共享 */
export const PAY_PARTITION = 'pixelsky-pay'
const WIDTH = 420
const HEIGHT = 680
/** 页面脚本没有用户操作也能 window.open：同一个付款窗口里，系统浏览器两次被拉起至少隔这么久，期间的忽略 */
const EXTERNAL_OPEN_MIN_INTERVAL_MS = 3000
/** 英文界面的窗口标题里的支付方式名（服务端给的显示名是中文）；认不出的方式用通用写法 */
const EN_METHOD_NAMES: Readonly<Record<string, string>> = { alipay: 'Alipay', wxpay: 'WeChat Pay' }

// 主进程抛出的中文错误；字面量要和 shared/i18n/systemMessages.ts 里 system.checkout* 的 zh 一致，界面靠它反查英文
const MSG_NO_OWNER = '找不到发起请求的窗口'
const MSG_INVALID_REQUEST = '请求参数不正确' // 同 checkout.ts

interface Current {
  win: BrowserWindow
  orderId: number
  /** 打开时的登录会话代数：变了（退出 / 换账号）就关掉 */
  epoch: number
  /** 发起请求的窗口的页面：用户关窗 / 加载失败时往这里推 */
  owner: WebContents
  /** 主进程自己关的（换订单、渲染层要求、退出登录）不通知渲染层 */
  quiet: boolean
  /** 页面加载失败 / 崩溃已经通知过渲染层，窗口等下一轮事件再关：这段时间不再重复通知，用户关窗也不再推 closed */
  failing: boolean
  /** 上一次把 https 链接交给系统浏览器的时间（毫秒时间戳） */
  lastExternalAt: number
  /** 摘掉挂在发起请求的窗口上的监听（窗口关掉时调用） */
  dispose: () => void
}
let current: Current | null = null

/** 只许 https，不带用户名密码；其它协议（http、alipays://、weixin://、file:、javascript: ……）一律不放行 */
export function isHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

const configured = new WeakSet<Session>()
/**
 * 付款分区的 session，第一次用时配置好：所有权限请求和检查都拒绝（摄像头、麦克风、定位、通知、剪贴板读、
 * 串口 / USB / HID 等设备），下载一律取消，拼写检查关闭
 */
function paySession(): Session {
  const s = session.fromPartition(PAY_PARTITION)
  if (!configured.has(s)) {
    configured.add(s)
    s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    s.setPermissionCheckHandler(() => false)
    s.setDevicePermissionHandler(() => false)
    s.on('will-download', event => event.preventDefault())
    s.setSpellCheckerEnabled(false)
  }
  return s
}

/**
 * 清掉这个分区的存储（cookie、localStorage、IndexedDB、缓存）：session 在内存里会一直活到关软件，
 * 上一笔订单的收银台留下的登录态 / 记住的账号不应该带进下一笔订单。排成一条链，先后两次清理不会重叠
 */
let wiping: Promise<void> = Promise.resolve()
function wipeStorage(): Promise<void> {
  const s = paySession()
  wiping = wiping
    .then(() => s.clearStorageData())
    .then(() => s.clearCache())
    .catch(() => undefined)
  return wiping
}

function notify(rec: Current, state: PayWindowEvent['state']): void {
  if (rec.owner.isDestroyed()) return
  const event: PayWindowEvent = { orderId: rec.orderId, state }
  sendTo(rec.owner, 'account:payWindow', event)
}

/** 主进程关窗：不通知渲染层。用 destroy 而不是 close，收银台页面的 beforeunload 拦不住 */
function closeCurrent(): void {
  const rec = current
  if (!rec) return
  current = null
  rec.quiet = true
  rec.dispose()
  if (!rec.win.isDestroyed()) rec.win.destroy()
}

let watching = false
/** 退出登录 / 换账号（登录会话代数变化）时关掉付款窗口；第一次开窗时才订阅 */
function watchAccount(): void {
  if (watching) return
  watching = true
  onAccountChange(() => {
    if (current && current.epoch !== accountEpoch()) closeCurrent()
  })
}

function focus(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 主机名（标题里给用户看页面来自哪里；国际化域名是 punycode 形式，不容易被形近字冒充）；解析不了返回 null */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/** 窗口标题：「{支付方式}付款页面 · {主机名}」；英文界面支付方式只认 alipay / wxpay，认不出写「Payment page · {主机名}」 */
function payWindowTitle(owner: BrowserWindow, page: { label: string; method: string }, host: string): string {
  const lang = windowLocale(owner) === 'en-US' ? 'en' : 'zh'
  const name = lang === 'en' ? EN_METHOD_NAMES[page.method] : page.label
  const fill = (template: string, params: Record<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? '')
  return name
    ? fill(systemMessages['system.checkoutPayWindowTitle'][lang], { p0: name, p1: host })
    : fill(systemMessages['system.checkoutPayWindowTitleGeneric'][lang], { p0: host })
}

/** 窗口里的页面能做的事全部收紧：不开新窗口、只能 https、标题不让页面改、不能挂 webview、不能用 beforeunload 拦关窗 */
function lockDown(rec: Current, titleFor: (host: string) => string): void {
  const wc = rec.win.webContents
  // 新窗口一律拒绝；https 链接交给系统浏览器（alipays://、weixin:// 这类唤起 App 的链接在电脑上没意义，直接忽略）。
  // 页面脚本不需要用户操作也能 window.open，所以限流：同一个窗口里系统浏览器最多每 3 秒拉起一次，其余忽略
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttpsUrl(url)) {
      const now = Date.now()
      if (now - rec.lastExternalAt >= EXTERNAL_OPEN_MIN_INTERVAL_MS) {
        rec.lastExternalAt = now
        void Promise.resolve(shell.openExternal(url)).catch(() => undefined)
      }
    }
    return { action: 'deny' }
  })
  const httpsOnly = (event: { preventDefault(): void }, url: string): void => {
    if (!isHttpsUrl(url)) event.preventDefault()
  }
  wc.on('will-navigate', httpsOnly)
  wc.on('will-redirect', httpsOnly)
  // 内嵌框架：https 之外只放行空白页（about:blank），其它协议拦下
  wc.on('will-frame-navigate', (event: { url: string; preventDefault(): void }) => {
    if (event.url !== 'about:blank' && !isHttpsUrl(event.url)) event.preventDefault()
  })
  wc.on('will-attach-webview', event => event.preventDefault())
  wc.on('page-title-updated', event => event.preventDefault()) // 标题固定用我们的，不让页面冒充
  // 主框架跳转到别的主机后，标题里的主机名跟着变
  wc.on('did-navigate', (_event, url) => {
    const host = hostOf(url)
    if (host && !rec.win.isDestroyed()) rec.win.setTitle(titleFor(host))
  })
  // 收银台页面注册了 beforeunload 也照常卸载：否则用户点 ×、软件退出时窗口关不掉
  wc.on('will-prevent-unload', event => event.preventDefault())
  // 主框架加载失败（-3 是被我们拦下 / 取消，不算）或页面进程没了：通知渲染层，让弹窗给「在浏览器打开支付页」兜底，
  // 窗口推迟一轮再关（不在事件回调里同步 destroy）。等待期间 current 仍是 rec，靠 failing 防重复通知
  const failed = (): void => {
    if (current !== rec || rec.failing) return
    rec.failing = true
    notify(rec, 'failed')
    setImmediate(() => {
      if (current === rec) closeCurrent()
    })
  }
  wc.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) failed()
  })
  wc.on('render-process-gone', failed)
  rec.win.on('closed', () => {
    if (current === rec) current = null
    rec.dispose()
    if (!rec.quiet && !rec.failing) notify(rec, 'closed')
    if (!current) void wipeStorage()
  })
}

/**
 * account:checkoutOpenPayWindow：为这笔订单开付款窗口。地址只取主进程记下的这笔订单的 pay_url（渲染层传不了），
 * 订单要是这次登录期间下过 / 列出来过的、还在待付、地址是 https。同一笔再开就聚焦已有窗口；换订单先关掉旧的。
 * 窗口建好就返回，不等页面加载完：加载失败 / 用户关窗走 account:payWindow 事件
 */
export async function openPayWindow(owner: BrowserWindow | null, orderId: unknown): Promise<void> {
  const page = payPageOf(orderId)
  if (!owner || owner.isDestroyed()) throw new Error(MSG_NO_OWNER)
  watchAccount()
  if (current && current.orderId === page.orderId && !current.win.isDestroyed()) {
    focus(current.win)
    return
  }
  closeCurrent()
  const parent = owner.getBounds()
  const host = hostOf(page.url) ?? ''
  const titleFor = (h: string): string => payWindowTitle(owner, page, h)
  const win = new BrowserWindow({
    parent: owner,
    width: WIDTH,
    height: HEIGHT,
    minWidth: 360,
    minHeight: 480,
    x: Math.round(parent.x + (parent.width - WIDTH) / 2),
    y: Math.round(parent.y + Math.max(0, (parent.height - HEIGHT) / 2)),
    resizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    title: titleFor(host),
    webPreferences: {
      session: paySession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
    },
  })
  markPayWindow(win)
  if (process.platform !== 'darwin') win.removeMenu() // 窗口里不要软件的应用菜单
  const ownerContents = owner.webContents
  const rec: Current = {
    win,
    orderId: page.orderId,
    epoch: accountEpoch(),
    owner: ownerContents,
    quiet: false,
    failing: false,
    lastExternalAt: -Infinity,
    dispose: () => undefined,
  }
  current = rec
  // 发起请求的窗口的主框架重新加载（刷新、导航）/ 渲染进程崩溃 / 窗口关了：渲染层的状态已经没了，付款窗口不能留成孤儿
  const closeWithOwner = (): void => {
    if (current === rec) closeCurrent()
  }
  const onOwnerNavigate = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) closeWithOwner()
  }
  ownerContents.on('did-start-navigation', onOwnerNavigate)
  ownerContents.on('render-process-gone', closeWithOwner)
  owner.on('closed', closeWithOwner)
  rec.dispose = () => {
    rec.dispose = () => undefined
    owner.removeListener('closed', closeWithOwner)
    if (ownerContents.isDestroyed()) return
    ownerContents.removeListener('did-start-navigation', onOwnerNavigate)
    ownerContents.removeListener('render-process-gone', closeWithOwner)
  }
  lockDown(rec, titleFor)
  await wipeStorage()
  if (current !== rec || win.isDestroyed()) return // 清理期间被关了 / 换了订单
  // 加载失败不在这里处理（did-fail-load 会通知渲染层）；被我们拦下的导航让 loadURL 拒绝，也不用管
  void win.loadURL(page.url).catch(() => undefined)
}

/** account:checkoutClosePayWindow：关掉这笔订单的付款窗口；窗口不在或属于别的订单就什么都不做 */
export function closePayWindow(orderId: unknown): void {
  if (typeof orderId !== 'number' || !Number.isSafeInteger(orderId) || orderId <= 0)
    throw new Error(MSG_INVALID_REQUEST)
  if (current?.orderId === orderId) closeCurrent()
}
