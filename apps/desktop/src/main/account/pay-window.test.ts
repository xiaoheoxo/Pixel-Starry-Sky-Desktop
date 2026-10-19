import { beforeEach, describe, expect, it, vi } from 'vitest'

// 付款窗口（pay_url 订单在软件里显示收银台页）：窗口的安全配置、权限、导航拦截、同一订单复用、换订单、登录会话变化关窗、
// 页面加载失败 / 用户关窗通知渲染层、标题带主机名、window.open 限流、发起窗口重载 / 崩溃 / 关闭时跟着关（docs/ui/in-app-payment.md §6.6、§7）。

type Handler = (...args: any[]) => any // eslint-disable-line @typescript-eslint/no-explicit-any

const mocks = vi.hoisted(() => {
  class FakeContents {
    handlers = new Map<string, Handler[]>()
    openHandler: Handler | null = null
    on(event: string, fn: Handler): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
      return this
    }
    setWindowOpenHandler(fn: Handler): void {
      this.openHandler = fn
    }
    /** 触发事件；返回有没有被 preventDefault */
    fire(event: string, ...args: unknown[]): boolean {
      const prevented = { value: false }
      const e = {
        preventDefault: () => (prevented.value = true),
        ...(typeof args[0] === 'string' ? { url: args[0] } : {}),
      }
      for (const fn of this.handlers.get(event) ?? []) fn(e, ...args)
      return prevented.value
    }
  }
  class FakeWindow {
    static all: FakeWindow[] = []
    destroyed = false
    minimized = false
    webContents = new FakeContents()
    handlers = new Map<string, Handler[]>()
    loaded: string[] = []
    calls: string[] = []
    title: string
    constructor(public options: { webPreferences: Record<string, unknown>; [key: string]: unknown }) {
      this.title = String(options.title ?? '')
      FakeWindow.all.push(this)
    }
    on(event: string, fn: Handler): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
      return this
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    isMinimized(): boolean {
      return this.minimized
    }
    restore(): void {
      this.minimized = false
      this.calls.push('restore')
    }
    show(): void {
      this.calls.push('show')
    }
    focus(): void {
      this.calls.push('focus')
    }
    setTitle(title: string): void {
      this.title = title
    }
    removeMenu(): void {
      this.calls.push('removeMenu')
    }
    getBounds() {
      return { x: 100, y: 50, width: 1200, height: 800 }
    }
    async loadURL(url: string): Promise<void> {
      this.loaded.push(url)
    }
    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      // 真的 Electron 里 closed 事件在 destroy 之后才异步到
      queueMicrotask(() => {
        for (const fn of this.handlers.get('closed') ?? []) fn()
      })
    }
    /** 用户点了窗口的关闭按钮（等 closed 事件到了再返回） */
    async userClose(): Promise<void> {
      this.destroy()
      await Promise.resolve()
    }
  }
  const sessionHandlers: Record<string, Handler | undefined> = {}
  const sess = {
    on: vi.fn((event: string, fn: Handler) => (sessionHandlers[event] = fn)),
    setPermissionRequestHandler: vi.fn((fn: Handler) => (sessionHandlers.request = fn)),
    setPermissionCheckHandler: vi.fn((fn: Handler) => (sessionHandlers.check = fn)),
    setDevicePermissionHandler: vi.fn((fn: Handler) => (sessionHandlers.device = fn)),
    setSpellCheckerEnabled: vi.fn(),
    clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
  }
  return {
    FakeWindow,
    sess,
    sessionHandlers,
    fromPartition: vi.fn((_name: string) => sess),
    opened: [] as string[],
    epoch: 1,
    listeners: [] as Array<() => void>,
    sent: [] as Array<{ channel: string; args: unknown[] }>,
    ownerDestroyed: false,
    locale: 'zh-CN' as 'zh-CN' | 'en-US',
    /** 订单号 → 付款页（没写的订单当没记过） */
    pages: new Map<number, { url: string; label: string; method: string } | Error>(),
  }
})

