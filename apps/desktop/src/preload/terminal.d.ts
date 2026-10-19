import type { WorkspaceRef } from '../shared/types/workspace'
import type {
  TerminalEncoding,
  TerminalRecord,
  TerminalEvent,
  TerminalState,
  TerminalProfileInput,
} from '../shared/types/terminal'

export interface TerminalBridge {
  state(force?: boolean): Promise<TerminalState>
  setDefaultProfile(id: string): Promise<TerminalState>
  /** Windows 上 PowerShell / cmd 的控制台编码；新开的终端生效 */
  setEncoding(encoding: TerminalEncoding): Promise<TerminalState>
  saveProfile(profile: TerminalProfileInput): Promise<TerminalState>
  removeProfile(id: string): Promise<TerminalState>
  resetProfiles(): Promise<TerminalState>
  chooseProgram(): Promise<string | null>
  create(ref: WorkspaceRef, profileId: string | undefined, requestId: string): Promise<TerminalRecord>
  write(id: string, generation: number, data: string): Promise<void>
  resize(id: string, generation: number, cols: number, rows: number): Promise<void>
  ack(id: string, generation: number, seq: number): void
  focused(value: boolean): void
  rename(id: string, title: string): Promise<TerminalRecord>
  close(id: string, force?: boolean): Promise<void>
  restart(id: string, force?: boolean): Promise<TerminalRecord>
  clipboardRead(): Promise<string>
  clipboardWrite(text: string): Promise<void>
  openLink(url: string): Promise<void>
  onEvent(cb: (event: TerminalEvent) => void): () => void
}
