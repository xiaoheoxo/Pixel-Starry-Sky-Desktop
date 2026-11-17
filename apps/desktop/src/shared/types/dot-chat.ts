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
}
export interface DotChatBridge {
  open(key?: string): Promise<void>
  catalog(refresh?: boolean): Promise<DotCatalogState>
  snapshot(key: string): Promise<SessionSnapshot>
  send(key: string, sessionId: string, text: string, files?: string[]): Promise<void>
  read(key: string, options?: { before?: string; overview?: boolean }): Promise<DotChatRead>
  pickFiles(key: string): Promise<DotLocalFile[]>
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
