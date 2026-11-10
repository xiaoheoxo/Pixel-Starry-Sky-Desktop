// 本机多 AI 协作剩下几项（docs/ui/channels-local-rest.md）
export const agentsSettingsMessages = {
  'agentsSettings.title': { zh: 'AI 成员', en: 'AI members' },
  'agentsSettings.hint': {
    zh: '频道里用到的 AI 成员都在这里。删除后从所有频道里去掉，不能撤销。',
    en: 'All AI members used in channels. Deleting removes them from every channel and cannot be undone.',
  },
  'agentsSettings.empty': {
    zh: '还没有 AI 成员，在频道的成员面板里添加。',
    en: 'No AI members yet. Add them from a channel’s member panel.',
  },
  'agentsSettings.bound': { zh: '从已有会话加入', en: 'Joined from a session' },
  'agentsSettings.channels': { zh: '在 {n} 个频道里', en: 'In {n} channels' },
  'agentsSettings.delete': { zh: '删除', en: 'Delete' },
  'agentsSettings.deleteTitle': { zh: '删除 AI 成员「{name}」？', en: 'Delete AI member “{name}”?' },
  'agentsSettings.deleteBody': {
    zh: '从所有频道里去掉这个成员，它做过的任务卡和会话保留。有没做完的活或没结束的流程时不能删。',
    en: 'Removes this member from every channel. Its task cards and sessions are kept. Not allowed while it has unfinished work or workflows.',
  },
  'agentsSettings.deleteBodyBound': {
    zh: '只去掉成员，绑定的会话保留。',
    en: 'Only the member is removed; the linked session is kept.',
  },
  'agentsSettings.searchKeywords': { zh: 'AI 成员 频道 删除成员 agent member', en: 'AI member channel delete agent' },
} as const
