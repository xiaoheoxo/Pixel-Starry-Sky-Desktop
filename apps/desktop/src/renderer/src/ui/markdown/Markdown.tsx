import { useI18n } from '@/i18n/I18nProvider'
import { memo, useEffect, useMemo, useReducer, useRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { cn } from '@/ui'
import { CodeBlock } from '@/ui/code/CodeBlock'
import { InlineCode, MarkdownLink, PathLinksContext, keepLocalPaths } from './pathLinks'
import { MarkdownImage } from './MarkdownImage'
import { Callout, isAlertKind, remarkAlerts } from './alerts'
import { hasMath, normalizeMath, useMathPlugins, type PluggableList } from './math'
import { createStreamSplitter, type StreamBlocks } from './streamBlocks'
import { createTailThrottle, type TailThrottle } from './tailThrottle'
import { rehypeHeadingIds, rehypeSourceLines } from './document'
import type { Element, ElementContent } from 'hast'

/** 取出 hast 节点里的全部文字（代码块的原文） */
function textOf(node: ElementContent): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(textOf).join('')
  return ''
}

/** ```lang 围起来的代码块 → <pre><code class="language-lang">；取出语言和原文交给 CodeBlock 高亮 */
function fencedCode(pre: Element | undefined): { code: string; lang: string | null } {
  const code = pre?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code')
  const classes = code?.properties?.className
  const langClass = Array.isArray(classes) ? classes.map(String).find(c => c.startsWith('language-')) : undefined
  return { code: code ? textOf(code) : '', lang: langClass ? langClass.slice('language-'.length) : null }
}

/** 文档模式的 data-line（对话里没有，返回 undefined 不输出属性） */
const lineOf = (node: Element | undefined): number | undefined => {
  const line = node?.properties?.dataLine
  return typeof line === 'number' ? line : undefined
}

const components: Components = {
  // 链接：项目里的文件在软件里打开，其余在新窗口打开（主进程交给系统浏览器，只放行 http / https）
  a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
  img: ({ src, alt, title }) => (
    <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} title={title} />
  ),
  // 行内代码（代码块由下面的 pre 整个接管）：项目里的文件变成可点击的路径（docs/ui/content-highlight.md §2 A）
  code: ({ node: _node, className, children }) => <InlineCode className={className}>{children}</InlineCode>,
  // 引用块：带 [!NOTE] 等标记的画成提示块（docs/ui/content-highlight.md §2 G）
  blockquote: ({ node, children }) => {
    const kind = node?.properties?.dataAlert
    const line = lineOf(node)
    if (isAlertKind(kind))
      return line === undefined ? (
        <Callout kind={kind}>{children}</Callout>
      ) : (
        <div data-line={line}>
          <Callout kind={kind}>{children}</Callout>
        </div>
      )
    return <blockquote data-line={line}>{children}</blockquote>
  },
  // 表格（docs/ui/markdown-table.md）：圆角外框占满整行，列宽按内容分；内容更宽时在框里横向滚动
  table: ({ node, ...props }) => (
    <div data-line={lineOf(node)} className="my-3 max-w-full overflow-x-auto rounded-lg border border-line-card">
      <table {...{ ...props, 'data-line': undefined }} />
    </div>
  ),
  // 代码块：语言标题栏 + 复制按钮 + 语法高亮（docs/ui/code-highlight.md）
  pre: ({ node }) => {
    const { code, lang } = fencedCode(node)
    const line = lineOf(node)
    return line === undefined ? (
      <CodeBlock code={code} lang={lang} />
    ) : (
      <div data-line={line}>
        <CodeBlock code={code} lang={lang} />
      </div>
    )
  },
}

/** 正文 Markdown：14px / 1.7；行内代码偏暖色（参考 Mirasim / Claude）；代码块见 CodeBlock；表格圆角外框、只留横线。只用设计变量 */
const PROSE = [
  'text-prose text-fg-body break-words',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_p]:my-2.5',
  '[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-6',
  '[&_li]:my-1 [&_li]:pl-1 [&_li]:marker:text-fg-faint',
  '[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-section [&_h1]:font-semibold [&_h1]:text-fg',
  '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-section [&_h2]:font-semibold [&_h2]:text-fg',
  '[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:font-semibold [&_h3]:text-fg',
  '[&_strong]:font-semibold [&_strong]:text-fg',
  '[&_a]:text-accent-fg [&_a]:underline [&_a]:underline-offset-2',
  '[&_:not(pre)>code]:rounded-sm [&_:not(pre)>code]:bg-code-inline-bg [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.9em] [&_:not(pre)>code]:text-code-inline',
  '[&_code[data-path]]:text-code-path [&_code[data-path]]:underline [&_code[data-path]]:decoration-dotted [&_code[data-path]]:underline-offset-2',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-fg-muted',
  '[&_table]:w-full [&_table]:border-collapse [&_table]:text-list [&_table]:tabular-nums',
  '[&_th]:border-b [&_th]:border-line [&_th]:bg-subtle [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-fg-secondary',
  '[&_td]:border-b [&_td]:border-line-subtle [&_td]:px-3 [&_td]:py-1.5 [&_td]:align-top',
  '[&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:hover]:bg-hover',
  '[&_hr]:my-4 [&_hr]:border-line',
].join(' ')

