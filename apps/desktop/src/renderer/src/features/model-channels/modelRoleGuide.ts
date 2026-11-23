import {
  getModelPosition,
  getModelRoleGuide,
  modelDetailKey,
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
