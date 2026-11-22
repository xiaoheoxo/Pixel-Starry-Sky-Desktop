// Subscription quotas and local API-price comparisons are separate measurements.
export const quotaEstimateMessages = {
  'quotaEst.rows.label': { zh: '额度预测', en: 'Quota forecasts' },
  'quotaEst.rows.fiveHour': { zh: '5 小时预测', en: '5-hour forecast' },
  'quotaEst.rows.week': { zh: '周限预测', en: 'Weekly forecast' },
  'quotaEst.rows.awaiting': { zh: '等待新周期数据', en: 'Waiting for reset data' },
  'quotaEst.rows.unavailable': { zh: '暂无法预测', en: 'Forecast unavailable' },
  'quotaEst.left': { zh: '剩 {p}', en: '{p} left' },
  'quotaEst.emptyAt': { zh: '预计 {time} 用完', en: 'May run out around {time}' },
  'quotaEst.leftAtReset': { zh: '预计恢复时剩 {p}', en: 'Estimated {p} left at reset' },
  'quotaEst.basis.recent': {
    zh: '根据近期同一账号、同一周期的用量快照推算。',
    en: 'Based on recent usage readings for the same account and window.',
  },
  'quotaEst.basis.window': {
    zh: '近期样本不足，按本周期平均用量粗估。',
    en: 'Limited recent data: rough estimate using the full window average.',
  },
  'quotaEst.budget.day': { zh: '均摊至恢复：{p}/天', en: 'Budget until reset: {p}/day' },
  'quotaEst.budget.hour': { zh: '均摊至恢复：{p}/小时', en: 'Budget until reset: {p}/hour' },
  'quotaEst.worth': { zh: '本机近 30 天 · API 等价 {usd}', en: 'Local 30 days · API equivalent {usd}' },
  'quotaEst.worthPartial': {
    zh: '本机近 30 天 · 已计价部分 {usd}',
    en: 'Local 30 days · priced portion {usd}',
  },
  'quotaEst.worthUnavailable': {
    zh: '本机近 30 天 · 暂无可用模型价格',
    en: 'Local 30 days · model prices unavailable',
  },
  'quotaEst.ratio': { zh: '对比月费 {n}×', en: '{n}× plan fee for comparison' },
  'quotaEst.detail': { zh: '明细', en: 'Details' },
  'quotaEst.paceTip': { zh: '这个周期已过 {p}', en: '{p} of this window has passed' },
  'quotaEst.projTip': {
    zh: '浅色是推算，实色是服务上报的已用量。',
    en: 'The pale fill is a forecast. The solid fill is reported usage.',
  },
  'quotaEst.fee': { zh: '订阅月费', en: 'Plan fee' },
  'quotaEst.feeNone': { zh: '选月费', en: 'Pick fee' },
  'quotaEst.byModel': { zh: '按模型', en: 'By model' },
  'quotaEst.fine': {
    zh: '按本机记录和 API 参考价折算，可能合并同引擎多账号；不是实扣金额或订阅余额。部分模型仅能按标准短上下文价估算。',
    en: 'An API reference value for local records, possibly from several accounts on this engine. Not a charge or subscription balance. Some models use standard short-context prices only.',
  },
  'quotaEst.unpriced': { zh: '{n} 个模型缺少价格，未完整计入。', en: '{n} models are not fully priced.' },
} as const
