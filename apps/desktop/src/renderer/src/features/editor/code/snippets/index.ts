import { acceptCompletion, autocompletion, type CompletionSource } from '@codemirror/autocomplete'
import { Prec, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { hasSnippets, snippetSource } from './source'
import { getWordComplete, snippetSection, wordSection, wordSource } from './words'

/**
 * 编辑器补全：所有文本文件都有单词补全（设置里能关），有片段的语言再加代码片段、片段排前面。
 * 两样都没有时不装，编辑行为不变。不订阅变化：装卸靠 packs 隔间重配（扩展变了、单词补全开关变了，见 CodeEditor）。
 */
export function snippetSupport(languageId: string | null): Extension {
  const snippets = !!languageId && hasSnippets(languageId),
    words = getWordComplete()
  const sources: CompletionSource[] = []
  // 只有片段和单词都在时才分组，免得只有一种时多一行组名
  if (snippets && languageId) sources.push(snippetSource(languageId, words ? snippetSection() : undefined))
  if (words) sources.push(wordSource(snippets ? wordSection() : undefined))
  if (!sources.length) return []
  return [
    autocompletion({ override: sources, icons: false }),
    // 没有补全弹窗时返回 false，indentWithTab 照常缩进
    Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
  ]
}
