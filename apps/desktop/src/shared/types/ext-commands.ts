// 脚本扩展的命令（docs/ui/extension-commands-plan.md）：渲染层和主进程之间的数据

export type ExtCommandFailure =
  /** 没响应，超过时间被停掉 */
  | 'timeout'
  /** 占内存太多被停掉 */
  | 'memory'
  /** 进程崩了 */
  | 'crashed'
  /** 脚本起不来（语法错误、顶层抛错） */
  | 'loadFailed'
  /** 命令里抛错 */
  | 'thrown'
  /** 不合规的调用，被停掉 */
  | 'badCall'
  /** 这个扩展的上一条命令还在跑 */
  | 'busy'
  /** 扩展停用、卸载了，或者命令不存在 */
  | 'unavailable'
  /** 扩展被停用、更新或卸载，运行中的命令被停掉 */
  | 'stopped'

export type ExtCommandOutcome =
  | { status: 'done' }
  /** 还没同意这些权限：同意后再运行一次 */
  | { status: 'needsConsent'; permissions: string[] }
  | { status: 'failed'; code: ExtCommandFailure; detail?: string }

export interface ExtCommandRunRequest {
  key: string
  commandId: string
  /** 渲染层给这次运行起的号：之后的编辑器、对话框调用都带着它 */
  token: string
}

/** 主进程转给窗口完成的调用（编辑器、对话框） */
export interface ExtCommandApiCall {
  callId: number
  token: string
  method: string
  args: unknown[]
}

export type ExtCommandApiReply = { ok: true; value?: unknown } | { ok: false; message: string }
