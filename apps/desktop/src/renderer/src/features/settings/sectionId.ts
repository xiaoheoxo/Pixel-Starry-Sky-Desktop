// 设置的分区名：单独放一个小文件，首屏的 SettingsProvider 不用为了它把整个设置界面（SettingsContent）一起加载（性能审核 B10）
export type SectionId =
  | 'account'
  | 'models'
  /** 像素星空引擎的子智能体走哪个站点（docs/ui/subagent-routing.md） */
  | 'subagents'
  | 'engines'
  | 'usage'
  | 'appearance'
  | 'shortcuts'
  | 'about'
  | 'editor'
  | 'projects'
  | 'extensions'
  /** 旧名：以前的「插件配置」，现在是扩展页的 AI 引擎分组；老入口（输入框里的链接）仍用它 */
  | 'plugins'
  | 'terminal'
  | 'machines'
  | 'notifications'
  | 'logs'
  | 'feedback'
  | 'mobile'
  /** 消息通道：在 QQ、微信里指挥 AI */
  | 'im'
  /** 本机数据目录的占用和清理 */
  | 'storage'
  /** 旧入口：导航里没有了，AI 成员改在频道页管理（docs/ui/settings-reorg.md） */
  | 'agents'
  /** 通用：语言、关窗口、睡眠、更新；打开设置默认停在这里 */
  | 'general'
  /** 对话：输入框、消息、长对话、提示 */
  | 'chat'
  /** AI 辅助：AI 写提交信息、优化提示词、语音输入 */
  | 'assist'

const IDS: ReadonlySet<string> = new Set<SectionId>([
  'account',
  'models',
  'subagents',
  'engines',
  'usage',
  'appearance',
  'shortcuts',
  'about',
  'editor',
  'projects',
  'extensions',
  'plugins',
  'terminal',
  'machines',
  'notifications',
  'logs',
  'feedback',
  'mobile',
  'im',
  'storage',
  'agents',
  'general',
  'chat',
  'assist',
])

/** 是不是设置的分区名（独立窗口从地址、主进程推送里收到的是字符串） */
export const isSectionId = (value: unknown): value is SectionId => typeof value === 'string' && IDS.has(value)
