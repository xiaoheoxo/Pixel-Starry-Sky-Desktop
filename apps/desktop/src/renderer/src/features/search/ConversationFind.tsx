import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
// 对话内搜索（Ctrl+F，docs/ui/content-highlight.md §2 E）：浮在对话区右上角，按字面不分大小写查找已经显示的文字，
// 用 termMarks 标出全部命中和当前这个，新内容到达时自动更新。
// 记住上次的词、用选中文字搜、折叠内容里的命中（docs/ui/conversation-ux.md §2.6）。
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { searchLiteral } from '@pixelsky/protocol'
import { IconButton } from '@/ui'
import { FIND_IN_CONVERSATION } from '@/features/layout/shortcuts'
import { findRanges, setMarks } from './termMarks'
import { detachConversation } from './navigation'

/** 最近点过 / 聚焦过的对话区：焦点不在任何输入框时，Ctrl+F 打开在它上面 */
let lastConversation: HTMLElement | null = null

/** 上次的搜索词：关掉再打开时还在（同一个窗口里的对话共用，不跨重启） */
let lastQuery = ''

/** 选中文字超过这么长、或者跨行，就不拿来当搜索词 */
const SELECTION_MAX = 100

/** 命中离对话区上下边缘不到这么多像素时算看不清，跳过去要滚到中间 */
const EDGE = 32

const isHidden = (el: HTMLElement): boolean =>
  el.getClientRects().length === 0 || !!el.closest('[inert],[aria-hidden="true"]')

/** 折叠着的条目里的命中：数量和展开它们的方法（SessionView 用会话数据算，见 features/session/live/foldedText.ts） */
export interface FoldedResult {
  count: number
  expand: () => void
}
export type FoldedMatches = (term: string) => FoldedResult

/**
 * 给一个对话区（main）挂 Ctrl+F：事件发生在这个对话区里，或者焦点不在任何地方而它是最近用过的对话区时打开。
 * 终端、编辑器、设置里的 Ctrl+F 事件不在对话区里，不受影响。
 */
