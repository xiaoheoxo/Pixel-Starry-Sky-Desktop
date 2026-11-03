// 大纲和命令中心 @ 共用：当前编辑器文件能不能列符号、列出哪些（纯函数）
import type { TranslationKey } from '@/i18n/core'
import type { OpenFile } from '@/features/files/store'
import { declarations, nestDepths, symbolsSupported, type Declaration } from '../../editor/extras/symbolsModel'

/** 再大的文件每次按键重扫一遍会卡，跟面包屑的上限一致 */
export const OUTLINE_MAX_CHARS = 400_000

export interface OutlineItem extends Declaration {
  depth: number
}
export type FileSymbols =
  | { kind: 'noFile' | 'loading' | 'noText' | 'unsupported' | 'tooLarge' }
  | { kind: 'ready'; items: OutlineItem[] }

export function fileSymbols(tab: Pick<OpenFile, 'path' | 'document' | 'draft' | 'loading'> | null): FileSymbols {
  if (!tab) return { kind: 'noFile' }
  if (!tab.document) return { kind: tab.loading ? 'loading' : 'noText' }
  if (tab.document.kind !== 'text') return { kind: 'noText' }
  if (!symbolsSupported(tab.path)) return { kind: 'unsupported' }
  if (tab.draft.length > OUTLINE_MAX_CHARS) return { kind: 'tooLarge' }
  const list = declarations(tab.draft, tab.path)
  const depths = nestDepths(list)
  return { kind: 'ready', items: list.map((d, i) => ({ ...d, depth: depths[i] })) }
}

/** 列不出符号时的那一句说明（命令中心 @ 也用） */
export const SYMBOLS_NOTE: Record<Exclude<FileSymbols['kind'], 'ready'>, TranslationKey> = {
  noFile: 'coding.shell.outline.noFile',
  loading: 'coding.shell.outline.loading',
  noText: 'coding.shell.outline.noText',
  unsupported: 'coding.shell.outline.unsupported',
  tooLarge: 'coding.shell.outline.tooLarge',
}
