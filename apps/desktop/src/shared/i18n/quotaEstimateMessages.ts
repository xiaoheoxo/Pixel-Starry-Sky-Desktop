// 订阅额度估算（docs/ui/quota-estimate.md，样稿 docs/ui/quota-estimate-mockup.html）
export const quotaEstimateMessages = {
  'quotaEst.left': { zh: '剩 {p}', en: '{p} left' },
  'quotaEst.emptyAt': { zh: '约 {time} 用完', en: 'Runs out ~{time}' },
  'quotaEst.leftAtReset': { zh: '恢复时约剩 {p}', en: '~{p} left at reset' },
  'quotaEst.run': { zh: '还能跑 {usd} 额度', en: '{usd} of usage left' },
  'quotaEst.turnsReset': { zh: '约 {n} 轮 · {reset}', en: '~{n} turns · {reset}' },
  'quotaEst.worth': { zh: '近 30 天按 API 价 {usd}', en: 'Last 30 days at API prices {usd}' },
  'quotaEst.ratio': { zh: '月费的 {n} 倍', en: '{n}× the plan fee' },
  'quotaEst.detail': { zh: '明细', en: 'Details' },
  'quotaEst.paceTip': { zh: '这个窗口过了 {p} 的时间', en: '{p} of this window has passed' },
  'quotaEst.projTip': {
    zh: '浅色：照现在的速度到恢复时会用到哪',
    en: 'Light part: where usage lands at reset at the current pace',
  },
  'quotaEst.runTurns': { zh: '还能跑 {usd} 额度 · 约 {n} 轮', en: '{usd} of usage left · ~{n} turns' },
  'quotaEst.fee': { zh: '订阅月费', en: 'Plan fee' },
  'quotaEst.feeNone': { zh: '选月费', en: 'Pick fee' },
  'quotaEst.byModel': { zh: '按模型', en: 'By model' },
  'quotaEst.fine': {
    zh: '只算这台电脑上的使用；网页、手机、别的电脑用掉的会让百分比涨，所以「还能跑」和金额偏少。金额按官方 API 价折合。',
    en: 'Only counts use on this computer. Use on the web, phone or other computers raises the percentage too, so "usage left" and the amounts read low. Amounts use official API prices.',
  },
} as const
