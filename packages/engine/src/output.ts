// 工具输出的长度上限（Claude 和 Codex 共用）：太长的命令输出不全放进内存和磁盘，保留头尾
import { cut } from './text'

export const MAX_OUTPUT = 40_000

export function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text
  const half = MAX_OUTPUT / 2
  return `${cut(text, 0, half)}\n…（中间省略 ${text.length - MAX_OUTPUT} 个字符）…\n${cut(text, text.length - half)}`
}
