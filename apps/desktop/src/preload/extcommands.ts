import type { ExtCommandApiCall, ExtCommandApiReply, ExtCommandOutcome } from '../shared/types/ext-commands'

/** 脚本扩展的命令（docs/ui/extension-commands-plan.md §4） */
export interface ExtCommandsBridge {
  run(key: string, commandId: string, token: string): Promise<ExtCommandOutcome>
  apiReply(callId: number, reply: ExtCommandApiReply): Promise<void>
  /** 同意用户在确认框里看到的这几项权限 */
  grant(key: string, permissions: string[]): Promise<void>
  revoke(key: string, permission: string): Promise<void>
  onApi(callback: (call: ExtCommandApiCall) => void): () => void
  /** 这次运行结束：关掉它还开着的对话框 */
  onFinished(callback: (token: string) => void): () => void
}
