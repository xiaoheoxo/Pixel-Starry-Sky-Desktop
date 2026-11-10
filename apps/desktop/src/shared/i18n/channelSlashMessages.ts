// 本机多 AI 协作剩下几项（docs/ui/channels-local-rest.md）
export const channelSlashMessages = {
  // 频道输入框的斜杠命令（§3.3 a）：名字中英两套都认，菜单里按界面语言显示
  'channels.slash.label': { zh: '频道命令', en: 'Channel commands' },
  'channels.slash.flow': { zh: '流程', en: 'flow' },
  'channels.slash.flow.desc': {
    zh: '新建一条流程，后面接着写标题',
    en: 'Create a flow; type its title after the command',
  },
  'channels.slash.archive': { zh: '归档', en: 'archive' },
  'channels.slash.archive.desc': { zh: '归档这个频道', en: 'Archive this channel' },
  'channels.slash.pin': { zh: '置顶', en: 'pin' },
  'channels.slash.pin.desc': {
    zh: '置顶正在引用的消息，没引用时置顶最后一条',
    en: 'Pin the quoted message, or the latest one',
  },
  'channels.slash.notify': { zh: '提醒', en: 'alerts' },
  'channels.slash.notify.desc': { zh: '改这个频道的提醒', en: 'Change alerts for this channel' },
  'channels.slash.members': { zh: '成员', en: 'members' },
  'channels.slash.members.desc': { zh: '打开成员面板', en: 'Open the members panel' },
  'channels.slash.digest': { zh: '简报', en: 'digest' },
  'channels.slash.digest.desc': {
    zh: '让牵头成员写一份今天的简报（会花 token）',
    en: 'Ask the lead to write today’s digest (uses tokens)',
  },
  'channels.slash.flowTitle': { zh: '新流程', en: 'New flow' },
  'channels.slash.pinned': { zh: '这条消息已经置顶了', en: 'This message is already pinned' },
  'channels.slash.nothingToPin': { zh: '没有可以置顶的消息', en: 'There’s no message to pin' },
  'channels.slash.digestRequest': {
    zh: '/简报 @{name} 写一份今天的频道简报（完成 / 失败 / 等我处理的）',
    en: '/digest @{name} write a digest of today in this channel (done / failed / waiting on me)',
  },
} as const
