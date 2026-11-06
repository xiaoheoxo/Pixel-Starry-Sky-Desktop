// 用量里没有费用的记录按原因分开（GitHub #22，docs/ui/usage.md §12）；带 {p0} 的计数标签放在 catalog，不参与动态匹配
export const costMessages = {
  'usageColumns.freshInput': { zh: '新增输入', en: 'New input' },
  'usageColumns.freshInputHelp': { zh: '不含缓存的输入 token', en: 'Input tokens not served from or written to cache' },
  'usageColumns.cacheHit': { zh: '缓存命中', en: 'Cache hits' },
  'usageColumns.cacheHitHelp': {
    zh: '从缓存读到的 token；悬停这一格看命中率。图表可以切到「缓存命中」看百分比走势',
    en: 'Tokens read from cache. Hover a cell for the hit rate, or switch the chart to Cache hits to see the trend',
  },
  'usageColumns.hitRate': { zh: '命中率 {p0}', en: 'Hit rate {p0}' },
  'usageColumns.speed': { zh: '速度', en: 'Speed' },
  'usageColumns.speedHelp': {
    zh: '每秒输出多少 token，不含等待和跑工具的时间；输出少于 100 token 不算',
    en: 'Output tokens per second, excluding waiting and tool time. Not shown under 100 output tokens',
  },
  'usageColumns.speedHelpLocal': {
    zh: '每秒输出多少 token，不含等待和跑工具的时间；输出少于 100 token 不算。这个版本之前的记录、量不准的引擎显示「—」',
    en: 'Output tokens per second, excluding waiting and tool time. Not shown under 100 output tokens, for older records or engines that cannot be timed accurately',
  },
  'usageColumns.firstTokenHelp': {
    zh: '从发出请求到收到第一个字的时间',
    en: 'Time from sending the request to the first output',
  },
  'usageColumns.firstTokenHelpLocal': {
    zh: '从这一轮开始到收到第一个字的时间。这个版本之前的记录显示「—」',
    en: 'Time from the start of the turn to the first output. Older records show —',
  },
  'usageColumns.durationHelp': { zh: '这次请求的总耗时', en: 'Total time of this request' },
  'usageColumns.durationHelpLocal': {
    zh: '这一轮总耗时，含等待和跑工具',
    en: 'Total time of this turn, including waiting and running tools',
  },
  'usageColumns.sampleNote': {
    zh: '云端没有按模型的合计，按这段时间最近 1000 次调用算',
    en: 'The cloud has no per-model totals, so this uses the latest 1000 calls in this period',
  },
  'usageColumns.success': { zh: '成功率', en: 'Success' },
  'usageColumns.successHelp': {
    zh: '完成的占比，中断的不算失败',
    en: 'Share that completed. Interruptions do not count as failures',
  },
  'usageColumns.tokenTotal': { zh: 'Token 合计 {p0}', en: 'Total tokens {p0}' },
  'usageColumns.avgTurn': { zh: '平均每轮 {p0}', en: 'Average per turn {p0}' },
  'usageColumns.avgCall': { zh: '平均每次 {p0}', en: 'Average per call {p0}' },
  'usageColumns.unpriced': { zh: '未定价', en: 'Unpriced' },
  'usageColumns.more': { zh: '更多指标', en: 'More metrics' },
  'usageColumns.less': { zh: '收起', en: 'Less' },
  'usageColumns.metric': { zh: '图表看什么', en: 'Chart metric' },
  'usageColumns.tokenSpeed': { zh: 'Token 速度', en: 'Token speed' },
  'usageColumns.heatTitle': { zh: '每天用量', en: 'Daily usage' },
  'usageColumns.heatNote': { zh: '最近 53 周', en: 'Last 53 weeks' },
  'usageColumns.heatNoteAccount': {
    zh: '最近 53 周 · 这个账号在所有设备的调用',
    en: 'Last 53 weeks · this account on all devices',
  },
  'usageColumns.heatSum': {
    zh: '这段时间 {p0} Token · {p1} 轮 · {p2}',
    en: '{p0} tokens · {p1} turns · {p2} in this period',
  },
  'usageColumns.heatSumAccount': {
    zh: '这段时间 {p0} Token · {p1} 次请求 · {p2}',
    en: '{p0} tokens · {p1} requests · {p2} in this period',
  },
  'usageColumns.heatLess': { zh: '少', en: 'Less' },
  'usageColumns.heatMore': { zh: '多', en: 'More' },
  'usageColumns.heatEmpty': { zh: '没有记录', en: 'No records' },
  'usageColumns.heatRetention': {
    zh: '记录以前只留 90 天，现在留 400 天，会从现在开始慢慢攒满。',
    en: 'Records used to be kept for 90 days. They are now kept for 400, so this fills up over time.',
  },
  'usageColumns.heatSpeed': {
    zh: '速度从这个版本开始记，更早的日子是空的。',
    en: 'Speed is recorded from this version on, so earlier days are empty.',
  },
  'usageColumns.today': { zh: '今天 {p0} · {p1} 轮', en: 'Today {p0} · {p1} turns' },
  'usageCost.dimension': { zh: '费用情况', en: 'Cost status' },
  'usageCost.missing': { zh: '没有费用', en: 'Cost not recorded' },
  'usageCost.known': { zh: '有费用', en: 'Has cost' },
  'usageCost.pending': { zh: '等平台结算', en: 'Awaiting settlement' },
  'usageCost.empty': { zh: '没用到 token', en: 'No tokens used' },
  'usageCost.platform': { zh: '平台账单没对上', en: 'Not matched in platform bill' },
  'usageCost.noPrice': { zh: '对不上官方价格', en: 'No official price' },
  'usageCost.engine': { zh: '引擎没报费用', en: 'Not reported by engine' },
  'usageCost.knownHint': { zh: '这些记录有费用', en: 'These records have a cost' },
  'usageCost.missingHint': { zh: '所有没有费用的记录', en: 'All records without a cost' },
  'usageCost.pendingHint': {
    zh: '平台账单还没出来，稍后会自动补上',
    en: "The platform bill isn't ready yet; the cost fills in automatically",
  },
  'usageCost.emptyHint': {
    zh: '这一轮一开始就中断或出错，没有用到 token',
    en: 'The turn stopped or failed before using any tokens',
  },
  'usageCost.platformHint': {
    zh: '像素星空账单里没对上这次扣费，不拿估算代替。登录当时用的账号后会自动按时间补录；补录也没对上的，可以在「账号调用」里核对',
    en: 'No matching charge in the PixelSky bill, and no estimate is substituted. Sign in with the account used at the time and it is backfilled by time; if that fails too, check Account requests',
  },
  'usageCost.noPriceHint': {
    zh: '这个模型对不上官方价格，只记了 token。可以在接口设置里给它选「计价参照」，之后的调用会按它估算',
    en: 'This model has no official price, so only tokens are recorded. Set a pricing reference in the endpoint settings and later calls are estimated with it',
  },
  'usageCost.engineHint': {
    zh: '引擎没报费用（例如 Codex），只记了 token',
    en: "The engine didn't report a cost (e.g. Codex); only tokens are recorded",
  },
  'usageCost.kpiMissingTitle': {
    zh: '点一下只看这些记录，分布表按原因分开',
    en: 'Show only these records, split by reason in the distribution',
  },
  'usageCost.reason': { zh: '没有费用的原因', en: 'Why no cost' },
}
