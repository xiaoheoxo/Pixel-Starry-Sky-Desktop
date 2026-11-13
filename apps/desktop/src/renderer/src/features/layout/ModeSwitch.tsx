import type { ReactNode } from 'react'
import { CodeXml, MessagesSquare } from 'lucide-react'
import { SEGMENT_TRACK, cn, segmentItem } from '@/ui'
import { setAppMode, useAppMode } from '@/features/coding/mode'
import { tr } from '@/i18n/core'

/** 「对话 | 代码」胶囊（docs/ui/minimal-mode.md §18）：侧栏顶上和代码模式顶栏各放一个，右端可以再放一个按钮（收起侧栏 / 左栏） */
export function ModeSwitch({ children }: { children?: ReactNode }) {
  const mode = useAppMode()
  // 整宽两段平分、内容居中（docs/ui/minimal-mode.md §18，样式在 globals.css）
  const item = 'flex-1 justify-center gap-2 text-list'
  return (
    <div
      role="group"
      aria-label={tr('sidebar.mode.group')}
      data-mode-switch
      className={cn(SEGMENT_TRACK, 'flex w-full')}
    >
      <button
        type="button"
        aria-pressed={mode === 'chat'}
        data-mode="chat"
        onClick={() => setAppMode('chat')}
        className={cn(segmentItem(mode === 'chat'), item)}
      >
        <MessagesSquare size={16} strokeWidth={1.5} className="shrink-0" />
        {tr('sidebar.mode.chat')}
      </button>
      <button
        type="button"
        aria-pressed={mode === 'code'}
        data-mode="code"
        onClick={() => setAppMode('code')}
        className={cn(segmentItem(mode === 'code'), item)}
      >
        <CodeXml size={16} strokeWidth={1.5} className="shrink-0" />
        {tr('sidebar.mode.code')}
      </button>
      {/* 侧栏里同一个胶囊右端再放别的按钮（收起侧栏，minimal-mode.md §18），前面一条细竖线 */}
      {children && (
        <>
          <span aria-hidden data-mode-switch-sep />
          {children}
        </>
      )}
    </div>
  )
}
