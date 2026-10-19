/** 设置 › 本机引擎「使用系统代理」的状态（main/engine/systemProxy.ts） */
export interface SystemProxyStatus {
  /** 开关：系统开着代理时补给本机引擎（默认开） */
  enabled: boolean
  /** 查到的 HTTP 代理（http://主机:端口）；没开代理或只有 SOCKS 时为 null */
  proxy: string | null
  /** 系统代理只有 SOCKS（主机:端口）：Claude Code 不支持，不传 */
  socks: string | null
  /** 系统环境变量里已经设了 HTTPS_PROXY 等：按用户的，不另外补 */
  envSet: boolean
}
