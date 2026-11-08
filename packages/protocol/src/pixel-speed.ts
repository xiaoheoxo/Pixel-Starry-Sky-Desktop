/** Pixel 的速度能力与请求档位。仅识别实际 provider / API，不按模型名猜。 */
export type PixelSpeed = 'off' | 'fast' | 'ultrafast'
export interface PixelSpeedCapability {
  fast: boolean
  ultrafast: boolean
}
export function pixelSpeedCapability(
  model:
    | {
        api?: unknown
        provider?: unknown
        baseUrl?: unknown
        serviceTiers?: unknown
      }
    | null
    | undefined,
): PixelSpeedCapability {
  if (model?.api !== 'openai-responses' && model?.api !== 'openai-codex-responses')
    return { fast: false, ultrafast: false }
  // 扩展 provider 可提供明确的目录声明；没有声明时不推断 UltraFast。
  const tiers = Array.isArray(model?.serviceTiers) ? model.serviceTiers : []
  const declared = (tier: string) => tiers.some(t => t === tier || (t && typeof t === 'object' && t.id === tier))
  const official =
    model?.provider === 'openai' &&
    typeof model.baseUrl === 'string' &&
    /^https:\/\/api\.openai\.com\/v1\/?$/.test(model.baseUrl)
  const fast = official || declared('priority')
  return { fast, ultrafast: fast && declared('ultrafast') }
}
export const pixelSpeedOf = (settings: { fast: boolean; ultrafast?: boolean }): PixelSpeed =>
  !settings.fast ? 'off' : settings.ultrafast ? 'ultrafast' : 'fast'
export const pixelSpeedTier = (speed: PixelSpeed): string =>
  speed === 'off' ? 'default' : speed === 'fast' ? 'priority' : 'ultrafast'
