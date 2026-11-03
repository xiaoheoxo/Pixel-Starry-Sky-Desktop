import type {
  ExtensionCheck,
  ExtensionEntry,
  ExtensionImport,
  ExtensionInput,
  ExtensionScope,
  ExtensionState,
  ImportApp,
  ImportAppScan,
  SkillCommand,
} from '@pixelsky/protocol'
import type { WorkspaceRef } from '../shared/types/workspace'
export interface ExtensionsBridge {
  state(ref?: WorkspaceRef | null): Promise<ExtensionState>
  save(data: ExtensionInput): Promise<ExtensionEntry>
  import(data: ExtensionImport): Promise<ExtensionEntry>
  importMcp(json: string, scope: ExtensionScope): Promise<number>
  /** 扫本机其他软件的 MCP 和技能（密钥只有名字） */
  scanApps(ref?: WorkspaceRef | null): Promise<ImportAppScan[]>
  /** 导入勾选的项（keys 是 scanApps 给的 key）；同名自动改名，一项失败不影响别的 */
  importApp(
    ref: WorkspaceRef | null | undefined,
    app: ImportApp,
    keys: string[],
    scope: ExtensionScope,
  ): Promise<{ imported: number; failed: Array<{ name: string; error: string }> }>
  toggle(id: string, enabled: boolean): Promise<void>
  remove(id: string): Promise<void>
  check(id: string, ref?: WorkspaceRef | null): Promise<ExtensionCheck>
  update(id: string, apply: boolean): Promise<{ changed: boolean; message: string }>
  skillText(id: string, ref?: WorkspaceRef | null): Promise<{ text: string; version: string; readOnly: boolean }>
  choose(kind: 'directory' | 'program'): Promise<string | null>
  reveal(id: string, ref?: WorkspaceRef | null): Promise<void>
  commands(ref?: WorkspaceRef | null): Promise<SkillCommand[]>
  onChange(callback: () => void): () => void
}
