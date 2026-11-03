// 终端里的报错问 AI（docs/ui/coding-tier2.md §7）：选区旁的浮条、报错行尾的「交给 AI 修」，和把引用卡片放进右栏输入框
import { Sparkles } from 'lucide-react'
import { tr } from '@/i18n/core'
import { appendComposerDraft } from '@/features/engine/drafts'
import { composerTarget, focusComposer } from '@/features/session/composerTarget'
import { getAppMode } from '@/features/coding/mode'
import { codingLayout } from '@/features/coding/layoutStore'

/** 把卡片放进当前会话的输入框（prompt 接在下一行），光标跟过去，不发送。没有会话时返回要提示的话 */
export function sendTerminalQuote(card: string, prompt: string | null): string | null {
  const target = composerTarget()
  if (!target) return tr('editor.quote.noSession')
  appendComposerDraft(target.key, `${card}\n${prompt ?? ''}`)
  if (getAppMode() === 'code') codingLayout.showRight('chat')
  focusComposer(target.key)
  return null
}

// 主按钮不能和次按钮共用 hover:bg-hover：同变体同属性时 Tailwind 按类名排序，hover:bg-hover 会盖掉底色
const base = 'inline-flex items-center gap-1 rounded px-2 py-0.5',
  item = base + ' hover:bg-hover'

export function SelectionBar({
  x,
  y,
  onAsk,
  onQuote,
  onCopy,
}: {
  x: number
  y: number
  onAsk: () => void
  onQuote: () => void
  onCopy: () => void
}) {
  return (
    <div
      role="toolbar"
      data-terminal-float
      className="absolute z-10 flex gap-1 rounded-md border border-line-card bg-popover p-0.5 text-meta whitespace-nowrap text-fg-secondary shadow-menu"
      style={{ left: x, top: y }}
    >
      <button type="button" className={base + ' bg-accent text-accent-on hover:opacity-90'} onClick={onAsk}>
        <Sparkles size={12} />
        {tr('terminal.ask.ai')}
      </button>
      <button type="button" className={item} onClick={onQuote}>
        {tr('terminal.ask.quote')}
      </button>
      <button type="button" className={item} onClick={onCopy}>
        {tr('terminal.ask.copy')}
      </button>
    </div>
  )
}

export function FixButton({ x, y, onClick }: { x: number; y: number; onClick: () => void }) {
  return (
    <button
      type="button"
      data-terminal-float
      className="absolute z-10 inline-flex -translate-y-1/2 items-center gap-1 rounded-md border border-line-card bg-popover px-2 py-0.5 text-meta whitespace-nowrap text-accent-fg shadow-menu hover:bg-hover"
      style={{ left: x, top: y }}
      onClick={onClick}
    >
      <Sparkles size={12} />
      {tr('terminal.ask.fix')}
    </button>
  )
}
