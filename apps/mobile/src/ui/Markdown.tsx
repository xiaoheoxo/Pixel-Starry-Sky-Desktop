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
      <Markdown remarkPlugins={[remarkGfm, remarkCjkFriendly]} components={components}>
        {replaceCodexDirectives(text, citationText)}
      </Markdown>
    </div>
  )
})
