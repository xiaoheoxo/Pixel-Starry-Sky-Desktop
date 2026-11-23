import { tr } from '@/i18n/core'
import { usdText, type ForecastCollection, type MonthValue, type WindowEstimate } from './estimate'
import { percentText, resetClock } from './quotaModel'

export function forecastLine(estimate: WindowEstimate, now: number): string | null {
  const base =
    estimate.emptyAt !== null
      ? tr('quotaEst.emptyAt', { time: resetClock(estimate.emptyAt, now) })
      : estimate.projected !== null
        ? tr('quotaEst.leftAtReset', { p: percentText(100 - estimate.projected) })
        : null
  if (!base) return null
  return estimate.basis === 'window' ? tr('quotaEst.rough', { text: base }) : base
}

export function forecastCollectionText(collection: ForecastCollection): string {
  if (collection.state !== 'collecting') return tr(`quotaEst.collection.${collection.state}`)
  const hours = collection.requiredSpanMs >= 3_600_000
  const unit = hours ? 3_600_000 : 60_000
  return tr(
    collection.rounded
      ? 'quotaEst.collection.rounded'
      : hours
        ? 'quotaEst.collection.hours'
        : 'quotaEst.collection.minutes',
    {
      n: Math.min(collection.samples, collection.requiredSamples),
      target: collection.requiredSamples,
      span: Math.floor((Math.min(collection.spanMs, collection.requiredSpanMs) * 10) / unit) / 10,
      need: collection.requiredSpanMs / unit,
    },
  )
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
