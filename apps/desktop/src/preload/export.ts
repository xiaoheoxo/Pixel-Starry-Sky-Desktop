// 导出对话（docs/ui/conversation-export.md）

export interface ExportBridge {
  /** 弹出系统保存对话框并写入文件；返回写入的完整路径，在对话框里取消返回 null。name 不含扩展名 */
  save(input: { name: string; ext: 'md' | 'html' | 'json' | 'txt'; content: string }): Promise<string | null>
}
