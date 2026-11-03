import {
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionSection,
  type CompletionSource,
} from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { getFiles } from '@/features/files/store'
import { contributionsOf, packByKey, readPackJson } from '@/features/extpacks/store'
import { getEditorView } from '../CodeEditor'
import { parseSnippetFile, toCodeMirrorTemplate, type ParsedSnippet, type SnippetVariables } from './parse'

// 补全来源：把生效扩展里该语言的片段变成 CodeMirror 补全项

const CACHE_MAX = 64
const cache = new Map<string, Promise<ParsedSnippet[]>>()
const WORD = /[^\s()[\]{}"'`,;]+$/
const WORD_ALL = /^[^\s()[\]{}"'`,;]*$/

function loadFile(key: string, path: string): Promise<ParsedSnippet[]> {
  const id = `${key}@${packByKey(key)?.revision ?? 0}:${path}`
  const hit = cache.get(id)
  if (hit) return hit
  const promise = readPackJson(key, path)
    .then(json => parseSnippetFile(json).snippets)
    .catch(() => {
      cache.delete(id)
      return [] as ParsedSnippet[]
    })
  cache.set(id, promise)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  return promise
}

export function hasSnippets(languageId: string | null): boolean {
  return !!languageId && contributionsOf('snippets').some(c => c.item.language === languageId)
}

export async function snippetsForLanguage(languageId: string): Promise<ParsedSnippet[]> {
  const refs = contributionsOf('snippets').filter(c => c.item.language === languageId)
  const lists = await Promise.all(refs.map(c => loadFile(c.pack.key, c.item.path)))
  return lists.flat()
}

const pad = (n: number) => String(n).padStart(2, '0')

function variablesFor(view: EditorView, from: number, to: number): Partial<SnippetVariables> {
  const tab = getFiles().tabs.find(t => getEditorView(t.id) === view)
  const name = tab ? (tab.path.split(/[\\/]/).pop() ?? '') : ''
  const dot = name.lastIndexOf('.')
  const now = new Date()
  const lineComment = view.state.languageDataAt<{ line?: string }>('commentTokens', from)[0]?.line
  return {
    TM_FILENAME: name,
    TM_FILENAME_BASE: dot > 0 ? name.slice(0, dot) : name,
    TM_SELECTED_TEXT: view.state.sliceDoc(from, to),
    CURRENT_YEAR: String(now.getFullYear()),
    CURRENT_MONTH: pad(now.getMonth() + 1),
    CURRENT_DATE: pad(now.getDate()),
    CURRENT_HOUR: pad(now.getHours()),
    CURRENT_MINUTE: pad(now.getMinutes()),
    UUID: crypto.randomUUID(),
    LINE_COMMENT: lineComment ?? '',
  }
}

const USES_CLIPBOARD = /\$(?:CLIPBOARD\b|\{CLIPBOARD[}:/])/

function applySnippet(body: string) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    const vars = variablesFor(view, from, to)
    const run = (clip?: string) =>
      snippet(toCodeMirrorTemplate(body, clip === undefined ? vars : { ...vars, CLIPBOARD: clip }))(
        view,
        completion,
        from,
        to,
      )
    if (!USES_CLIPBOARD.test(body)) return run()
    // 只有用到剪贴板才读它；读的时候文档变了就不插了
    const doc = view.state.doc
    void Promise.resolve(window.pixelsky?.terminal.clipboardRead())
      .catch(() => '')
      .then(text => {
        if (view.state.doc === doc) run(text ?? '')
      })
  }
}

/** section：和单词补全放在同一个列表时分组（片段在前） */
export function snippetSource(languageId: string, section?: CompletionSection): CompletionSource {
  return async (context: CompletionContext) => {
    const word = context.matchBefore(WORD)
    if (!word && !context.explicit) return null
    const text = (word?.text ?? '').toLowerCase()
    const list = await snippetsForLanguage(languageId)
    const options: Completion[] = []
    for (const s of list) {
      for (const prefix of s.prefixes) {
        if (!prefix.toLowerCase().startsWith(text)) continue
        options.push({
          label: prefix,
          detail: s.name,
          info: s.description || undefined,
          type: 'snippet',
          apply: applySnippet(s.body),
          section,
        })
      }
    }
    if (options.length === 0) return null
    return { from: word ? word.from : context.pos, options, validFor: WORD_ALL }
  }
}
