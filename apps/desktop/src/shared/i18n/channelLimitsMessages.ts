// 本机多 AI 协作剩下几项（docs/ui/channels-local-rest.md）
export const channelLimitsMessages = {
  'channels.limits.maxRejects': { zh: '审查打回上限', en: 'Review rejection limit' },
  'channels.limits.maxRejectsHint': {
    zh: '流程里同一步被打回这么多次后停下等你；只影响之后新建的流程',
    en: 'A workflow step pauses for you after this many rejections; applies to new workflows only',
  },
  'channels.limits.rejectTimes': { zh: '打回 {n} 次后停下', en: 'Pause after {n} rejections' },
  'alerts.stalledAfter': { zh: '超过 {n} 分钟没动静', en: 'Quiet for over {n} min' },
} as const