/** 流式时不带公式和路径链接，插件固定不变 */
const STREAM_REMARK_PLUGINS: PluggableList = [remarkAlerts, remarkGfm, remarkBreaks]

/**
 * 流式时一块（空行之间的一段）超过这个长度就不解析 Markdown，按纯文字显示。
 * 没有空行的退化输出（一行重复几千遍）整段是一块，每来一点字都重新解析会卡死界面；
 * 正常的一段话远不到这个长度，这条回复完成后整条按 Markdown 重画。
 */
const STREAM_MARKDOWN_LIMIT = 8000

/** 流式时一个已写完的块：文字不变就不重新解析；超长的块按纯文字显示 */
const StreamChunk = memo(function StreamChunk({ text }: { text: string }) {
  if (text.length > STREAM_MARKDOWN_LIMIT) return <p className="whitespace-pre-wrap">{text}</p>
  return (
    <ReactMarkdown remarkPlugins={STREAM_REMARK_PLUGINS} components={components} urlTransform={keepLocalPaths}>
      {text}
    </ReactMarkdown>
  )
})

/** 尾巴节流（tailThrottle.ts）：尾巴很长时最多隔 200 毫秒才刷新显示的那一份，其余情况跟最新 */
function useThrottledBlocks(latest: StreamBlocks): StreamBlocks {
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const throttle = useRef<TailThrottle | null>(null)
  throttle.current ??= createTailThrottle(refresh)
  const shown = throttle.current.view(latest)
  // 每次提交后看要不要排定时器；卸载（含开发模式的重新挂载）时清掉
  useEffect(() => throttle.current?.arm())
  useEffect(() => () => throttle.current?.dispose(), [])
  return shown
}

/**
 * 流式输出：已写完的块各自 memo，只有尾巴随新文字重新解析；切块接着上次的位置扫，每次的开销和新增文字成正比。
 * 尾巴超长时只显示最后一段（整段每次都排版也会拖慢），完成后显示全文
 */
function StreamingBody({ text }: { text: string }) {
  const splitter = useRef<ReturnType<typeof createStreamSplitter> | null>(null)
  splitter.current ??= createStreamSplitter()
  const split = splitter.current
  const latest = useMemo(() => split(text), [split, text])
  const { completed, tail } = useThrottledBlocks(latest)
  return (
    <PathLinksContext.Provider value={null}>
      {completed.map((block, i) => (
        <StreamChunk key={i} text={block} />
      ))}
      {tail.trim() === '' ? null : tail.length <= STREAM_MARKDOWN_LIMIT ? (
        <StreamChunk text={tail} />
      ) : (
        <p className="whitespace-pre-wrap">…{tail.slice(-STREAM_MARKDOWN_LIMIT)}</p>
      )}
    </PathLinksContext.Provider>
  )
}

export const Markdown = memo(function Markdown({
  text,
  className,
  streaming,
  document,
}: {
  text: string
  className?: string
  /** 回复还在输出：先不加路径链接和公式，等这条完成，免得内容变化时闪动；按空行分块，已写完的块不重新解析 */
  streaming?: boolean
  /** 文档模式（预览 .md 文件）：按标准 Markdown 不把单个换行当换行；块级元素带 data-line，标题带 id */
  document?: boolean
}) {
  useI18n()
  // 公式：有公式标记时才加载 KaTeX，加载好之前按原文显示（docs/ui/content-highlight.md §2 I）；流式时不扫全文
  const math = useMathPlugins(streaming ? false : hasMath(text))
  const source = useMemo(() => (math ? normalizeMath(text) : text), [math, text])
  // 提示块要在 remark-breaks 之前认出标记；remark-breaks：单个换行也换行（一行一个的列表、数字不会挤成一段）
  const remarkPlugins = useMemo<PluggableList>(
    () => [remarkAlerts, remarkGfm, ...(math?.remark ?? []), ...(document ? [] : [remarkBreaks])],
    [math, document],
  )
  const rehypePlugins = useMemo<PluggableList | undefined>(
    () => (document ? [...(math?.rehype ?? []), rehypeSourceLines, rehypeHeadingIds] : math?.rehype),
    [math, document],
  )
  return (
    <div className={cn(PROSE, className)}>
      {streaming ? (
        <StreamingBody text={text} />
      ) : (
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
          urlTransform={keepLocalPaths}
        >
          {source}
        </ReactMarkdown>
      )}
    </div>
  )
})
