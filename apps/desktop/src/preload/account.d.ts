// 账号登录与额度：主进程、预加载脚本、渲染进程共用的类型。规格见 docs/ui/account.md §4

import type {
  AccountRefreshResult,
  AccountState,
  CheckoutCreateInput,
  CheckoutOrder,
  PanelStatus,
  PayWindowEvent,
  StoreCatalog,
  StoreLinkKind,
  StoreLinkParams,
} from '../shared/types/account'

/** window.pixelsky.account：所有网络请求都在主进程里做，渲染进程只能通过这里 */
export interface AccountBridge {
  listCalls(query: import('@pixelsky/protocol').RemoteCallsQuery): Promise<import('@pixelsky/protocol').RemoteCallPage>
  /** 账号调用的合计：卡片、图表、按模型分布（docs/ui/usage.md §9.4） */
  summary(
    query: import('@pixelsky/protocol').RemoteUsageQuery,
  ): Promise<import('@pixelsky/protocol').RemoteUsageSummary>
  getState(): Promise<AccountState>
  /** 打开浏览器授权；状态变成 signing-in，完成后变成 signed-in 或带 error 的 signed-out */
  login(): Promise<void>
  cancelLogin(): Promise<void>
  logout(): Promise<void>
  /** 重新拉取账号与额度（一定发新请求；返回刷新后的账号数据，失败时带错误） */
  refresh(): Promise<AccountRefreshResult>
  /** 订阅套餐与充值：云端 /v1/platform/store（跟随 Sub2api，docs/cloud-service.md §4.16） */
  store(): Promise<StoreCatalog>
  /** 在系统浏览器里打开面板的购买页 / 兑换页；地址取自最近一次 store() 的结果 */
  openStore(kind: StoreLinkKind, params?: StoreLinkParams): Promise<void>
  // 软件内付款（docs/ui/in-app-payment.md §6.6）：参数在主进程校验；云端的错误码用 codedError('checkout.<CODE>') 抛出，
  // 没有码的是可读的中文。订单号只认这次登录期间下过 / 列出来过的
  /** 下单（或复用同参数的待付单）；同一个 requestId 重试云端原样返回，同一时间只能有一个下单在途 */
  checkoutCreate(input: CheckoutCreateInput): Promise<CheckoutOrder>
  /** 查单；待付时云端按节流顺带向支付商核实 */
  checkoutGet(orderId: number): Promise<CheckoutOrder>
  /** 「我已付款」：马上核实 */
  checkoutVerify(orderId: number): Promise<CheckoutOrder>
  /** 取消待付单；返回取消后的状态（可能其实是已付） */
  checkoutCancel(orderId: number): Promise<CheckoutOrder>
  /** 软件里下的、还没到期的待付单（不含二维码，要付款时再 checkoutGet） */
  checkoutPending(): Promise<CheckoutOrder[]>
  /** 在系统浏览器里打开这笔订单的支付页；地址是主进程记下的，渲染层传不了 */
  checkoutOpenPayUrl(orderId: number): Promise<void>
  /**
   * 在软件里开一个小窗口显示这笔订单的支付页（只给收银台链接的支付方式，qrSource=pay_url）；地址是主进程记下的。
   * 同一笔再开就聚焦已有窗口，同时最多一个付款窗口。返回时窗口已建好，页面加载失败 / 用户关窗走 onPayWindow
   */
  checkoutOpenPayWindow(orderId: number): Promise<void>
  /** 关掉这笔订单的付款窗口（订单已付 / 取消 / 弹窗关闭时）；窗口已经不在或属于别的订单就什么都不做 */
  checkoutClosePayWindow(orderId: number): Promise<void>
  /** 订阅付款窗口事件（用户自己关了窗口、页面加载失败），返回取消订阅函数；主进程自己关窗不会通知 */
  onPayWindow(cb: (event: PayWindowEvent) => void): () => void
  /** 面板凭证状态：usableForCheckout 为假时下单会要求先确认账号 */
  panelStatus(): Promise<PanelStatus>
  /** 在系统浏览器里打开「确认账号」页（只换面板凭证，不换账号） */
  panelVerify(): Promise<void>
  /** 订阅状态变化，返回取消订阅函数 */
  onChange(cb: (state: AccountState) => void): () => void
}
