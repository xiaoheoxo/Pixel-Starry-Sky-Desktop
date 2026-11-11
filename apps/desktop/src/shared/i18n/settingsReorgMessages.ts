// 设置页重新分组（docs/ui/settings-reorg.md）：导航的组名、三个新页和新加的小标题
export const settingsReorgMessages = {
  'settingsNav.group.account': { zh: '账号', en: 'Account' },
  'settingsNav.group.workspace': { zh: '工作区', en: 'Workspace' },
  'settingsNav.group.ai': { zh: 'AI', en: 'AI' },
  'settingsNav.group.connect': { zh: '连接', en: 'Connections' },
  'settingsNav.general': { zh: '通用', en: 'General' },
  // 英文和侧栏的「对话」（sidebar.Sidebar.chats）一样：搜索结果按中文反查英文，两个不一样就会一处 Chats 一处 Conversation
  'settingsNav.chat': { zh: '对话', en: 'Chats' },
  'settingsNav.assist': { zh: 'AI 辅助', en: 'AI assist' },
  'settingsNav.terminal': { zh: '终端', en: 'Terminal' },
  'settingsChat.composer': { zh: '输入框', en: 'Composer' },
  'settingsChat.messages': { zh: '消息和回复', en: 'Messages and replies' },
  'settingsChat.long': { zh: '长对话', en: 'Long conversations' },
  'settingsChat.running': { zh: '运行', en: 'While running' },
  'settingsChat.tips': { zh: '提示', en: 'Tips' },
  'settingsAppearance.theme': { zh: '主题与配色', en: 'Theme and colors' },
  'settingsAppearance.wallpaper': { zh: '壁纸与毛玻璃', en: 'Wallpaper and glass' },
  'settingsAppearance.motion': { zh: '动画', en: 'Motion' },
  'settingsEngines.shared': { zh: '所有引擎通用', en: 'All engines' },
  'settingsEngines.codexSession': { zh: '会话', en: 'Sessions' },
  'settingsEngines.factoryNoUltracode': {
    zh: '推理强度 High，Fast 关，显示思考摘要开',
    en: 'Effort High, Fast off, thinking summaries on',
  },
  'settingsEngines.factoryBasic': { zh: '推理强度 High，Fast 关', en: 'Effort High, Fast off' },
  'settingsMobile.advanced': { zh: '高级', en: 'Advanced' },
  'settingsAssist.channel': { zh: '共用的通道', en: 'Shared channel' },
  'settingsAssist.channelHint': {
    zh: 'AI 写提交信息、优化提示词、行内编辑、频道成员快速填写共用这一条。',
    en: 'AI commit messages, prompt rewriting, inline edits and channel member quick fill all use this channel.',
  },
  'settingsAssist.noChannel': {
    zh: '还没有能用的通道，先到「模型通道」里设置一条。',
    en: 'No channel is ready yet. Set one up in Model channels first.',
  },
  'settingsAssist.openChannels': { zh: '打开模型通道', en: 'Open model channels' },
  'settingsAssist.commit': { zh: 'AI 写提交信息', en: 'AI commit messages' },
  'settingsAssist.prompt': { zh: '优化提示词', en: 'Prompt rewriting' },
  'settingsStorage.settingsPath': { zh: '设置和登录信息', en: 'Settings and sign-in data' },
  'settingsStorage.dataPath': { zh: '对话数据', en: 'Conversation data' },
  'settingsAgents.manage': { zh: '管理 AI 成员', en: 'Manage AI members' },
  'settingsAgents.done': { zh: '完成', en: 'Done' },
  // 设置搜索的关键词（中英文放在一起，搜索时两种都匹配）
  'settingsSearch.k1': {
    zh: '通用 常规 语言 托盘 睡眠 更新 general language',
    en: '通用 常规 语言 托盘 睡眠 更新 general language',
  },
  'settingsSearch.k2': {
    zh: '更新内容 更新说明 新功能 弹窗 whats new changelog release notes',
    en: '更新内容 更新说明 新功能 弹窗 whats new changelog release notes',
  },
  'settingsSearch.k3': {
    zh: '测试版 预发布 尝鲜 正式版 beta prerelease',
    en: '测试版 预发布 尝鲜 正式版 beta prerelease',
  },
  'settingsSearch.k4': {
    zh: '对话 会话 输入框 消息 回复 conversation chat composer',
    en: '对话 会话 输入框 消息 回复 conversation chat composer',
  },
  'settingsSearch.k5': { zh: '滚动条 轮次 刻度 scrollbar turns rail', en: '滚动条 轮次 刻度 scrollbar turns rail' },
  'settingsSearch.k6': {
    zh: 'AI 辅助 提交信息 优化 提示词 语音 assist commit prompt voice',
    en: 'AI 辅助 提交信息 优化 提示词 语音 assist commit prompt voice',
  },
  'settingsSearch.k7': {
    zh: '通道 提交信息 优化提示词 行内编辑 模型 channel',
    en: '通道 提交信息 优化提示词 行内编辑 模型 channel',
  },
  'settingsSearch.k8': {
    zh: 'AI 写提交信息 提交说明 commit message git 按钮',
    en: 'AI 写提交信息 提交说明 commit message git 按钮',
  },
  'settingsSearch.k9': {
    zh: '优化提示词 改写 润色 prompt improve optimize rewrite',
    en: '优化提示词 改写 润色 prompt improve optimize rewrite',
  },
  'settingsSearch.k10': {
    zh: '模型菜单 标签页 两栏 排法 model menu tabs columns',
    en: '模型菜单 标签页 两栏 排法 model menu tabs columns',
  },
  'settingsSearch.k11': {
    zh: '扣费 Key 密钥 我的 Key 自动 billing key',
    en: '扣费 Key 密钥 我的 Key 自动 billing key',
  },
  'settingsSearch.k12': {
    zh: 'Codex 子智能体 模型 推理强度 subagent model effort',
    en: 'Codex 子智能体 模型 推理强度 subagent model effort',
  },
  'settingsSearch.k13': { zh: '模板 新建类型 子智能体 template', en: '模板 新建类型 子智能体 template' },
  'settingsSearch.k14': { zh: '回滚 行数 往上翻 历史 scrollback lines', en: '回滚 行数 往上翻 历史 scrollback lines' },
  'settingsSearch.k15': {
    zh: '读屏 无障碍 屏幕阅读器 screen reader accessibility',
    en: '读屏 无障碍 屏幕阅读器 screen reader accessibility',
  },
  'settingsSearch.k16': {
    zh: '编码 乱码 UTF-8 GBK 代码页 encoding codepage',
    en: '编码 乱码 UTF-8 GBK 代码页 encoding codepage',
  },
} as const
