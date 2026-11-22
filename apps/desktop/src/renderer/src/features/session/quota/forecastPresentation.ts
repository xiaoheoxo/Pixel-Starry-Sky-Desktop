import { tr } from '@/i18n/core'
import { usdText, type MonthValue, type WindowEstimate } from './estimate'
import { percentText, resetClock } from './quotaModel'

export function forecastLine(estimate: WindowEstimate, now: number): string | null {
  if (estimate.emptyAt !== null) return tr('quotaEst.emptyAt', { time: resetClock(estimate.emptyAt, now) })
  if (estimate.projected === null) return null
  return tr('quotaEst.leftAtReset', { p: percentText(100 - estimate.projected) })
}

export function forecastBasis(estimate: WindowEstimate): string | undefined {
  if (estimate.basis === 'recent') return tr('quotaEst.basis.recent')
  if (estimate.basis === 'window') return tr('quotaEst.basis.window')
}

export function budgetLine(estimate: WindowEstimate): string | null {
  if (!estimate.budget) return null
  const { percent, unit } = estimate.budget
  const value = percent > 0 && percent < 0.1 ? '<0.1%' : `${percent.toFixed(1).replace(/\.0$/, '')}%`
  return tr(unit === 'day' ? 'quotaEst.budget.day' : 'quotaEst.budget.hour', { p: value })
}

export function localValueLine(month: MonthValue): string {
  if (!month.usd) return tr('quotaEst.worthUnavailable')
  return tr(month.unpricedModels ? 'quotaEst.worthPartial' : 'quotaEst.worth', { usd: usdText(month.usd) })
}
