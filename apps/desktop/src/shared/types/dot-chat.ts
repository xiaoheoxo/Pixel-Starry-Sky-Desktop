import type { SessionSnapshot } from '@pixelsky/protocol'
import type { DotProfile, DotHistoryPage, DotOverview } from '@pixelsky/engine'

export interface DotEntry extends DotProfile {
  key: string
  account: string
  accountName: string
  id: string
  threadId: string
  name: string
  status: string
}
export interface DotChatRead {
  entry: DotEntry
  history: DotHistoryPage
  overview?: DotOverview
}
export interface DotCatalogState {
  eligible: boolean
  entries: DotEntry[]
  errors: string[]
  /** 有没看过的新消息的 Dot（键） */
  unread: string[]
}
/**
 * 主进程推给界面的未读变化（docs/ui/dot-optimize.md §7 #3）。notice：这次新到、还没提醒过的那条，
 * 弹不弹系统通知由界面按通知偏好决定
 */
export interface DotChatChange {
  unread: string[]
  notice?: { key: string; sessionId: string; name: string; messageId: string; preview: string }
}
/** 拖进来、粘贴的文件：有本机路径的给路径；没有的（剪贴板截图）给内容，主进程存成临时文件 */
export type DotDroppedFile = { path: string } | { name: string; dataBase64: string }
export interface DotChatBridge {
  open(key?: string): Promise<void>
  catalog(refresh?: boolean): Promise<DotCatalogState>
  snapshot(key: string): Promise<SessionSnapshot>
  send(key: string, sessionId: string, text: string, files?: string[]): Promise<void>
  /** seen：用户正看着这个对话（标签可见、窗口在前台），读到的消息算看过 */
  read(
    key: string,
    options?: { before?: string; after?: string; overview?: boolean; overviewOnly?: boolean; seen?: boolean },
  ): Promise<DotChatRead>
  pickFiles(key: string): Promise<DotLocalFile[]>
  addFiles(key: string, files: DotDroppedFile[]): Promise<DotLocalFile[]>
  onChange(callback: (change: DotChatChange) => void): () => void
  file(key: string, fileId: string): Promise<DotRemoteFile>
  saveFile(key: string, fileId: string): Promise<boolean>
  computerOffer(key: string, offer: string): Promise<string>
}

export interface DotLocalFile {
  id: string
  name: string
  bytes: number
}
export interface DotRemoteFile {
  name: string
  mime: string
  dataBase64: string
}
