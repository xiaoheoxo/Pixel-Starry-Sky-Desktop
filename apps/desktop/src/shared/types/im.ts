// 消息通道（docs/ui/one-click-connectors.md）：主进程和设置 › 消息通道之间传的东西
export type ImPlatform = 'qq' | 'wechat'

export const IM_PLATFORMS: readonly ImPlatform[] = ['qq', 'wechat']

export type ImStatus = 'off' | 'connecting' | 'scan' | 'online' | 'error'

export interface ImChannelState {
  platform: ImPlatform
  status: ImStatus
  /** 错误代码，对应 im.error.* */
  error: string | null
  /** 错误的补充信息（QQ 白名单错误时的当前公网 IP） */
  errorDetail: string | null
  /** 存着凭据（QQ 的 AppSecret、微信的登录令牌） */
  configured: boolean
  /** QQ 的 AppID；不是密钥，回显在输入框里 */
  appId: string | null
  /** 用户确认过说明（经腾讯服务器、微信的账号风险） */
  accepted: boolean
  bound: boolean
  /** 微信扫码：二维码内容 */
  qr: string | null
  pairing: { code: string; expiresAt: number } | null
  /** 丢掉的其他人的消息数 */
  ignored: number
}

export interface ImState {
  /** 系统加密可用；不可用时不能保存凭据，不让连接 */
  cipher: boolean
  projectId: string | null
  projects: Array<{ id: string; name: string }>
  channels: ImChannelState[]
}

export interface ImConnectInput {
  accepted: boolean
  /** QQ：留空用已保存的 */
  appId?: string
  appSecret?: string
}
