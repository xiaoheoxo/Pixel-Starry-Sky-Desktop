// 云端生图的尺寸、张数、计费档和估价（docs/ui/image-gen.md §6）：主进程校验和界面面板共用

/** 面板里的尺寸（按 Sub2api 的计费档：最长边 ≤1024 是 1K、≤2048 是 2K、更大 4K） */
export const CLOUD_IMAGE_SIZES = [
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
  '2160x3840',
] as const
export type CloudImageSize = (typeof CLOUD_IMAGE_SIZES)[number]
export const CLOUD_IMAGE_COUNTS = [1, 2, 4] as const
export type CloudImageCount = (typeof CLOUD_IMAGE_COUNTS)[number]
export const CLOUD_IMAGE_QUALITIES = ['low', 'medium', 'high'] as const
export type CloudImageQuality = (typeof CLOUD_IMAGE_QUALITIES)[number]
export type ImageTier = '1k' | '2k' | '4k'

/** 计费档位，规则同 Sub2api 的 ClassifyImageBillingTier */
export function imageTier(size: string): ImageTier {
  const [w, h] = size.split('x').map(Number)
  const edge = Math.max(w || 0, h || 0)
  return edge <= 1024 ? '1k' : edge <= 2048 ? '2k' : '4k'
}

/**
 * 估算要扣多少（美元）：张数 × 档位单价 × 倍率，和 Sub2api 按张结算的算法一致；
 * 这一档没配单价（0）时返回 null（Sub2api 会按渠道定价或 token 扣，估不出来）
 */
export function estimateCost(
  prices: Partial<Record<ImageTier, number>> | null | undefined,
  rate: number,
  size: string,
  n: number,
): number | null {
  const unit = prices?.[imageTier(size)] ?? 0
  return unit > 0 && rate >= 0 ? unit * n * rate : null
}

/** 美元金额：小于 1 分时多留两位 */
export const formatUsd = (usd: number): string => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`