export function useFindShortcut(main: RefObject<HTMLElement | null>, enabled: boolean, onFind: () => void): void {
  const latest = useRef(onFind)
  latest.current = onFind
  useEffect(() => {
    if (!enabled) return
    const remember = (e: Event): void => {
      const el = main.current
      if (el && e.target instanceof Node && el.contains(e.target)) lastConversation = el
    }
    const onKey = (e: KeyboardEvent): void => {
      const el = main.current
      if (!el || !FIND_IN_CONVERSATION.match(e) || isHidden(el)) return
      const target = e.target instanceof Node ? e.target : null
      const idle = !target || target === document.body || target === document.documentElement
      const fallback = lastConversation?.isConnected
        ? lastConversation
        : document.querySelector('main.conversation-view')
      if (!(target && el.contains(target)) && !(idle && fallback === el)) return
      e.preventDefault()
      latest.current()
    }
    window.addEventListener('pointerdown', remember, true)
    window.addEventListener('focusin', remember, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', remember, true)
      window.removeEventListener('focusin', remember, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [main, enabled])
}

/** 对话流里选中的一小段文字（一行、不太长）：按 Ctrl+F 时直接搜它 */
function selectedText(stream: HTMLElement | null): string {
  const selection = window.getSelection()
  if (!stream || !selection || selection.isCollapsed || !selection.anchorNode) return ''
  if (!stream.contains(selection.anchorNode)) return ''
  const text = selection.toString().trim()
  return text.length <= SELECTION_MAX && !/[\r\n]/.test(text) ? text : ''
}

/** 从视口顶部往下第一个看得清的命中（命中按文档顺序排好，二分查找，少碰排版）；都在上面时从第一个开始 */
function firstInView(ranges: Range[], scroller: HTMLElement | null): number {
  if (!scroller || ranges.length === 0) return 0
  const top = scroller.getBoundingClientRect().top + EDGE
  let lo = 0,
    hi = ranges.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ranges[mid].getBoundingClientRect().top < top) lo = mid + 1
    else hi = mid
  }
  return lo < ranges.length ? lo : 0
}

/** 命中在对话区里的内层滚动框（命令输出框、横向滚动的代码块）里：先在框里滚到看得见 */
function revealInBoxes(range: Range, scroller: HTMLElement): void {
  for (let el = range.startContainer.parentElement; el && el !== scroller; el = el.parentElement) {
    const tall = el.scrollHeight > el.clientHeight + 1,
      wide = el.scrollWidth > el.clientWidth + 1
    if (!tall && !wide) continue
    const style = getComputedStyle(el)
    const rect = range.getBoundingClientRect(),
      box = el.getBoundingClientRect()
    if (tall && /auto|scroll/.test(style.overflowY) && (rect.top < box.top || rect.bottom > box.bottom))
      el.scrollTop += rect.top - box.top - (el.clientHeight - rect.height) / 2
    if (wide && /auto|scroll/.test(style.overflowX) && (rect.left < box.left || rect.right > box.right))
      el.scrollLeft += rect.left - box.left - (el.clientWidth - rect.width) / 2
  }
}

/** 命中在折叠容器里是否被裁掉了：从命中往上到容器，任何一层裁切（overflow-y: hidden）把它挡住就算 */
function clipped(range: Range, folded: HTMLElement): boolean {
  const rect = range.getBoundingClientRect()
  for (let el = range.startContainer.parentElement; el && el !== folded; el = el.parentElement) {
    if (getComputedStyle(el).overflowY !== 'hidden') continue
    const box = el.getBoundingClientRect()
    if (rect.bottom > box.bottom || rect.top < box.top) return true
  }
  return false
}

/** 把一个命中滚到对话区中间（已经看得见时不动） */
function reveal(range: Range, scroller: HTMLElement): void {
  // 命中在折叠起来的长代码块、长用户消息里，并且被裁掉了：先展开（ui/code/CodeBlock.tsx、
  // session/live/ItemRows.tsx 的 UserBody），下一帧再滚过去。没被裁掉的命中不展开
  const folded = range.startContainer.parentElement?.closest<HTMLElement>('[data-folded]')
  const expand = folded?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')
  if (expand && clipped(range, folded!)) {
    expand.click()
    requestAnimationFrame(() => reveal(range, scroller))
    return
  }
  revealInBoxes(range, scroller)
  const rect = range.getBoundingClientRect(),
    box = scroller.getBoundingClientRect()
  if (rect.top >= box.top + EDGE && rect.bottom <= box.bottom - EDGE) return
  detachConversation(scroller)
  scroller.scrollTop += rect.top - box.top - (scroller.clientHeight - rect.height) / 2
}

export function ConversationFind({
  root,
  focusToken,
  onClose,
  folded,
}: {
  /** 对话流（[data-conversation-stream]）所在的区域 */
  root: RefObject<HTMLElement | null>
  /** 每次按 Ctrl+F 加一：已经打开时重新聚焦并全选 */
  focusToken: number
  onClose: () => void
  /** 数折叠着的条目里的命中；不传时不提示 */
  folded?: FoldedMatches
}) {
  useI18n()
  const owner = useId()
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(() => lastQuery)
  const [matches, setMatches] = useState<Range[]>([])
  const [index, setIndex] = useState(0)
  const [hidden, setHidden] = useState<FoldedResult | null>(null)
  // 查询变了要滚到第一个；内容更新引起的重算不滚动
  const pendingReveal = useRef(false)
  // 用选中文字替换了搜索词：等新值渲染出来再全选
  const pendingSelect = useRef(false)
  const queryRef = useRef(query)
  queryRef.current = query

  const stream = useCallback(
    (): HTMLElement | null => root.current?.querySelector<HTMLElement>('[data-conversation-stream]') ?? null,
    [root],
  )

  useEffect(() => {
    lastQuery = query
  }, [query])

  // 这个要写在下面那个前面：同一次提交里先检查，选中文字换词引起的下一次渲染才全选
  useLayoutEffect(() => {
    if (!pendingSelect.current) return
    pendingSelect.current = false
    input.current?.focus()
    input.current?.select()
  })

  useLayoutEffect(() => {
    const seeded = selectedText(stream())
    if (seeded && seeded !== queryRef.current) {
      pendingSelect.current = true
      setQuery(seeded)
      return
    }
    input.current?.focus()
    input.current?.select()
  }, [focusToken, stream])

  // 折叠内容里的命中：会话数据变了（流式输出时很频繁）、条目展开或收起时重数，最多每 250ms 一次
  const countHidden = useRef<() => void>(() => {})
  countHidden.current = () => {
    const term = searchLiteral(queryRef.current)
    setHidden(term && folded ? folded(term) : null)
  }
  const hiddenTimer = useRef(0)
  const scheduleHidden = useCallback(() => {
    if (hiddenTimer.current) return
    hiddenTimer.current = window.setTimeout(() => {
      hiddenTimer.current = 0
      countHidden.current()
    }, 250)
  }, [])
  useEffect(() => scheduleHidden(), [query, folded, scheduleHidden])
  useEffect(() => () => window.clearTimeout(hiddenTimer.current), [])

  // 查询变了：稍等再查（连续打字时不每个字都扫一遍）；从视口里的第一个命中开始，不把正在看的地方跳走
  useEffect(() => {
    const term = searchLiteral(query)
    const timer = window.setTimeout(() => {
      const el = stream()
      const next = term && el ? findRanges(el, [term]) : []
      pendingReveal.current = true
      setIndex(firstInView(next, el?.closest<HTMLElement>('.conversation-scroller') ?? null))
      setMatches(next)
    }, 80)
    return () => window.clearTimeout(timer)
  }, [query, stream])

  // 回复还在输出、展开了工具行：内容变了就重查，当前位置尽量不变
  useEffect(() => {
    const el = stream()
    const term = searchLiteral(query)
    if (!el || !term) return
    let timer = 0
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const next = findRanges(el, [term])
        setMatches(next)
        setIndex(i => Math.min(i, Math.max(0, next.length - 1)))
        scheduleHidden()
      }, 250)
    })
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [query, stream, scheduleHidden])

  useEffect(() => {
    setMarks('find-match', owner, matches)
    setMarks('find-current', owner, matches[index] ? [matches[index]] : [])
    const scroller = stream()?.closest<HTMLElement>('.conversation-scroller')
    if (pendingReveal.current && matches[index] && scroller) reveal(matches[index], scroller)
    pendingReveal.current = false
  }, [matches, index, owner, stream])

  useEffect(
    () => () => {
      setMarks('find-match', owner, [])
      setMarks('find-current', owner, [])
    },
    [owner],
  )

  const go = (delta: number): void => {
    if (matches.length === 0) return
    pendingReveal.current = true
    setIndex(i => (i + delta + matches.length) % matches.length)
  }

  const count = !searchLiteral(query)
    ? ''
    : matches.length === 0
      ? tr('content.find.none')
      : tr('content.find.count', { current: index + 1, total: matches.length })
  const hiddenCount = hidden && searchLiteral(query) ? hidden.count : 0

  return (
    <div
      role="search"
      data-conversation-find
      className="pop-in absolute top-3 right-5 z-30 flex h-9 max-w-[calc(100%-2rem)] items-center gap-1 rounded-lg border border-line bg-popover pr-1 pl-2.5 shadow-popover"
    >
      <Search size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
      <input
        ref={input}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            go(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
        aria-label={tr('content.find.label')}
        placeholder={tr('content.find.placeholder')}
        className="h-full w-44 min-w-0 bg-transparent text-list text-fg outline-none placeholder:text-fg-faint"
      />
      <span aria-live="polite" className="min-w-12 shrink-0 text-right text-meta text-fg-muted tabular-nums">
        {count}
      </span>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => {
            hidden?.expand()
            input.current?.focus()
          }}
          title={tr('content.find.expandFoldedTitle')}
          className="press h-6 shrink-0 rounded-md px-1.5 text-meta whitespace-nowrap text-accent-fg tabular-nums hover:bg-hover"
        >
          {tr(hiddenCount === 1 ? 'content.find.expandFoldedOne' : 'content.find.expandFoldedMany', {
            n: hiddenCount,
          })}
        </button>
      )}
      <IconButton
        icon={ChevronUp}
        label={tr('content.find.previous')}
        size={24}
        iconSize={14}
        disabled={matches.length === 0}
        onClick={() => go(-1)}
      />
      <IconButton
        icon={ChevronDown}
        label={tr('content.find.next')}
        size={24}
        iconSize={14}
        disabled={matches.length === 0}
        onClick={() => go(1)}
      />
      <IconButton icon={X} label={tr('content.find.close')} size={24} iconSize={14} onClick={onClose} />
    </div>
  )
}
