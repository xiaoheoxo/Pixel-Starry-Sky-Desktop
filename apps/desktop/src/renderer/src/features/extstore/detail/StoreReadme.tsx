import { memo, type AnchorHTMLAttributes } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MarkdownImageContext } from '@/ui/markdown/MarkdownImage'
import { PathLinksContext } from '@/ui/markdown/pathLinks'
import { tr } from '@/i18n/core'

// 商店扩展的 README 是不可信内容（docs/ui/extension-store-client.md §2.2）：
// 图片只显示替代文字，链接只放行 http / https 并交给系统浏览器，行内代码不做路径链接。
// 不开 rehype-raw，不传 keepLocalPaths（本机路径、file:、盘符地址在解析时就被清空）。

/** README 最多取这么多字符（云端已经限制 256 KB） */
export const README_MAX = 256 * 1024

/** 只放行 http / https */
export const isWebUrl = (href: string | undefined): href is string => !!href && /^https?:\/\//i.test(href)

function StoreLink({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (!isWebUrl(href)) return <span>{children}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  )
}

const components: Components = {
  a: ({ node: _node, href, children }) => <StoreLink href={href}>{children}</StoreLink>,
  img: ({ alt }) => (alt ? <span data-readme-image="alt">{alt}</span> : null),
}

const PROSE = [
  'selectable text-prose text-fg-body break-words',
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
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-subtle [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-meta',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-fg-muted',
  '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-list',
  '[&_th]:border-b [&_th]:border-line [&_th]:bg-subtle [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium',
  '[&_td]:border-b [&_td]:border-line-subtle [&_td]:px-3 [&_td]:py-1.5 [&_td]:align-top',
  '[&_hr]:my-4 [&_hr]:border-line',
].join(' ')

export const StoreReadme = memo(function StoreReadme({ text }: { text: string }) {
  const truncated = text.length > README_MAX
  const source = truncated ? text.slice(0, README_MAX) : text
  return (
    <MarkdownImageContext.Provider value={null}>
      <PathLinksContext.Provider value={null}>
        <div data-store-readme className={PROSE}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={defaultUrlTransform}>
            {source}
          </ReactMarkdown>
          {truncated && <p className="text-meta text-fg-faint">{tr('extstoreDetail.readmeTruncated')}</p>}
        </div>
      </PathLinksContext.Provider>
    </MarkdownImageContext.Provider>
  )
})
