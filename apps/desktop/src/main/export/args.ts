import { safeFileName } from '../../shared/safeFileName'

// 导出对话的保存参数检查（docs/ui/conversation-export.md）：渲染层写好内容交过来，主进程只管弹对话框、写文件
// txt：终端的「把输出存成文件」（docs/ui/terminal-toolbar-status.md §4）
export const EXPORT_KINDS = { md: 'Markdown', html: 'HTML', json: 'JSON', txt: 'Text' } as const
export type ExportKind = keyof typeof EXPORT_KINDS
/** 一份对话文本的上限：再大多半不是对话（防止界面出错时往磁盘里灌东西） */
export const EXPORT_MAX_CHARS = 64 * 1024 * 1024

export interface SaveArgs {
  /** 默认文件名，不含扩展名，已去掉路径分隔符等不能用在文件名里的字符 */
  name: string
  ext: ExportKind
  content: string
}

export function saveArgs(input: unknown): SaveArgs {
  const v = input as Partial<Record<keyof SaveArgs, unknown>> | null
  if (!v || typeof v !== 'object') throw new Error('参数不正确')
  const { name, ext, content } = v
  if (typeof ext !== 'string' || !Object.hasOwn(EXPORT_KINDS, ext)) throw new Error('不支持的导出格式')
  if (typeof content !== 'string' || content.length > EXPORT_MAX_CHARS) throw new Error('导出内容不正确')
  if (typeof name !== 'string') throw new Error('参数不正确')
  return { name: safeFileName(name, 120, 'conversation'), ext: ext as ExportKind, content }
}
