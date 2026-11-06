// 进度卡片里子智能体下面那一行「正在做什么」（docs/ui/progress-card.md §9）
export const progressLineMessages = {
  'progressLine.task': { zh: '任务：{text}', en: 'Task: {text}' },
  'progressLine.done': { zh: '完成：{text}', en: 'Done: {text}' },
  'progressLine.failed': { zh: '失败：{text}', en: 'Failed: {text}' },
  'progressLine.stoppedAt': { zh: '停下时在：{text}', en: 'Stopped while: {text}' },
  'progressLine.recent': { zh: '最近：', en: 'Recent:' },
  'progressLine.justNow': { zh: '刚刚', en: 'just now' },
  'progressLine.secondsAgo': { zh: '{n} 秒前', en: '{n}s ago' },
  'progressLine.minutesAgo': { zh: '{n} 分钟前', en: '{n}m ago' },
  // 频道里做完的一步（docs/ui/channels-live-activity.md）；还在跑的用 session.live.verb.*
  'progressLine.verb.command': { zh: '运行', en: 'Ran' },
  'progressLine.verb.edit': { zh: '修改', en: 'Edited' },
  'progressLine.verb.create': { zh: '新建', en: 'Created' },
  'progressLine.verb.read': { zh: '读取', en: 'Read' },
  'progressLine.verb.search': { zh: '搜索', en: 'Searched' },
  'progressLine.verb.web': { zh: '浏览', en: 'Browsed' },
  'progressLine.readFiles': { zh: '读取 {n} 个文件', en: 'Read {n} files' },
  'progressLine.andMore': { zh: '{names} 等', en: '{names}, …' },
  'progressLine.exitCode': { zh: '退出码 {code}', en: 'exit {code}' },
} as const satisfies Record<string, { zh: string; en: string }>
