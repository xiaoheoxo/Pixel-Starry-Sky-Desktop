import type { WorkspaceRef } from '../../../../shared/types/workspace'
import type { MarkdownImageSource } from '@/ui/markdown/MarkdownImage'
import { workspaceRelativePath } from './pathLinks'
import { svgDataUrl } from '@/ui/markdown/mermaid'
import { prepareSvg } from '@/ui/markdown/svg'

/** 按会话所在机器读取，避免 Windows 窗口把 WSL 的 /home/... 当成本机图片地址。 */
export async function readMarkdownImage(ref: WorkspaceRef, path: string): Promise<MarkdownImageSource | null> {
  const relative = await workspaceRelativePath(ref, path)
  if (!relative) return null
  const doc = await window.pixelsky!.files.read(ref, relative)
  if (doc.kind === 'image') return { src: doc.dataUrl, bytes: doc.bytes }
  // SVG 在编辑器里按文本读；显示时用 <img> 加载（不运行脚本、不加载外部资源）
  if (doc.kind === 'text' && /\.svg$/i.test(relative)) {
    const svg = prepareSvg(doc.content)
    return svg ? { src: svgDataUrl(svg), bytes: doc.bytes } : null
  }
  return null
}