vi.mock('electron', () => ({
  BrowserWindow: mocks.FakeWindow,
  session: { fromPartition: mocks.fromPartition },
  shell: {
    openExternal: async (url: string) => {
      mocks.opened.push(url)
    },
  },
}))
vi.mock('./account', () => ({
  accountEpoch: () => mocks.epoch,
  onAccountChange: (fn: () => void) => {
    mocks.listeners.push(fn)
    return () => undefined
  },
}))
vi.mock('./checkout', () => ({
  payPageOf: (orderId: unknown) => {
    const page = typeof orderId === 'number' ? mocks.pages.get(orderId) : undefined
    if (!page) throw new Error('找不到这笔订单，请重新下单')
    if (page instanceof Error) throw page
    return { orderId, ...page }
  },
}))
vi.mock('../app/rendererHealth', () => ({
  sendTo: (_wc: unknown, channel: string, ...args: unknown[]) => {
    mocks.sent.push({ channel, args })
    return true
  },
}))
vi.mock('../app/ui-language', () => ({ windowLocale: () => mocks.locale }))

const CASHIER = 'https://pay.example.com/cashier/abc?token=secret'

/** 最小的事件发射器：发起请求的窗口 / 页面上的监听要能挂、能摘、能触发 */
class Emitter {
  handlers = new Map<string, Handler[]>()
  on(event: string, fn: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
    return this
  }
  removeListener(event: string, fn: Handler): this {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter(h => h !== fn),
    )
    return this
  }
  count(event: string): number {
    return this.handlers.get(event)?.length ?? 0
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args)
  }
}
class FakeOwnerContents extends Emitter {
  isDestroyed = () => mocks.ownerDestroyed
}
class FakeOwner extends Emitter {
  webContents = new FakeOwnerContents()
  isDestroyed = () => mocks.ownerDestroyed
  getBounds = () => ({ x: 100, y: 50, width: 1200, height: 800 })
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function owner(): any {
  return new FakeOwner()
}
/** 等 setImmediate 排的那一轮（推迟关窗）过去 */
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

let mod: typeof import('./pay-window')
const win = (i = mocks.FakeWindow.all.length - 1) => mocks.FakeWindow.all[i]

beforeEach(async () => {
  vi.resetModules()
  mocks.FakeWindow.all = []
  mocks.opened = []
  mocks.epoch = 1
  mocks.listeners = []
  mocks.sent = []
  mocks.ownerDestroyed = false
  mocks.pages = new Map([
    [1234, { url: CASHIER, label: '支付宝', method: 'alipay' }],
    [5678, { url: 'https://pay.example.com/cashier/def', label: '支付宝', method: 'alipay' }],
  ])
  mocks.locale = 'zh-CN'
  for (const key of Object.keys(mocks.sessionHandlers)) delete mocks.sessionHandlers[key]
  mocks.sess.clearStorageData.mockClear()
  mocks.sess.clearCache.mockClear()
  mocks.fromPartition.mockClear()
  mod = await import('./pay-window')
})

describe('窗口的安全配置', () => {
  it('子窗口、约 420×680 可调大小、隐藏菜单栏、标题是「支付方式付款页面 · 主机名」', async () => {
    const parent = owner()
    await mod.openPayWindow(parent, 1234)
    expect(mocks.FakeWindow.all).toHaveLength(1)
    const { options } = win()
    expect(options).toMatchObject({
      parent,
      width: 420,
      height: 680,
      resizable: true,
      autoHideMenuBar: true,
      title: '支付宝付款页面 · pay.example.com',
    })
    expect(win().calls).toContain('removeMenu')
  })

  it('webPreferences：沙箱、隔离、无 node、无 preload、无 webview、关拼写检查', async () => {
    await mod.openPayWindow(owner(), 1234)
    const prefs = win().options.webPreferences
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    })
    expect(prefs).not.toHaveProperty('preload')
  })

  it('独立的不落盘 session：分区名不带 persist:，每次开窗前清掉存储再加载', async () => {
    await mod.openPayWindow(owner(), 1234)
    expect(mocks.fromPartition).toHaveBeenCalledWith('pixelsky-pay')
    expect(mocks.fromPartition.mock.calls.every(([name]) => !String(name).startsWith('persist:'))).toBe(true)
    expect(win().options.webPreferences.session).toBe(mocks.sess)
    expect(mocks.sess.clearStorageData).toHaveBeenCalledTimes(1)
    expect(mocks.sess.clearCache).toHaveBeenCalledTimes(1)
    expect(win().loaded).toEqual([CASHIER])
  })

  it('权限请求 / 检查 / 设备权限一律拒绝，下载取消，拼写检查关闭', async () => {
    await mod.openPayWindow(owner(), 1234)
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi']) {
      const callback = vi.fn()
      mocks.sessionHandlers.request!({}, permission, callback, {})
      expect(callback, permission).toHaveBeenCalledWith(false)
      expect(mocks.sessionHandlers.check!({}, permission, 'https://pay.example.com')).toBe(false)
    }
    expect(mocks.sessionHandlers.device!({})).toBe(false)
    const download = { preventDefault: vi.fn() }
    mocks.sessionHandlers['will-download']!(download)
    expect(download.preventDefault).toHaveBeenCalled()
    expect(mocks.sess.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
  })

