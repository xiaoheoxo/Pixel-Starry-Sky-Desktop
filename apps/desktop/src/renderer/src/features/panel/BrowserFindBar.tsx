// 页内查找条（docs/ui/browser-v2.md §3.2）：Ctrl+F 在工具栏下面出来；边输边找，Enter / Shift+Enter 下一个 / 上一个，Esc 关
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { IconButton, cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'

export type FindRequest = (
  text: string,
  opts: { forward: boolean; next: boolean },
) => Promise<{ active: number; total: number } | null>

export function BrowserFindBar({
  focusSeq,
  onFind,
  onClose,
}: {
  /** 每次 Ctrl+F 加一：已经开着时把焦点放回来并全选 */
  focusSeq: number
  onFind: FindRequest
  onClose: () => void
}) {
  useI18n()
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [result, setResult] = useState<{ active: number; total: number } | null>(null)
  /** 最近一次请求的序号：慢回来的旧结果不用 */
  const seq = useRef(0)
  /** 已经按这个文字找过（Enter 接着找下一个；没找过就重新开始） */
  const searched = useRef('')
  const timer = useRef(0)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusSeq])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const run = (value: string, forward: boolean, next: boolean) => {
    window.clearTimeout(timer.current)
    const id = ++seq.current
    searched.current = value
    if (!value) setResult(null)
    void onFind(value, { forward, next }).then(r => {
      if (id === seq.current && value) setResult(r)
    })
  }
  const step = (forward: boolean) => {
    if (!text) return
    run(text, forward, searched.current === text)
  }
  const none = !!text && result?.total === 0
  return (
    <div
      data-browser-find
      role="search"
      className={cn(
        'flex h-8 shrink-0 items-center gap-1 rounded-md border bg-surface pr-1 pl-2.5',
        none ? 'border-danger' : 'border-accent',
      )}
    >
      <Search size={13} className="shrink-0 text-fg-muted" />
      <input
        ref={input}
        data-browser-find-input
        aria-label={tr('projectTools.findPlaceholder')}
        placeholder={tr('projectTools.findPlaceholder')}
        spellCheck={false}
        value={text}
        onChange={e => {
          const value = e.target.value
          setText(value)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => run(value, true, false), 150)
        }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter') {
            e.preventDefault()
            step(!e.shiftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent text-list text-fg outline-none placeholder:text-fg-faint"
      />
      {text && result && (
        <span
          aria-live="polite"
          data-browser-find-count
          className={cn('shrink-0 px-1 text-label tabular-nums', none ? 'text-danger' : 'text-fg-muted')}
        >
          {none
            ? tr('projectTools.findNone')
            : tr('projectTools.findCount', { active: result.active, total: result.total })}
        </span>
      )}
      <IconButton
        icon={ChevronUp}
        size={24}
        iconSize={15}
        label={`${tr('projectTools.findPrev')} (Shift+Enter)`}
        disabled={!text || none}
        onClick={() => step(false)}
      />
      <IconButton
        icon={ChevronDown}
        size={24}
        iconSize={15}
        label={`${tr('projectTools.findNext')} (Enter)`}
        disabled={!text || none}
        onClick={() => step(true)}
      />
      <IconButton icon={X} size={24} iconSize={14} label={`${tr('projectTools.findClose')} (Esc)`} onClick={onClose} />
    </div>
  )
}
