// 给会话里的正文提供文件路径链接（docs/ui/content-highlight.md §2 A、F）：用 pathLinks 判断文件是否存在，
// 点击用 openFile 在右侧工作区打开并跳到行。ui/markdown/pathLinks.tsx 只定义接口。
import { useMemo, type ReactNode } from 'react'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { useToast } from '@/ui'
import { PathLinksContext, type PathLinks } from '@/ui/markdown/pathLinks'
import { tr, translateMessage } from '@/i18n/core'
import { openFile, showFiles } from './store'
import { linkTarget, wholeTextFile, workspaceRoot } from './pathLinks'
import { revealFolderInTree } from './treeReveal'
import { findPathMatches } from './pathMatch'
import { isHtmlPath, previewHtml } from './htmlPreview'
import { isRemoteRef, pathHint, revealPath } from './reveal'
import { MarkdownImageContext, type MarkdownImageReader } from '@/ui/markdown/MarkdownImage'
import { readMarkdownImage } from './markdownImages'
import type { WorkspaceRef } from '../../../../shared/types/workspace'

export function PathLinksProvider({
  sessionId,
  projectId = null,
  children,
}: {
  sessionId: string | null
  /** 没有会话时按项目目录认路径（频道消息，docs/ui/channels-local-rest.md §3.3 b） */
  projectId?: string | null
  children: ReactNode
}) {
  const toast = useToast()
  const imageReader = useMemo<MarkdownImageReader | null>(() => {
    const ref: WorkspaceRef | null = sessionId ? { sessionId } : projectId ? { projectId } : null
    return ref && !isDemo ? path => readMarkdownImage(ref, path) : null
  }, [sessionId, projectId])
  const value = useMemo<PathLinks | null>(() => {
    const ref: WorkspaceRef | null = sessionId ? { sessionId } : projectId ? { projectId } : null
    if (!ref || !window.pixelsky) return null
    return {
      resolve: isDemo ? async text => demoTextFile(text) : text => wholeTextFile(ref, text),
      // HTML 没带行号时在右侧浏览器里看效果（本机项目），其余照旧在编辑器里打开
      open: target => {
        const source = (): Promise<unknown> => openFile(ref, target.path, target.line ?? undefined, target.column ?? 1)
        const run =
          isHtmlPath(target.path) && !target.line
            ? previewHtml(ref, target.path).then(shown => (shown ? undefined : source()))
            : source()
        void run.catch((e: Error) => toast(e.message))
      },
      // 双击 / Shift+Enter：在文件夹中显示；远程机器 revealPath 会提示不能显示（提示文字只写单击打开）
      reveal: target => void revealPath(ref, target.path, toast),
      hint: (path, kind) =>
        kind === 'folder'
          ? `${tr(isRemoteRef(ref) ? 'path.hintFolderRemote' : 'path.hintFolder')}\n${path}`
          : kind === 'outside'
            ? `${tr('path.hintOutside')}\n${path}`
            : pathHint(ref, path),
      // Markdown 链接：文件夹、项目外的路径也认（docs/ui/path-click.md）
      resolveLink: isDemo
        ? async text => {
            const file = demoTextFile(text)
            return file && { kind: 'file', ...file }
          }
        : text => linkTarget(ref, text),
      // 文件夹：打开文件面板，文件树一层层展开到它并滚过去（按根目录认是哪棵树，treeReveal.ts）
      showFolder: path => {
        showFiles(ref)
        void workspaceRoot(ref).then(root => root && revealFolderInTree(root, path))
      },
      revealOutside: path => {
        if (isDemo) return toast(tr('path.revealDemo'))
        void window
          .pixelsky!.editor.revealOutside(path)
          .catch((e: Error) => toast(tr('path.revealFailed', { reason: translateMessage(e.message) })))
      },
    }
  }, [sessionId, projectId, toast])
  return (
    <MarkdownImageContext.Provider value={imageReader}>
      <PathLinksContext.Provider value={value}>{children}</PathLinksContext.Provider>
    </MarkdownImageContext.Provider>
  )
}

/** 演示模式（docs/ui/demo-conversation.md）：整段文字是演示文件列表里的路径时才算 */
function demoTextFile(text: string): { path: string; line: number | null; column: number | null } | null {
  const value = text.trim()
  const [match] = findPathMatches(value)
  if (!match || match.start !== 0 || match.end !== value.length) return null
  const path = match.raw.replaceAll('\\', '/').replace(/^\.\//, '')
  return path in demo().files.contents ? { path, line: match.line, column: match.column } : null
}
