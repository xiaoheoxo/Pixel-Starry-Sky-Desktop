import type { ExtPackInfo, ExtPackOptions, ExtPackState } from '@pixelsky/protocol'

/** 扩展包（语法 / 主题 / 图标 / 片段 / 任务 / 技能 / 提示词）；和 ExtensionsBridge（MCP / 插件）是两回事 */
export interface ExtPacksBridge {
  state(): Promise<ExtPackState>
  /** path 不传或为 null 时弹出文件夹选择框；传路径只在开发版有效 */
  addFolder(path?: string | null): Promise<ExtPackInfo | null>
  /** oniguruma 的 wasm 字节（渲染进程直接加载失败时的后备） */
  onigWasm(): Promise<Uint8Array>
  setEnabled(key: string, enabled: boolean): Promise<void>
  remove(key: string): Promise<void>
  reload(key?: string | null): Promise<void>
  setOptions(key: string, patch: ExtPackOptions): Promise<void>
  /** 同意 / 撤销扩展里的一条 MCP 连接器，并改填的值（null = 不动，'' = 清掉） */
  setMcp(key: string, name: string, approved: boolean, values: Record<string, string | null>): Promise<void>
  readJson(key: string, path: string): Promise<unknown>
  readText(key: string, path: string): Promise<string>
  reveal(key: string): Promise<void>
  onChange(callback: () => void): () => void
}
