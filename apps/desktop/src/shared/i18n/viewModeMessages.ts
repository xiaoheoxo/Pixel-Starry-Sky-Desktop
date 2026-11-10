// 对话查看模式（docs/ui/view-mode.md）
export const viewModeMessages = {
  'viewMode.cycle': { zh: '切换对话查看模式', en: 'Cycle conversation view mode' },
  'viewMode.title': { zh: '查看模式', en: 'View mode' },
  'viewMode.buttonLabel': { zh: '查看模式：{mode}', en: 'View mode: {mode}' },
  'viewMode.buttonTitle': { zh: '查看模式：{mode}（{key}）', en: 'View mode: {mode} ({key})' },
  'viewMode.normal': { zh: '普通', en: 'Normal' },
  'viewMode.thinking': { zh: '思考', en: 'Thinking' },
  'viewMode.detailed': { zh: '详细', en: 'Detailed' },
  'viewMode.normalHint': { zh: '每轮的过程收成一行', en: 'Each turn’s steps fold into one line' },
  'viewMode.thinkingHint': {
    zh: '思考全文按先后显示，工具收成一行',
    en: 'Full thinking in order, tools grouped into one line',
  },
  'viewMode.detailedHint': { zh: '工具和输出全部展开', en: 'All tools and output expanded' },
  'viewMode.footer': { zh: '{key} 循环切换 · 所有窗格一起变', en: '{key} to cycle · applies to all panes' },
  'viewMode.toast': { zh: '{mode} · {hint} · {key}', en: '{mode} · {hint} · {key}' },
  'viewMode.paletteNormal': { zh: '查看模式：普通', en: 'View mode: Normal' },
  'viewMode.paletteThinking': { zh: '查看模式：思考', en: 'View mode: Thinking' },
  'viewMode.paletteDetailed': { zh: '查看模式：详细', en: 'View mode: Detailed' },
  'viewMode.noThinking': {
    zh: '这个会话没开思考摘要，思考只显示用时。',
    en: 'Thinking summaries are off for this session, so only the duration is shown.',
  },
  'viewMode.noThinkingUnsupported': {
    zh: '当前引擎不提供思考内容，思考只显示用时。',
    en: 'This engine doesn’t provide thinking text, so only the duration is shown.',
  },
  'viewMode.enableThinking': { zh: '下一轮开启', en: 'Turn on from next turn' },
  'viewMode.showMore': { zh: '展开', en: 'Expand' },
} as const
