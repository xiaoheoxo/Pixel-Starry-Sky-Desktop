export interface PlatformGroupInfo {
  supported_engines?: Array<'claude' | 'codex' | 'pixel' | 'antigravity'>
  supported_apis?: string[]
  id: string
  name: string
  description: string
  platform: string
  rate_multiplier: number
  billing_source: string
  models: string[]
  /** 这条线路按「扣费用的 Key」会记在哪把 Key 上（只有名字）；旧云端没有这个字段（docs/ui/platform-key-mode.md） */
  key?: PlatformGroupKey | null
}

/** 线路当前扣费的 Key：own 为 true 是用户自己在网站上建的，否则是客户端专用的托管 Key */
export interface PlatformGroupKey {
  name: string
  own: boolean
}

/** 平台额度的扣费 Key：自动（客户端专用的托管 Key，默认）/ 我的 Key（用户自己建的，没有时用托管 Key） */
export type PlatformKeyMode = 'auto' | 'own'
