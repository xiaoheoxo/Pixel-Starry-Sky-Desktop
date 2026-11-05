import type { ImConnectInput, ImPlatform, ImState, ImTarget } from '../shared/types/im'

/** 设置 › 消息通道（docs/ui/one-click-connectors.md） */
export interface ImBridgeApi {
  state(): Promise<ImState>
  connect(platform: ImPlatform, input: ImConnectInput): Promise<ImState>
  disconnect(platform: ImPlatform): Promise<ImState>
  /** 清掉凭据、绑定和待发内容 */
  forget(platform: ImPlatform): Promise<ImState>
  pairStart(platform: ImPlatform): Promise<ImState>
  pairCancel(platform: ImPlatform): Promise<ImState>
  unbind(platform: ImPlatform): Promise<ImState>
  setProject(projectId: string): Promise<ImState>
  setTarget(target: ImTarget, channelId: string | null): Promise<ImState>
  onChange(callback: (state: ImState) => void): () => void
}