  it('session 只配置一次，再开窗不重复挂处理函数', async () => {
    await mod.openPayWindow(owner(), 1234)
    await mod.openPayWindow(owner(), 5678)
    expect(mocks.sess.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
  })
})

describe('窗口里的页面', () => {
  it('window.open：一律拒绝；https 链接交给系统浏览器，其它协议（alipays://、weixin://、http、javascript:）忽略', async () => {
    await mod.openPayWindow(owner(), 1234)
    const open = win().webContents.openHandler!
    expect(open({ url: 'https://help.example.com/a' })).toEqual({ action: 'deny' })
    for (const url of [
      'alipays://platformapi/startapp?x=1',
      'weixin://dl/business',
      'http://insecure.example.com',
      'javascript:alert(1)',
      'file:///C:/Windows/win.ini',
      'https://user:pw@evil.example.com/',
      'not a url',
    ])
      expect(open({ url }), url).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(mocks.opened).toEqual(['https://help.example.com/a'])
  })

  it('window.open 限流：同一个窗口 3 秒内最多拉起一次系统浏览器，超出的忽略；3 秒后恢复；非 https 的不占名额', async () => {
    const now = vi.spyOn(Date, 'now')
    try {
      await mod.openPayWindow(owner(), 1234)
      const open = win().webContents.openHandler!
      now.mockReturnValue(1_000_000)
      expect(open({ url: 'https://a.example.com/1' })).toEqual({ action: 'deny' })
      now.mockReturnValue(1_000_000 + 2_999)
      expect(open({ url: 'https://a.example.com/2' })).toEqual({ action: 'deny' })
      now.mockReturnValue(1_000_000 + 3_000)
      expect(open({ url: 'alipays://x' })).toEqual({ action: 'deny' })
      open({ url: 'https://a.example.com/3' })
      now.mockReturnValue(1_000_000 + 5_999)
      open({ url: 'https://a.example.com/4' })
      now.mockReturnValue(1_000_000 + 6_000)
      open({ url: 'https://a.example.com/5' })
      await Promise.resolve()
      expect(mocks.opened).toEqual(['https://a.example.com/1', 'https://a.example.com/3', 'https://a.example.com/5'])
      // 另一个付款窗口各算各的
      await mod.openPayWindow(owner(), 5678)
      now.mockReturnValue(1_000_000 + 6_001)
      win().webContents.openHandler!({ url: 'https://b.example.com/' })
      await Promise.resolve()
      expect(mocks.opened.at(-1)).toBe('https://b.example.com/')
    } finally {
      now.mockRestore()
    }
  })

  it('will-prevent-unload：页面注册了 beforeunload 也照常卸载（preventDefault = 忽略拦截）', async () => {
    await mod.openPayWindow(owner(), 1234)
    expect(win().webContents.fire('will-prevent-unload')).toBe(true)
  })

  it('will-navigate / will-redirect：只放行 https，http 和其它协议拦下', async () => {
    await mod.openPayWindow(owner(), 1234)
    const wc = win().webContents
    for (const event of ['will-navigate', 'will-redirect']) {
      expect(wc.fire(event, 'https://pay.example.com/next'), event).toBe(false)
      for (const url of [
        'http://pay.example.com/',
        'alipays://x',
        'weixin://x',
        'file:///etc/passwd',
        'data:text/html,x',
      ])
        expect(wc.fire(event, url), `${event} ${url}`).toBe(true)
    }
  })

  it('内嵌框架导航：https 和 about:blank 放行，其它拦下；不能挂 webview；页面不能改标题', async () => {
    await mod.openPayWindow(owner(), 1234)
    const wc = win().webContents
    expect(wc.fire('will-frame-navigate', 'https://pay.example.com/frame')).toBe(false)
    expect(wc.fire('will-frame-navigate', 'about:blank')).toBe(false)
    expect(wc.fire('will-frame-navigate', 'http://pay.example.com/frame')).toBe(true)
    expect(wc.fire('will-frame-navigate', 'alipays://x')).toBe(true)
    expect(wc.fire('will-attach-webview')).toBe(true)
    expect(wc.fire('page-title-updated')).toBe(true)
  })

  it('isHttpsUrl：不带用户名密码的 https 才算', () => {
    expect(mod.isHttpsUrl('https://a.example.com/x?y=1')).toBe(true)
    expect(mod.isHttpsUrl('https://u:p@a.example.com/')).toBe(false)
    expect(mod.isHttpsUrl('http://a.example.com/')).toBe(false)
    expect(mod.isHttpsUrl('')).toBe(false)
  })
})

