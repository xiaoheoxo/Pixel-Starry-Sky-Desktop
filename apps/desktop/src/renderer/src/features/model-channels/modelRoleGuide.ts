import {
  getModelPosition,
  getModelRoleGuide,
  modelDetailKey,
  openAiApiReference,
  publicApiPriceReference,
  type ModelDetail,
  type ModelDetailTarget,
  type ModelTokenPrice,
} from '@pixelsky/protocol'
import { getLocale, tr } from '@/i18n/core'

export function modelRoleGuide(
  id: string | null | undefined,
  detail?: ModelDetail,
  publicDescription?: string,
): ReturnType<typeof getModelRoleGuide> {
  const baseline = getModelRoleGuide(id, getLocale() === 'en-US' ? 'en' : 'zh')
  const main = detail?.main ?? publicDescription ?? baseline?.main ?? ''
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

export type MenuModelPrice = { price: ModelTokenPrice; basis: 'custom' | 'catalog' | 'standard' | 'relay-reference' }

export function menuModelPrice(
  target: ModelDetailTarget,
  custom?: ModelTokenPrice,
  catalog?: ModelTokenPrice,
  now?: number,
  priceRef?: string | null,
  relay = false,
): MenuModelPrice | undefined {
  if (custom) return { price: custom, basis: 'custom' }
  const isRelay = relay || target.channel === 'custom' || target.channel === 'platform'
  if (catalog) return { price: catalog, basis: isRelay ? 'relay-reference' : 'catalog' }
  const lookup = priceRef?.trim() || target.model
  const ref = isRelay ? publicApiPriceReference(lookup, now) : openAiApiReference(lookup, now)
  if (!ref) return undefined
  return { price: ref, basis: isRelay ? 'relay-reference' : 'standard' }
}

const CURRENCY_SYMBOL: Record<ModelTokenPrice['currency'], string> = {
  USD: '$',
  CNY: '¥',
  EUR: '€',
}

/** 紧凑两行模型菜单右侧价格小标签：仅自定义通道或用户主动自填时露出，订阅/平台通道不铺 API 美元价避免误导 */
export function compactMenuPrice(
  channel: ModelDetailTarget['channel'],
  entry: MenuModelPrice | undefined,
): { text: string; custom: boolean } | undefined {
  if (!entry) return undefined
  if (entry.basis !== 'custom' && channel !== 'custom') return undefined
  const symbol = CURRENCY_SYMBOL[entry.price.currency]
  const tag = tr(entry.basis === 'custom' ? 'modelChannels.menu.priceCustom' : 'modelChannels.menu.priceReference')
  return {
    text: tr('modelChannels.menu.priceCompact', {
      symbol,
      input: String(entry.price.input),
      output: String(entry.price.output),
      tag,
    }),
    custom: entry.basis === 'custom',
  }
}
