import {
  getModelPosition,
  getModelRoleGuide,
  modelDetailKey,
  openAiApiReference,
  type ModelTokenPrice,
  type ModelDetail,
  type ModelDetailTarget,
} from '@pixelsky/protocol'
import { getLocale, tr } from '@/i18n/core'

export function modelRoleGuide(
  id: string | null | undefined,
  detail?: ModelDetail,
): ReturnType<typeof getModelRoleGuide> {
  const baseline = getModelRoleGuide(id, getLocale() === 'en-US' ? 'en' : 'zh')
  const main = detail?.main ?? baseline?.main ?? ''
  const evaluator = detail?.evaluator ?? baseline?.evaluator ?? ''
  return main || evaluator ? { main, evaluator } : undefined
}

export function channelModelDetail(
  details: Record<string, ModelDetail> | undefined,
  target: ModelDetailTarget,
): ModelDetail | undefined {
  return details?.[modelDetailKey(target)]
}

export function modelPositionLabel(id: string | null | undefined): string | undefined {
  const position = getModelPosition(id)
  if (!position) return undefined
  return tr(`modelDetails.position.${position}`)
}

export type MenuModelPrice = { price: ModelTokenPrice; basis: 'custom' | 'catalog' | 'standard' }

export function menuModelPrice(
  target: ModelDetailTarget,
  custom?: ModelTokenPrice,
  catalog?: ModelTokenPrice,
  now?: number,
): MenuModelPrice | undefined {
  if (custom) return { price: custom, basis: 'custom' }
  if (target.channel === 'platform' || target.channel === 'custom') return undefined
  if (catalog) return { price: catalog, basis: 'catalog' }
  const standard = target.channel === 'chatgpt' ? openAiApiReference(target.model, now) : undefined
  return standard && { price: standard, basis: 'standard' }
}