describe('打开 / 复用 / 关闭', () => {
  it('同一笔订单再次打开：聚焦已有窗口，不开第二个，不重复清存储 / 加载', async () => {
    await mod.openPayWindow(owner(), 1234)
    win().minimized = true
    await mod.openPayWindow(owner(), 1234)
    expect(mocks.FakeWindow.all).toHaveLength(1)
    expect(win().calls).toEqual(expect.arrayContaining(['restore', 'show', 'focus']))
    expect(win().loaded).toHaveLength(1)
    expect(mocks.sess.clearStorageData).toHaveBeenCalledTimes(1)
  })

  it('同时最多一个：换订单先关旧的（不通知渲染层），再开新的', async () => {
    await mod.openPayWindow(owner(), 1234)
    const first = win()
    await mod.openPayWindow(owner(), 5678)
    expect(mocks.FakeWindow.all).toHaveLength(2)
    expect(first.destroyed).toBe(true)
    expect(win(1).destroyed).toBe(false)
    expect(win(1).loaded).toEqual(['https://pay.example.com/cashier/def'])
    expect(mocks.sent).toEqual([])
    // 旧窗口关闭不会把新窗口刚加载的存储清掉：清理按顺序排队，且只有没窗口时才在关闭后清
    expect(mocks.sess.clearStorageData).toHaveBeenCalledTimes(2)
  })

  it('未知订单、格式不对的订单号、已不在待付（没有支付页）：拒绝，不开窗口', async () => {
    await expect(mod.openPayWindow(owner(), 999)).rejects.toThrow('找不到这笔订单')
    await expect(mod.openPayWindow(owner(), 'https://evil.example/x')).rejects.toThrow('找不到这笔订单')
    mocks.pages.set(1234, new Error('这笔订单没有可以打开的支付页'))
    await expect(mod.openPayWindow(owner(), 1234)).rejects.toThrow('没有可以打开的支付页')
    expect(mocks.FakeWindow.all).toHaveLength(0)
  })

  it('非 https 的支付页（主进程只会给 https，这里再认一次）：payPageOf 拒绝就不开', async () => {
    mocks.pages.set(77, new Error('这笔订单没有可以打开的支付页'))
    await expect(mod.openPayWindow(owner(), 77)).rejects.toThrow()
    expect(mocks.FakeWindow.all).toHaveLength(0)
  })

  it('找不到发起请求的窗口：拒绝', async () => {
    await expect(mod.openPayWindow(null, 1234)).rejects.toThrow('找不到发起请求的窗口')
    mocks.ownerDestroyed = true
    await expect(mod.openPayWindow(owner(), 1234)).rejects.toThrow('找不到发起请求的窗口')
    expect(mocks.FakeWindow.all).toHaveLength(0)
  })

  it('closePayWindow：关掉这笔订单的窗口且不通知；别的订单号不动；订单号格式不对报错', async () => {
    await mod.openPayWindow(owner(), 1234)
    mod.closePayWindow(5678)
    expect(win().destroyed).toBe(false)
    expect(() => mod.closePayWindow('1234')).toThrow('请求参数不正确')
    expect(() => mod.closePayWindow(-1)).toThrow('请求参数不正确')
    mod.closePayWindow(1234)
    expect(win().destroyed).toBe(true)
    expect(mocks.sent).toEqual([])
    mod.closePayWindow(1234) // 已经没有了：不报错
    // 关掉之后同一笔可以再开一个新的
    await mod.openPayWindow(owner(), 1234)
    expect(mocks.FakeWindow.all).toHaveLength(2)
  })

  it('关窗后清存储（没有别的付款窗口时）', async () => {
    await mod.openPayWindow(owner(), 1234)
    mocks.sess.clearStorageData.mockClear()
    mod.closePayWindow(1234)
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.sess.clearStorageData).toHaveBeenCalledTimes(1)
  })
})

