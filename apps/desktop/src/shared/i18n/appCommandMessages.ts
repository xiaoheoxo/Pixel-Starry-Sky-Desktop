// 「/」菜单里像素星空自己处理的 Codex 命令（docs/ui/codex-flow-slash-feedback.md B）：分组名、每条的说明、执行不了时的提示
export const appCommandMessages = {
  'appCommand.group.chat': { zh: '对话', en: 'Conversation' },
  'appCommand.group.mode': { zh: '模型与模式', en: 'Model and mode' },
  'appCommand.group.view': { zh: '查看', en: 'View' },
  'appCommand.new': { zh: '在同一项目里开新对话', en: 'Start a new conversation in this project' },
  'appCommand.fork': { zh: '从这里开分支', en: 'Branch this conversation from here' },
  'appCommand.side': {
    zh: '旁聊：临时问一句，不影响主对话',
    en: 'Side chat: ask a quick question without affecting this conversation',
  },
  'appCommand.archive': { zh: '归档这个对话', en: 'Archive this conversation' },
  'appCommand.model': { zh: '换模型', en: 'Change the model' },
  'appCommand.effort': { zh: '调推理强度', en: 'Change the reasoning effort' },
  'appCommand.fastOn': { zh: '打开 Fast：更快，用量更多', en: 'Turn on Fast: faster, uses more' },
  'appCommand.fastOff': { zh: '关掉 Fast', en: 'Turn off Fast' },
  'appCommand.planOn': {
    zh: '切到计划模式：先出计划，确认后再改',
    en: 'Switch to plan mode: plan first, change after you confirm',
  },
  'appCommand.planOff': { zh: '退出计划模式', en: 'Leave plan mode' },
  'appCommand.status': { zh: '上下文用量和额度（打开右栏概况）', en: 'Context usage and quota (opens Overview)' },
  'appCommand.mcp': { zh: 'MCP 服务器状态（打开右栏概况）', en: 'MCP server status (opens Overview)' },
  'appCommand.feedback': { zh: '给像素星空提反馈', en: 'Send feedback about Pixel Starry Sky' },
  'appCommand.fastUnavailable': { zh: '现在开不了 Fast', en: 'Fast isn’t available right now' },
} as const
