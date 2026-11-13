// 极简模式和「极夜」配色（docs/ui/minimal-mode.md）
export const minimalModeMessages = {
  'minimal.setting': { zh: '极简模式', en: 'Minimal mode' },
  'minimal.settingHint': {
    zh: '去掉阴影和多余装饰，字小一号、行距更紧；用户消息改成整行浅色块，顶栏导航只留图标，侧栏收起最近任务，输入框上方的项目和 Git 鼠标移过去才显示。配色另选，搭配「极夜」最像 Factory',
    en: 'Drops shadows and extra decoration, with slightly smaller text and tighter spacing. Your messages become full-width blocks, top bar navigation shows icons only, the sidebar hides recent tasks, and the project and Git bar above the composer appears on hover. Pick a palette separately; Midnight looks closest to Factory',
  },
  'minimal.on': { zh: '开启', en: 'On' },
  'minimal.off': { zh: '关闭', en: 'Off' },
  'workbenchFrame.setting': { zh: '工作区边框', en: 'Workspace frame' },
  'workbenchFrame.settingHint': {
    zh: '两块独立：对话区和右栏各是一张圆角面板，中间留一条缝；一条线：不留缝，中间只画一条细线',
    en: 'Separate panels: the conversation and right panel are rounded panels with a gap between; Single line: no gap, just a thin line between them',
  },
  'workbenchFrame.block': { zh: '两块独立', en: 'Separate panels' },
  'workbenchFrame.line': { zh: '一条线', en: 'Single line' },
  'minimal.paletteMidnight': { zh: '极夜', en: 'Midnight' },
  'minimal.plan.title': { zh: '正在进行… {done}/{total}', en: 'In progress… {done}/{total}' },
  'minimal.plan.pressBefore': { zh: '按', en: 'Press' },
  'minimal.plan.pressAfter': { zh: '中断', en: 'to interrupt' },
} as const
