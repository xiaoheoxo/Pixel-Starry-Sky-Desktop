import type { ExtPackInfo, ExtStoreDetail } from '@pixelsky/protocol'

/** 取详情的结果：detail 是 null 时云端回的 404（下架 / 被停用）；error 是 5xx、连不上等失败的文案 */
export interface DetailResult {
  detail: ExtStoreDetail | null
  error: string | null
}

/**
 * 本机那份的这几样变了就重新取详情（详情里的 local 是主进程取的那一刻的）：
 * 装好 / 卸载（key、revision）、启停（enabled）、更新 / 换回（版本）、停用名单变了（blocked）
 */
export function localLoadKey(pack: ExtPackInfo | null): string {
  if (!pack) return ''
  return [pack.key, pack.revision, pack.enabled, pack.store?.version ?? '', pack.blocked?.at ?? ''].join(':')
}

/** 取失败：留着上一次取到的详情（重新取时不把页面清空），记下错误；不当成下架 */
export function failedResult(prev: DetailResult | null, error: string): DetailResult {
  return { detail: prev?.detail ?? null, error }
}
