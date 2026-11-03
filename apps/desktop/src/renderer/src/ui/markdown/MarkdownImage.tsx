import { createContext, useContext, useEffect, useState } from 'react'
import { tr } from '@/i18n/core'
import { ZoomableImage } from '@/ui/ImageViewer'
import { linkPathText } from './pathLinks'
import { cn } from '@/ui/cn'
import { SVG_BACKDROP } from './svg'

export interface MarkdownImageSource {
  src: string
  bytes: number
}
export type MarkdownImageReader = (path: string) => Promise<MarkdownImageSource | null>

// 独立于路径链接上下文：流式正文暂时关闭路径链接时，图片仍按当前会话读取。
export const MarkdownImageContext = createContext<MarkdownImageReader | null>(null)

function WorkspaceImage({ path, alt, reader }: { path: string; alt: string; reader: MarkdownImageReader | null }) {
  const [loaded, setLoaded] = useState<{
    reader: MarkdownImageReader
    path: string
    image: MarkdownImageSource | null
  } | null>(null)
  useEffect(() => {
    if (!reader) return
    let active = true
    void reader(path)
      .catch(() => null)
      .then(image => {
        if (active) setLoaded({ reader, path, image })
      })
    return () => {
      active = false
    }
  }, [reader, path])

  const current = loaded?.reader === reader && loaded?.path === path ? loaded : null
  if (!reader || (current && !current.image))
    return (
      <span data-markdown-image="unavailable" className="text-meta text-fg-muted" title={path}>
        {tr('markdown.image.unavailable', { p0: alt })}
      </span>
    )
  if (!current?.image)
    return (
      <span data-markdown-image="loading" className="text-meta text-fg-muted" title={path}>
        {tr('markdown.image.loading')}
      </span>
    )
  return (
    <ZoomableImage
      src={current.image.src}
      alt={alt}
      bytes={current.image.bytes}
      className={cn(
        'inline-block max-h-96 max-w-full rounded-md object-contain align-middle',
        // 透明底的 SVG 垫棋盘格：深色主题里黑线条也看得见
        current.image.src.startsWith('data:image/svg+xml') && SVG_BACKDROP.check,
      )}
    />
  )
}

/** 本地图片经会话文件接口读取为 data URL；不把机器上的原始路径交给浏览器。 */
export function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const reader = useContext(MarkdownImageContext)
  const path = linkPathText(src, false)
  const name = alt || title || path?.split(/[\\/]/).pop() || tr('markdown.image.name')
  if (path) return <WorkspaceImage path={path} alt={name} reader={reader} />
  return <img src={src} alt={name} title={title} className="inline-block max-h-96 max-w-full object-contain" />
}
