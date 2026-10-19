import type { ExtPackInfo } from './types'

/** 扩展是否生效：开着、没有 scope:'pack' 的错误、没被平台停用、没被同 id 的别的来源替代。主进程和渲染层共用这一份 */
export function computeLive(info: Pick<ExtPackInfo, 'enabled' | 'status' | 'blocked' | 'shadowedBy'>): boolean {
  return info.enabled && info.status !== 'error' && !info.blocked && !info.shadowedBy
}