describe('登录会话变化', () => {
  it('退出 / 换账号（epoch 变化）时关掉付款窗口，不通知渲染层', async () => {
    await mod.openPayWindow(owner(), 1234)
    expect(mocks.listeners).toHaveLength(1)
    // 账号状态变了但会话没换（刷新余额等）：窗口不动
    for (const fn of mocks.listeners) fn()
    expect(win().destroyed).toBe(false)
    mocks.epoch = 2
    for (const fn of mocks.listeners) fn()
    expect(win().destroyed).toBe(true)
    expect(mocks.sent).toEqual([])
  })

  it('订阅账号变化只订一次', async () => {
    await mod.openPayWindow(owner(), 1234)
    await mod.openPayWindow(owner(), 5678)
    expect(mocks.listeners).toHaveLength(1)
  })

  it('开窗口期间（清存储时）登录会话变了：不再加载页面', async () => {
    let release: () => void = () => undefined
    mocks.sess.clearStorageData.mockImplementationOnce(
      () => new Promise<undefined>(resolve => (release = () => resolve(undefined))),
    )
    const opening = mod.openPayWindow(owner(), 1234)
    mocks.epoch = 2
    for (const fn of mocks.listeners) fn()
    await new Promise(resolve => setTimeout(resolve, 0)) // 清理排在 promise 链里，等它真的调到 clearStorageData
    release()
    await opening
    expect(win().destroyed).toBe(true)
    expect(win().loaded).toEqual([])
  })
})

describe('通知渲染层', () => {
  it('用户自己关了窗口：推 closed', async () => {
    await mod.openPayWindow(owner(), 1234)
    await win().userClose()
    expect(mocks.sent).toEqual([{ channel: 'account:payWindow', args: [{ orderId: 1234, state: 'closed' }] }])
  })

  it('主框架加载失败：先推 failed，窗口推迟一轮再关（不在事件回调里同步 destroy）；子框架失败 / 被拦下（-3）不算', async () => {
    await mod.openPayWindow(owner(), 1234)
    const wc = win().webContents
    wc.fire('did-fail-load', -105, 'ERR_NAME_NOT_RESOLVED', CASHIER, false)
    wc.fire('did-fail-load', -3, 'ERR_ABORTED', CASHIER, true)
    expect(mocks.sent).toEqual([])
    expect(win().destroyed).toBe(false)
    wc.fire('did-fail-load', -105, 'ERR_NAME_NOT_RESOLVED', CASHIER, true)
    expect(mocks.sent).toEqual([{ channel: 'account:payWindow', args: [{ orderId: 1234, state: 'failed' }] }])
    expect(win().destroyed).toBe(false)
    await nextTurn()
    expect(win().destroyed).toBe(true)
    expect(mocks.sent).toHaveLength(1) // 关窗不再补推 closed
  })

  it('页面进程没了：推 failed，窗口推迟一轮再关', async () => {
    await mod.openPayWindow(owner(), 1234)
    win().webContents.fire('render-process-gone', { reason: 'crashed' })
    expect(mocks.sent).toEqual([{ channel: 'account:payWindow', args: [{ orderId: 1234, state: 'failed' }] }])
    expect(win().destroyed).toBe(false)
    await nextTurn()
    expect(win().destroyed).toBe(true)
  })

  it('推迟关窗期间：同一窗口的第二次失败不重复通知；用户抢先关窗不再补推 closed；换了订单不误关新窗口', async () => {
    await mod.openPayWindow(owner(), 1234)
    const wc = win().webContents
    wc.fire('did-fail-load', -105, 'x', CASHIER, true)
    wc.fire('render-process-gone', { reason: 'crashed' })
    expect(mocks.sent).toHaveLength(1)
    await win().userClose()
    await nextTurn()
    expect(mocks.sent).toHaveLength(1)

    await mod.openPayWindow(owner(), 5678)
    const second = win()
    second.webContents.fire('render-process-gone', { reason: 'crashed' })
    mod.closePayWindow(5678) // 渲染层先把它关了
    await mod.openPayWindow(owner(), 1234) // 又开了新的
    const third = win()
    await nextTurn()
    expect(second.destroyed).toBe(true)
    expect(third.destroyed).toBe(false)
  })

  it('通知里没有支付页地址（pay_url 不外传）；发起窗口已经销毁就不发', async () => {
    await mod.openPayWindow(owner(), 1234)
    win().webContents.fire('did-fail-load', -105, 'x', CASHIER, true)
    await nextTurn()
    expect(JSON.stringify(mocks.sent)).not.toContain('secret')
    await mod.openPayWindow(owner(), 5678)
    mocks.ownerDestroyed = true
    await win().userClose()
    expect(mocks.sent).toHaveLength(1)
  })
})

