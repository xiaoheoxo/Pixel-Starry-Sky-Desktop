// 「关于」页用的应用信息：主进程提供，规格见 docs/ui/settings.md §5

import type { AppInfo, AppLink, WhatsNewPatch, WhatsNewState } from '../shared/types/app-info'

export interface AppInfoBridge {
  getInfo(): Promise<AppInfo>
  open(link: AppLink): Promise<void>
  /** 更新后的「更新内容」弹窗：要不要弹、是否关了提示 */
  whatsNew(): Promise<WhatsNewState>
  /** seen：这一版看过了；muted：「不再提示」开关；via、from 只写日志 */
  setWhatsNew(patch: WhatsNewPatch): Promise<void>
  /** 新页面报到（docs/ui/renderer-memory.md §3.1.2）：在订阅引擎事件之后、拉列表和快照之前调；主进程收到后才恢复往这个页面推送 */
  ready(): Promise<void>
}
