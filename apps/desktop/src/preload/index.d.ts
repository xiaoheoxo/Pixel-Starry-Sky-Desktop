import type { AccountBridge } from './account'
import type { AppInfoBridge } from './app-info'
import type { UpdateBridge } from './update'
import type { EngineBridge } from './engine'
import type { PlatformCatalogBridge } from './platform-catalog'
import type { ProvidersBridge } from './providers'
import type { EditorBridge, FilesBridge } from './workspace'
import type { WindowBridge } from './window'
import type { ExtensionsBridge } from './extensions'
import type { ExtPacksBridge } from './extpacks'
import type { ExtStoreBridge } from './extstore'
import type { ProjectToolsBridge } from './project-tools'
import type { TerminalBridge } from './terminal'
import type { NotificationsBridge } from './notifications'
import type { ArtifactsBridge } from './artifacts'
import type { ExportBridge } from './export'
import type { LogBridge } from './log'

export type * from './account'
export type * from './app-info'
export type * from './engine'
export type * from './project-tools'
export type * from './terminal'
export type * from './notifications'
export type * from './artifacts'
export type * from './export'
export type * from './providers'
export type * from './log'
export type * from './feedback'

export interface PixelskyBridge {
  machines: import('./machines').MachineBridge
  extensions: ExtensionsBridge
  /** 扩展包（语法 / 主题 / 图标 / 片段 / 任务 / 技能 / 提示词） */
  extpacks: ExtPacksBridge
  extstore: ExtStoreBridge
  platform: NodeJS.Platform | string
  /** 拖进来 / 粘贴的文件在磁盘上的路径（GitHub #15）；不是本机文件时为空字符串 */
  pathForFile(file: File): string
  demo: boolean
  /** 同步窗口底色；transparent 仅供其他平台的原生覆盖层使用 */
  /** background：配色主题的实色底（#rrggbb），不传用默认暖灰 */
  setTheme: (theme: 'light' | 'dark', transparent?: boolean, background?: string) => void
  setLocale: (locale: 'zh-CN' | 'en-US') => Promise<void>
  /** 账号登录与额度（docs/ui/account.md） */
  account: AccountBridge
  /** 引擎系统：项目、会话、对话（docs/engines.md） */
  engine: EngineBridge
  platformCatalog: PlatformCatalogBridge
  /** 自定义 API 的接口配置（docs/ui/custom-api.md） */
  providers: ProvidersBridge
  sessionStatus: import('../shared/types/session-status').SessionStatusBridge
  /** 设置 › 子智能体（docs/ui/subagent-routing.md） */
  subagents: import('../shared/types/subagents').SubagentsBridge
  /** 账号额度（docs/ui/account-quota.md） */
  quota: import('../shared/types/quota').QuotaBridge
  /** AI 写提交信息（docs/ui/ai-commit-codex-warnings-history.md §2） */
  ai: import('./ai').AiBridge
  /** 「关于」页：版本与运行环境（docs/ui/settings.md §5） */
  app: AppInfoBridge
  /** 本机日志（docs/ui/logging.md） */
  log: LogBridge
  /** 设置 › 存储：本机数据目录的占用和清理 */
  storage: import('../shared/types/storage').StorageBridge
  /** 自动更新（docs/release-update.md §7） */
  update: UpdateBridge
  files: FilesBridge
  editor: EditorBridge
  window: WindowBridge
  projectTools: ProjectToolsBridge
  projectBrowser: import('./project-browser').BrowserBridge
  terminal: TerminalBridge
  /** 系统通知（docs/ui/notifications.md） */
  notifications: NotificationsBridge
  /** 设置云同步（docs/ui/settings-sync.md） */
  settingsSync: import('./settings-sync').SettingsSyncBridge
  /** 设置 › 反馈（docs/ui/feedback.md） */
  feedback: import('./feedback').FeedbackBridge
  /** 系统托盘（docs/ui/tray.md） */
  tray: import('./tray').TrayBridge
  /** 设置独立窗口（docs/ui/settings-window.md） */
  settingsWindow: import('./settings-window').SettingsWindowBridge
  /** 手机远程连接（docs/mobile-remote.md） */
  mobile: import('./mobile').MobileBridge
  /** 协作频道（docs/ui/channels-phase-b.md） */
  channels: import('./channels').ChannelsBridge
  /** 产物面板（docs/ui/artifacts-panel.md） */
  artifacts: ArtifactsBridge
  /** 导出对话（docs/ui/conversation-export.md） */
  conversationExport: ExportBridge
}

declare global {
  interface Window {
    pixelsky?: PixelskyBridge
    /** 截图模式用：直接切换主题（见 src/main/index.ts） */
    __pixelskySetTheme?: (theme: 'light' | 'dark') => void
  }
}
