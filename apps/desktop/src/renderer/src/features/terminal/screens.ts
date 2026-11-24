export interface TerminalScreen {
  focus(): void
  clear(): void
  /** 重测字体格宽、重新排版并通知 PTY 重画当前帧，不清空缓冲区 */
  repair(): void
  find(query: string, backwards?: boolean): boolean
  endSearch(): void
  copy(): Promise<void>
  paste(text: string): void
  bottom(): void
  /** 普通缓冲区的行数（内存遥测用） */
  lines(): number
}
export const screens = new Map<string, TerminalScreen>()
