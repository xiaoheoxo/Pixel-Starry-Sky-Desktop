import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { CopyButton, cn } from '@/ui'
import { MAX_LENGTH, highlight, languageLabel, resolveLanguage } from './highlight'

/** 超过这么多行的代码块默认折叠（docs/ui/content-highlight.md §2 H） */
export const FOLD_OVER = 30
/** 折叠时显示的行数 */
export const FOLD_SHOW = 20

export const shouldFold = (lineCount: number): boolean => lineCount > FOLD_OVER

/** 折叠时高亮的行数：露出来的 20 行再多几行（渐隐那一段也是彩色的），后面是纯文字（docs/memory-tier3.md §2.1） */
export const FOLD_HIGHLIGHT = FOLD_SHOW + 5

/** 折叠时的前后两段：前一段高亮；后一段（以换行开头）原样放着，对话内搜索照样能搜到 */
export function foldSplit(text: string): { head: string; tail: string } {
  let at = -1
  for (let i = 0; i < FOLD_HIGHLIGHT; i++) {
    at = text.indexOf('\n', at + 1)
    if (at < 0) return { head: text, tail: '' }
  }
  return { head: text.slice(0, at), tail: text.slice(at) }
}

/** 展开后过多久再高亮全文：搜索点开的先按纯文字滚到命中，再换成高亮（节点换了，搜索会重查） */
const FULL_DELAY_MS = 300

/**
 * 代码块（参考 Claude / Mirasim）：顶部一条标题栏，左边语言名、右边「复制」；下面是语法高亮的代码，
 * 横向滚动不折行。颜色只用设计变量（--syn-*），见 docs/ui/code-highlight.md。
 * 很长的代码块先只显示前 20 行，底部渐隐，可以展开 / 收起；复制照旧复制全部。
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  className,
  tools,
  notice,
  view,
}: {
  code: string
  /** 代码块标注的语言（```ts 里的 ts）；没有标注时为 null */
  lang: string | null
  className?: string
  /** 标题栏里复制按钮前的控件（Mermaid 的「源码 / 图」切换、放大） */
  tools?: ReactNode
  /** 标题栏下面的一行提示（Mermaid 渲染失败的原因） */
  notice?: ReactNode
  /** 替换代码区的内容（Mermaid 的图）；复制仍复制源码，不折叠 */
  view?: ReactNode
}) {
  useI18n()
  // Markdown 解析出来的代码末尾常带一个换行，去掉免得多出一行空白
  const text = code.endsWith('\n') ? code.slice(0, -1) : code
  const resolved = resolveLanguage(lang)
  const label = languageLabel(lang) ?? tr('code.CodeBlock.code')
  const lines = useMemo(() => text.split('\n').length, [text])
  const foldable = !view && shouldFold(lines)
  const [expanded, setExpanded] = useState(false)
  const folded = foldable && !expanded
  // 折叠着的长代码块只高亮露出来的部分，展开后稍等再高亮全文；展开过一次就一直是全文
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (!expanded || full) return
    const timer = window.setTimeout(() => setFull(true), FULL_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [expanded, full])
  // 超过高亮上限的整段本来就是纯文字：不拆，免得折叠时前面有颜色、展开后反而没了
  const partial = foldable && !full && text.length <= MAX_LENGTH
  const body = useMemo((): ReactNode => {
    if (!partial) return highlight(text, resolved)
    const { head, tail } = foldSplit(text)
    return (
      <>
        {highlight(head, resolved)}
        {tail}
      </>
    )
  }, [text, resolved, partial])

  return (
    <div
      data-folded={folded || undefined}
      // 右键菜单（features/session/contextMenu）从这里认出代码块和语言
      data-code-block=""
      data-code-lang={lang ?? undefined}
      className={cn('group/code my-3 overflow-hidden rounded-lg border border-line bg-subtle', className)}
    >
      <div className="flex h-8 items-center justify-between border-b border-line-subtle pr-1.5 pl-3">
        <span className="truncate text-meta text-fg-muted">{label}</span>
        <div className="flex items-center gap-1">
          {tools}
          <CopyButton text={text} label={tr('code.CodeBlock.copyCode')} />
        </div>
      </div>
      {notice}
      {view ?? (
        <div className="relative">
          <pre
            className={cn(
              'selectable overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-fg',
              // 20 行（lh 是一行的高度）加上下内边距
              folded && 'max-h-[calc(20lh+1.25rem)] overflow-y-hidden',
            )}
          >
            <code>{body}</code>
          </pre>
          {folded && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-subtle to-transparent" />
          )}
        </div>
      )}
      {foldable && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
          className="flex h-8 w-full items-center justify-center gap-1 border-t border-line-subtle text-meta text-fg-muted hover:bg-hover hover:text-fg"
        >
          {expanded ? <ChevronUp size={13} strokeWidth={1.75} /> : <ChevronDown size={13} strokeWidth={1.75} />}
          {expanded ? tr('content.code.collapse') : tr('content.code.expand', { n: lines })}
        </button>
      )}
    </div>
  )
})
