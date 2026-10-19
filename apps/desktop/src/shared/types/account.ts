// 账号登录与额度：主进程、预加载脚本、渲染进程共用的类型。规格见 docs/ui/account.md §4

// 账号登录与额度：主进程、预加载脚本、渲染进程共用的类型。规格见 docs/ui/account.md §4

/** 额度：limit 为 0 表示不限 */
export interface Quota {
  used: number
  limit: number
}
export interface AccountPlan {
  name: string
  /** ISO 时间字符串；没有到期时间时为 null */
  expiresAt: string | null
  daily: Quota | null
  weekly: Quota | null
  monthly: Quota | null
}
export interface AccountInfo {
  email: string
  /** 显示名：sub2api 用户名，没有就用邮箱 @ 前面的部分 */
  name: string
  /** 钱包余额；拿不到时为 null */
  balance: number | null
  currency: string
  group: { name: string; billingSource: string } | null
  plan: AccountPlan | null
  rateLimits: Array<{ window: string; used: number; limit: number }>
  /** 上次成功拉取的时间（毫秒时间戳） */
  updatedAt: number
}
/** 手动刷新账号的结果：error 是失败原因（中文宿主文案，界面用 translateMessage），account 是刷新后的账号数据 */
export interface AccountRefreshResult {
  error: string | null
  account: AccountInfo | null
}
/** 登录没成功的原因（欢迎页按它显示不同的提示）：超时、在授权页点了取消、连不上服务、其他 */
export type LoginFailure = 'timeout' | 'denied' | 'network' | 'failed'
export type AccountState =
  | { status: 'signed-out'; error?: string; reason?: LoginFailure }
  /** url：授权页地址，回调服务起来后才有（「复制登录链接」用） */
  | { status: 'signing-in'; authCode: string; url?: string }
  | { status: 'signed-in'; account: AccountInfo; refreshing: boolean; error?: string }

// ---------------------------------------------------------------------------
// 订阅套餐与充值：跟随 Sub2api（docs/cloud-service.md §4.16，GET /v1/platform/store）
// ---------------------------------------------------------------------------

/** 套餐额度（美元）；null 表示不限 */
export interface StoreQuotas {
  fiveHour: number | null
  daily: number | null
  weekly: number | null
  monthly: number | null
}
export interface StorePlan {
  id: number
  name: string
  description: string
  /** 售价，单位是 currency */
  price: number
  /** 划线原价；没有为 null */
  originalPrice: number | null
  currency: string
  /** 有效期（天） */
  validityDays: number
  features: string[]
  /** 套餐对应的订阅分组名；账号的 plan.name 就是它 */
  groupName: string
  /** 订阅分组 id：面板购买页用 ?group=<id> 预选这个套餐；没有为 null */
  groupId: number | null
  quotas: StoreQuotas
  sort: number
}
export interface StoreBonusTier {
  /** 支付金额不低于它时命中 */
  minAmount: number
  bonusPercent: number
}
export interface StoreRecharge {
  enabled: boolean
  /** 0 表示不限 */
  min: number
  max: number
  /** 到账美元 = 支付金额 × multiplier */
  multiplier: number
  /** 手续费，百分数 */
  feeRate: number
  /** bonus：多送到账额度；discount：实付打折 */
  bonusMode: 'bonus' | 'discount'
  bonusTiers: StoreBonusTier[]
  usdToCnyRate: number
}
export interface StoreMethod {
  type: string
  label: string
}
export interface StoreCatalog {
  /** Sub2api 的支付总开关 */
  enabled: boolean
  /** 支付币种 */
  currency: string
  /** 云端没给币种（currency 是默认值猜的）时为 false；缺省当作已知 */
  currencyKnown?: boolean
  plans: StorePlan[]
  recharge: StoreRecharge
  methods: StoreMethod[]
  helpText: string
  /** 面板购买页 / 兑换页地址（可能是不带域名的路径，打开时由主进程校验） */
  purchaseUrl: string
  redeemUrl: string
  /** 软件内付款的能力标记（docs/ui/in-app-payment.md §4.12）；云端没给（旧版本）就是不开 */
  checkout?: StoreCheckout
}
/** 软件内扫码付款：开关、可用的支付方式（现在只会是 alipay / wxpay）、订单有效期 */
export interface StoreCheckout {
  enabled: boolean
  methods: string[]
  orderTimeoutMinutes: number
}
export type StoreLinkKind = 'purchase' | 'redeem'
/** 打开面板页时可带的查询：「订阅」标签，以及要预选的套餐分组 */
export interface StoreLinkParams {
  tab?: 'subscription'
  group?: number
}

// ---------------------------------------------------------------------------
// 软件内付款（docs/ui/in-app-payment.md §4.4、§6.6）：订单字段由主进程从云端的蛇形 JSON 解析成驼峰
// ---------------------------------------------------------------------------

export type CheckoutKind = 'balance' | 'plan'
/**
 * pending 待付；paid 已付款正在到账；completed 已到账；expired / cancelled / failed 终态；
 * refunding / refunded 退款中 / 已退款；云端给了不认识的值就是 unknown
 */
export type CheckoutStatus =
  | 'pending'
  | 'paid'
  | 'completed'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'refunding'
  | 'refunded'
  | 'unknown'
export interface CheckoutOrder {
  orderId: number
  kind: CheckoutKind
  status: CheckoutStatus
  /** 支付方式（alipay / wxpay）及其显示名 */
  method: string
  methodLabel: string
  /** 应付金额，以 Sub2api 返回的为准（含手续费、汇率、折扣） */
  payAmount: number
  payCurrency: string
  /** 手续费，百分数 */
  feeRate: number
  /** 余额充值的到账额度和赠送（美元）；套餐单为 null */
  credited: number | null
  bonus: number | null
  /** 套餐单的套餐；余额充值为 null */
  plan: { id: number; name: string; validityDays: number } | null
  /** 二维码内容：只在 pending 时有；provider 是支付商给的付款码，pay_url 是拿支付链接充当（扫码后会打开支付页） */
  qrContent: string | null
  qrSource: 'provider' | 'pay_url' | null
  /** 支付页链接：只在 pending 时有，且只留 https 且不带用户名密码的。打开浏览器走 checkoutOpenPayUrl（主进程只打开自己记下的这一条） */
  payUrl: string | null
  /** ISO 时间；倒计时用 serverTime 和 expiresAt 算，不受本机时钟偏差影响 */
  createdAt: string
  expiresAt: string
  paidAt: string | null
  completedAt: string | null
  serverTime: string
  /** 是不是复用的已有待付单 */
  reused: boolean
  /** 云端读单时面板凭证已失效（订单状态是最后一次读到的）；缺省当作有效 */
  panelValid?: boolean
}
/** 付款窗口的事件（主进程推给渲染层）：用户自己关了窗口，或页面没能加载出来（窗口已被主进程关掉） */
export interface PayWindowEvent {
  orderId: number
  state: 'closed' | 'failed'
}
/** 下单参数：requestId 是一次「下单意图」一个 UUID，重试和确认账号后续下单都用同一个 */
export interface CheckoutCreateInput {
  requestId: string
  kind: CheckoutKind
  /** kind=balance：支付金额（人民币），最多两位小数 */
  amount?: number
  /** kind=plan：商品数据里在售的套餐 id */
  planId?: number
  method: string
}
/** 面板凭证状态：usableForCheckout 表示凭证还够用于下单（云端要求至少剩 35 分钟） */
export interface PanelStatus {
  valid: boolean
  expiresAt: string | null
  usableForCheckout: boolean
}
