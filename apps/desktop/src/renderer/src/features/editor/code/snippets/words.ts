import { completeAnyWord, type CompletionSection, type CompletionSource } from '@codemirror/autocomplete'
import { useSyncExternalStore } from 'react'
import { tr } from '@/i18n/core'
import { onStoredChange, readStoredFlag } from '@/features/settings/storedValue'

// 单词补全：本文件出现过的单词（docs/ui/coding-tier1.md §1），设置 › 编辑器可以关，默认开

export const WORD_COMPLETE_KEY = 'pixelsky.editor.wordComplete'

const browser = typeof window !== 'undefined'
let enabled = browser ? readStoredFlag(WORD_COMPLETE_KEY, true) : true
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(fn => fn())

export const getWordComplete = (): boolean => enabled

export function setWordComplete(next: boolean): void {
  if (next === enabled) return
  enabled = next
  try {
    localStorage.setItem(WORD_COMPLETE_KEY, String(next))
  } catch {
    /* 存储不可用时，本次仍然生效 */
  }
  emit()
}

/** 开关变了（含别的窗口、云同步改的）；CodeEditor 用它重配开着的编辑器 */
export function onWordCompleteChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

// 别的窗口改了：只读不写回（settings/storedValue.ts）
onStoredChange(WORD_COMPLETE_KEY, () => {
  const next = readStoredFlag(WORD_COMPLETE_KEY, true)
  if (next === enabled) return
  enabled = next
  emit()
})

export const useWordComplete = (): boolean => useSyncExternalStore(onWordCompleteChange, getWordComplete, () => true)

/** 补全列表里片段一组、单词一组，片段在前（rank 小的排前面）；只在这门语言有片段时才分组 */
export const snippetSection = (): CompletionSection => ({ name: tr('editor.complete.snippets'), rank: 0 })
export const wordSection = (): CompletionSection => ({ name: tr('editor.complete.words'), rank: 1 })

// 和 completeAnyWord 认的单词字符一样（不含语言额外的 wordChars，只用来判断敲了几个字）
const TWO_CHARS = /[\p{Alphabetic}\p{Number}_]{2,}$/u
// 中日韩文字不用空格断词，整句会被当成一个「词」，回车就把刚敲的换成整句；这类词不补
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** 敲到一个词的第 2 个字符才弹；Ctrl+Space 主动叫出来时不限 */
export function wordSource(section?: CompletionSection): CompletionSource {
  return async context => {
    if (!context.explicit && !context.matchBefore(TWO_CHARS)) return null
    const result = await completeAnyWord(context)
    if (!result) return null
    const typed = context.state.sliceDoc(result.from, context.pos)
    if (CJK.test(typed)) return null
    // 只认前缀（默认的模糊匹配让行尾几乎每个词都弹列表，回车被吞）；已经敲完整的词也不列。
    // 不带 validFor，每敲一个字重算，敲完整时列表跟着消失
    const t = typed.toLowerCase()
    const options = result.options
      .filter(o => {
        const l = o.label.toLowerCase()
        return l !== t && l.startsWith(t) && !CJK.test(l)
      })
      .map(o => (section ? { ...o, section } : o))
    return options.length ? { from: result.from, options } : null
  }
}