describe('窗口标题', () => {
  it('中文：「{支付方式}付款页面 · {主机名}」；跳转到别的主机后主机名跟着变；页面不能改标题', async () => {
    await mod.openPayWindow(owner(), 1234)
    expect(win().title).toBe('支付宝付款页面 · pay.example.com')
    win().webContents.fire('did-navigate', 'https://cashier.other.example.net:8443/pay?x=1')
    expect(win().title).toBe('支付宝付款页面 · cashier.other.example.net')
    expect(win().webContents.fire('page-title-updated', 'evil')).toBe(true)
    win().webContents.fire('did-navigate', 'not a url')
    expect(win().title).toBe('支付宝付款页面 · cashier.other.example.net')
  })

  it('英文：支付方式按 method 映射成 Alipay / WeChat Pay，不出现中文显示名；认不出的写 Payment page', async () => {
    mocks.locale = 'en-US'
    mocks.pages.set(1, { url: 'https://pay.example.com/a', label: '微信支付', method: 'wxpay' })
    mocks.pages.set(2, { url: 'https://pay.example.com/b', label: '某某支付', method: 'unionpay' })
    await mod.openPayWindow(owner(), 1234)
    expect(win().title).toBe('Alipay payment page · pay.example.com')
    await mod.openPayWindow(owner(), 1)
    expect(win().title).toBe('WeChat Pay payment page · pay.example.com')
    win().webContents.fire('did-navigate', 'https://cashier.example.org/')
    expect(win().title).toBe('WeChat Pay payment page · cashier.example.org')
    await mod.openPayWindow(owner(), 2)
    expect(win().title).toBe('Payment page · pay.example.com')
  })

  it('中文：服务端没给显示名时用通用写法', async () => {
    mocks.pages.set(3, { url: 'https://pay.example.com/c', label: '', method: 'alipay' })
    await mod.openPayWindow(owner(), 3)
    expect(win().title).toBe('付款页面 · pay.example.com')
  })
})

describe('付款窗口登记', () => {
  it('开出来的窗口是付款窗口（供广播 / 挑主窗口时跳过），别的窗口不是', async () => {
    await mod.openPayWindow(owner(), 1234)
    expect(mod.isPayWindow(win() as never)).toBe(true)
    expect(mod.isPayWindow({} as never)).toBe(false)
  })
})

describe('发起请求的窗口跟着变', () => {
  it('主框架开始导航（刷新、跳转）：关掉付款窗口，不通知；同页面内跳转（hash / pushState）和子框架不算', async () => {
    const parent = owner()
    await mod.openPayWindow(parent, 1234)
    parent.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    parent.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(win().destroyed).toBe(false)
    parent.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(win().destroyed).toBe(true)
    await Promise.resolve()
    expect(mocks.sent).toEqual([])
  })

  it('发起窗口的渲染进程崩溃：关掉付款窗口，不通知', async () => {
    const parent = owner()
    await mod.openPayWindow(parent, 1234)
    parent.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(win().destroyed).toBe(true)
    expect(mocks.sent).toEqual([])
  })

  it('发起窗口关了：关掉付款窗口', async () => {
    const parent = owner()
    await mod.openPayWindow(parent, 1234)
    parent.emit('closed')
    expect(win().destroyed).toBe(true)
  })

  it('窗口关掉后摘掉监听（用户关窗 / 主进程关窗 / 换订单），不泄漏；旧窗口的监听不会关掉新窗口', async () => {
    const parent = owner()
    const listeners = () =>
      parent.webContents.count('did-start-navigation') +
      parent.webContents.count('render-process-gone') +
      parent.count('closed')
    await mod.openPayWindow(parent, 1234)
    expect(listeners()).toBe(3)
    await win().userClose()
    expect(listeners()).toBe(0)

    await mod.openPayWindow(parent, 1234)
    mod.closePayWindow(1234)
    expect(listeners()).toBe(0)

    await mod.openPayWindow(parent, 1234)
    await mod.openPayWindow(parent, 5678) // 换订单：旧的摘掉，新的挂上
    expect(listeners()).toBe(3)
    parent.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(win().destroyed).toBe(true)
    expect(listeners()).toBe(0)
  })

  it('发起窗口的页面已销毁时关付款窗口不抛错', async () => {
    const parent = owner()
    await mod.openPayWindow(parent, 1234)
    mocks.ownerDestroyed = true
    expect(() => mod.closePayWindow(1234)).not.toThrow()
    expect(win().destroyed).toBe(true)
  })
})
