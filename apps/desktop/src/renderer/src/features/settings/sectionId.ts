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
  /** 本机数据目录的占用和清理 */
  | 'storage'

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
  'storage',
])

/** 是不是设置的分区名（独立窗口从地址、主进程推送里收到的是字符串） */
export const isSectionId = (value: unknown): value is SectionId => typeof value === 'string' && IDS.has(value)
