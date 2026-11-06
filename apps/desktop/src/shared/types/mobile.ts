// 手机端（docs/mobile-remote.md §5）：主进程和设置 › 手机之间传的东西
import type { Item, SessionSnapshot } from '@pixelsky/protocol'

/** 手机的权限档位：只看，或者也能审批、发消息、停止、新建任务 */
export type MobileAccess = 'view' | 'act'

export interface MobileDevice {
  /** 手机在中转上的 ID，配对时由手机生成 */
  id: string
  name: string
  /** 手机长期公钥的指纹（配对时两边显示同一串） */
  fingerprint: string
  access: MobileAccess
  pairedAt: number
  lastSeenAt: number | null
  /** 现在有没有加密连接 */
  online: boolean
}

export interface MobilePrefs {
  /** 允许手机远程连接（默认关） */
  enabled: boolean
  /** 中转地址；空的时候用云端服务（MobileState.relayDefault） */
  relay: string
  /** 有任务在运行时不让电脑睡眠（设置 › 通知，和 enabled 无关） */
  keepAwake: boolean
}

/** 到中转的连接 */
export type MobileLinkStatus = 'off' | 'connecting' | 'online' | 'error'

export interface MobilePairing {
  /** 二维码里的文本 */
  offer: string
  expires: number
  /** 有手机扫码发来请求时，等用户确认 */
  request: { name: string; fingerprint: string } | null
  status: 'waiting' | 'confirm' | 'accepted' | 'rejected' | 'expired'
}

export interface MobileState {
  prefs: MobilePrefs
  status: MobileLinkStatus
  /** 连不上中转时的原因（错误代码） */
  error: string | null
  desktopName: string
  /** 不填中转地址时用的云端中转 */
  relayDefault: string
  /** 电脑长期公钥的指纹；系统加密不可用时为 null（不能配对） */
  fingerprint: string | null
  devices: MobileDevice[]
  pairing: MobilePairing | null
}

/** 账号下的一台网页设备（云端 GET /v1/bridge/devices，跨桌面） */
export interface MobileCloudDevice {
  id: string
  name: string
  /** 配对到的那台桌面的 ID */
  desktopId: string
  /** 配对在这台电脑上（移除走本机的 mobile:revoke） */
  local: boolean
  /** 还在等桌面上确认 */
  pending: boolean
  online: boolean
  /** 最近一次连接中转的 IP；云端没记过为 null */
  lastIp: string | null
  lastSeenAt: number | null
  createdAt: number | null
}

/**
 * 设置 › 手机的远程席位（docs/cloud-admin-seats-plan.md §3–5）。
 * available 为 false：云端旧版本没有这个接口（404），界面不显示席位、照原样工作。
 */
export type MobileSeats =
  | { available: false }
  | {
      available: true
      /** 账号同时在线的网页设备数和上限 */
      used: number
      limit: number
      /** 有优质节点权益 */
      premium: boolean
      /** 能买席位 / 优质节点的套餐分组（Sub2api 的订阅分组 id）；空的时候不显示购买按钮 */
      seatGroups: number[]
      premiumGroups: number[]
      devices: MobileCloudDevice[]
    }

/** engine:openSessionTail 的结果：只有最后一段条目，去掉了图片、截断了长文本（§5.2） */
export interface SessionTail {
  snapshot: SessionSnapshot
  seq: number
  /** 会话总条数 */
  total: number
  /** 还有更早的条目时，向上翻页传这个 id 作为 before；没有更早的为 null */
  before: string | null
  /** 被截断过的条目 id（显示「查看完整」） */
  truncated: string[]
}

/** engine:itemDetail 的结果：一条的完整内容（长文本放宽到 256 KB，图片放得下才带上） */
export interface ItemDetail {
  item: Item
  truncated: boolean
}
