// 回复正文：和桌面端用同一套库（react-markdown + remark-gfm）；代码块带复制和高亮（ui/code.tsx），还没有公式
// （packages/ui 抽出后换成共用的）。
import { memo } from 'react'
import { citationName, replaceCodexDirectives, type CodexCitation } from '@pixelsky/protocol'
import Markdown, { type Components } from 'react-markdown'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './code'

/** react-markdown 给的语法树节点（hast），只用到这几个字段 */
interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: Node[]
}

/** micromark 内部的几样（库没导出类型），只用到这些字段 */
type Code = number | null
interface Token {
  start: { offset: number }
  end: { offset: number }
  _open?: boolean
  _close?: boolean
}
interface Ctx {
  previous: Code
  events: [string, Token][]
  sliceSerialize(t: Token): string
  parser: { constructs: { attentionMarkers: { null?: Code[] } } }
}
interface Construct {
  tokenize(this: Ctx, effects: unknown, ok: (code: Code) => unknown, nok: unknown): unknown
}
/** CommonMark 的字符分类：0 其它，1 空白，2 标点 */
const kind = (c: Code): number =>
  c === null || c < 0 || /\s/.test(String.fromCharCode(c)) ? 1 : /[\p{P}\p{S}]/u.test(String.fromCharCode(c)) ? 2 : 0

/**
 * remark-cjk-friendly 只用于 ** 加粗：标准规则认不出 **加粗：**这样（中文标点挨着星号），星号会原样显示；
 * 单个 * / _ 仍按 CommonMark 判断左右，免得 5*（3+2）*2、支持*.ts和*.js 被吃成斜体。和桌面端 ui/markdown/Markdown.tsx 同一份
 */
export function remarkCjkStrong(this: { data(): object }): void {
  remarkCjkFriendly.call(this)
  const ext = (this.data() as { micromarkExtensions: { text: Record<number, Construct> }[] }).micromarkExtensions.at(
    -1,
  )!
  const friendly = ext.text[42]!
  const attention: Construct = {
    ...friendly,
    tokenize(effects, ok, nok) {
      const previous = this.previous
      return friendly.tokenize.call(
        this,
        effects,
        code => {
          const token = this.events.at(-1)![1]
          if (token.end.offset - token.start.offset !== 1) return ok(code)
          const before = kind(previous)
          const after = kind(code)
          const markers = this.parser.constructs.attentionMarkers.null ?? []
          const open = !after || (after === 2 && before > 0) || markers.includes(code)
          const close = !before || (before === 2 && after > 0) || markers.includes(previous)
          const star = this.sliceSerialize(token) === '*'
          token._open = star ? open : open && (before > 0 || !close)
          token._close = star ? close : close && (after > 0 || !open)
          return ok(code)
        },
        nok,
      )
    },
  }
  ext.text = { 42: attention, 95: attention }
}

const textOf = (n: Node): string => (n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(textOf).join(''))

const components: Components = {
  pre({ node, children }) {
    const code = (node as unknown as Node | undefined)?.children?.find(c => c.type === 'element')
    if (code?.tagName !== 'code') return <pre>{children}</pre>
    const classes = Array.isArray(code.properties?.className) ? code.properties.className.map(String) : []
    const lang = classes.find(c => c.startsWith('language-'))?.slice('language-'.length) || null
    return <CodeBlock code={textOf(code).replace(/\n$/, '')} lang={lang} />
  },
  // 表格太宽时在自己的容器里横向滚动，不把整页撑宽
  table({ children }) {
    return (
      <div className="overflow-x-auto">
        <table>{children}</table>
      </div>
    )
  },
}

/** Codex 的文件引用：手机上打不开电脑上的文件，按行内代码只显示文件名（名字里有 ` 时用两个反引号包） */
const citationText = ({ path }: CodexCitation): string => {
  const name = citationName(path)
  return name.includes('`') ? `\`\` ${name} \`\`` : `\`${name}\``
}

// 流式输出时每个事件都会重渲整页，正文没变的条目直接跳过
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown text-prose text-fg-body">
      <Markdown remarkPlugins={[remarkGfm, remarkCjkStrong]} components={components}>
        {replaceCodexDirectives(text, citationText)}
      </Markdown>
    </div>
  )
})
