// 完全放行的二次确认（每次都确认）与启用后输入框上方的提示条
export const fullAccessMessages = {
  'fullAccess.confirm.title': { zh: '这个对话完全放行？', en: 'Give this conversation full access?' },
  'fullAccess.confirm.newTitle': { zh: '这个任务完全放行？', en: 'Give this task full access?' },
  'fullAccess.confirm.noAsk': {
    zh: '运行命令、改文件、删文件都不再问你',
    en: 'Commands, edits and deletions all run without asking',
  },
  'fullAccess.confirm.claude': {
    zh: 'Claude Code 会跳过所有权限检查',
    en: 'Claude Code skips every permission check',
  },
  'fullAccess.confirm.codex': {
    zh: 'Codex 会关掉沙箱，能读写整台电脑、联网',
    en: 'Codex turns off its sandbox and can read, write and use the network anywhere',
  },
  'fullAccess.confirm.pixel': {
    zh: 'Pixel agent 会跳过所有权限检查',
    en: 'The Pixel agent skips every permission check',
  },
  'fullAccess.confirm.scope': {
    zh: '只管这个对话，新任务还是「{p0}」',
    en: 'Only this conversation; new tasks still use "{p0}"',
  },
  'fullAccess.confirm.scopeNew': {
    zh: '只管这个任务，以后的新任务还是「{p0}」',
    en: 'Only this task; later new tasks still use "{p0}"',
  },
  'fullAccess.confirm.hideStrip': { zh: '启用后不在输入框上方提示', en: "Don't show the banner above the input" },
  'fullAccess.confirm.hideStripScope': { zh: '所有对话，30 天', en: 'all conversations, 30 days' },
  'fullAccess.confirm.allowThis': {
    zh: '会允许这次操作，之后运行命令、改文件、删文件都不再问你',
    en: 'Allows this request; later commands, edits and deletions run without asking',
  },
  'fullAccess.confirm.scopeCard': {
    zh: '只管这个对话，随时可以在输入框的权限菜单里改回',
    en: 'Only this conversation; switch back anytime from the permission menu',
  },
  'fullAccess.confirm.back': { zh: '返回', en: 'Back' },
  'fullAccess.confirm.allowThisOk': { zh: '允许这次并完全放行', en: 'Allow and give full access' },
  'fullAccess.confirm.cancel': { zh: '取消', en: 'Cancel' },
  'fullAccess.confirm.ok': { zh: '完全放行', en: 'Allow everything' },

  'fullAccess.strip': {
    zh: '这个对话完全放行：命令、改文件、删文件都不再问你',
    en: 'Full access: commands, edits and deletions run without asking',
  },
  'fullAccess.stripNew': {
    zh: '这个任务完全放行：命令、改文件、删文件都不再问你',
    en: 'Full access for this task: commands, edits and deletions run without asking',
  },
  'fullAccess.revert': { zh: '改回{p0}', en: 'Switch to {p0}' },
  'fullAccess.dismissStrip': { zh: '不再提示', en: 'Dismiss' },

  'fullAccess.default.title': { zh: '以后的新任务都完全放行？', en: 'Start every new task with full access?' },
  'fullAccess.default.body': {
    zh: '{p0} 的新任务一开始就不问你：运行命令、改文件、删文件都直接做。',
    en: 'New {p0} tasks start without asking: commands, edits and deletions just run.',
  },
  'fullAccess.default.note': {
    zh: '已经开始的对话不变。随时可以在这里改回来。',
    en: "Conversations already started don't change. You can switch back here anytime.",
  },
  'fullAccess.default.ok': { zh: '新任务默认完全放行', en: 'Default to full access' },

  'fullAccess.setting.title': { zh: '完全放行时在输入框上方提示', en: 'Show a banner when full access is on' },
  'fullAccess.setting.desc': {
    zh: '关掉后所有对话都不显示，30 天后自动打开；切到完全放行前的确认不受影响',
    en: 'When off, no conversation shows it; it turns back on after 30 days. The confirmation before full access always appears',
  },
  'fullAccess.setting.keywords': {
    zh: '完全放行 权限 提示 不再提示 提示条 危险 full access permission banner warning dismiss',
    en: 'full access permission banner warning dismiss dangerous',
  },
} as const
