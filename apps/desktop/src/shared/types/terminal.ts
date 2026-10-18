export type TerminalStatus = 'stopped' | 'starting' | 'running' | 'exited' | 'error'
export interface TerminalProfile {
  id: string
  label: string
  command: string
  args: string[]
  available: boolean
  custom?: boolean
}
export interface TerminalRecord {
  id: string
  projectId: string
  projectName: string
  cwd: string
  profileId: string
  profileLabel: string
  title: string
  titleEdited: boolean
  status: TerminalStatus
  exitCode?: number
  error?: string
  generation: number
  createdAt: number
  lastStartedAt?: number
}
export type TerminalEvent =
  | { type: 'data'; terminalId: string; generation: number; seq: number; data: string }
  | { type: 'record'; record: TerminalRecord }
  /**
   * 提示符回来了（shell 集成：我们给自己开的 shell 注入的 OSC 标记，已从输出里剥掉）。
   * ran：true = 刚有一条命令结束；false = 没跑过命令（第一个提示符、清屏重画）；null = 这种 shell 不报告（cmd）。
   * exitCode：刚结束那条命令的退出码，不知道为 null
   */
  | { type: 'prompt'; terminalId: string; generation: number; ran: boolean | null; exitCode: number | null }
  /** 后台检测完 Shell 列表（或默认 Shell）有变化：界面重新取一次终端状态 */
  | { type: 'profiles' }
export interface TerminalState {
  profiles: TerminalProfile[]
  defaultProfileId: string
  terminals: TerminalRecord[]
}
export interface TerminalProfileInput {
  id?: string
  label: string
  command: string
  args: string[]
}
