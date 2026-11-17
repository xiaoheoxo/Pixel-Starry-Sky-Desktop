// 计划审阅（docs/ui/plan-review.md）：计划分段显示，选中文字或按段批注；意见写在固定的输入区；可放大成盖住对话窗格的全屏审阅
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { PermissionMode } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { IconButton, cn } from '@/ui'
import { Markdown } from '@/ui/markdown/Markdown'
import { tr } from '../../../i18n/core'
import { EMPTY_PLAN_DRAFT, noteCount, quoteOf, type PlanDraft, type PlanSection } from './planReviewModel'

// 草稿按审批请求记在内存里：卡片卸载（切走对话太久）再挂回来还在；批准或打回时清掉
const drafts = new Map<string, PlanDraft>()
const DRAFTS_MAX = 20

export function usePlanDraft(requestId: string): [PlanDraft, (next: PlanDraft) => void, () => void] {
  const [draft, setState] = useState(() => drafts.get(requestId) ?? EMPTY_PLAN_DRAFT)
  const set = (next: PlanDraft): void => {
    drafts.delete(requestId)
    drafts.set(requestId, next)
    if (drafts.size > DRAFTS_MAX) drafts.delete(drafts.keys().next().value!)
    setState(next)
  }
  return [draft, set, () => void drafts.delete(requestId)]
}

/** 计划卡要会话层帮忙做的事（SessionView 提供） */
export interface PlanActions {
  /** 「压缩上下文后执行」：卡片打回之后压缩、再发计划；引擎不支持压缩时不给，按钮不显示 */
  compact?: (plan: string) => Promise<void>
  /** 引擎打回计划时不带话（像素星空只回「继续完善」）：意见作为下一条消息发 */
  feedback?: (message: string) => Promise<void>
  /** 批准后用哪档执行（docs/ui/plan-mode-split.md）：「开始执行」按钮上写明；不在计划中时不给 */
  returnLevel?: PermissionMode
}

interface Editing {
  sections: readonly PlanSection[]
  draft: PlanDraft
  setDraft: (next: PlanDraft) => void
}

const INPUT =
  'w-full resize-none bg-transparent text-list leading-[1.6] text-fg outline-none field-sizing-content placeholder:text-fg-faint'

/** 加一条意见，焦点放到它的输入框里（root 里找：卡片和全屏各有一份） */
function addNote(e: Editing, root: HTMLElement | null, section: number, quote: string | null): void {
  const id = crypto.randomUUID()
  e.setDraft({ ...e.draft, notes: [...e.draft.notes, { id, section, quote, text: '' }] })
  requestAnimationFrame(() => root?.querySelector<HTMLTextAreaElement>(`[data-plan-note="${id}"]`)?.focus())
}

function jumpTo(root: HTMLElement | null, section: number): void {
  const el = root?.querySelector<HTMLElement>(`[data-plan-section="${section}"]`)
  if (!el) return
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  el.animate([{ backgroundColor: 'var(--color-accent-soft)' }, { backgroundColor: 'transparent' }], 900)
}

/** 计划正文：一段一块，悬停出「批注」；选中文字时浮出「＋ 批注」 */
function PlanSections({ editing, root }: { editing: Editing; root: RefObject<HTMLElement | null> }) {
  useI18n()
  const box = useRef<HTMLDivElement>(null)
  const [float, setFloat] = useState<{ x: number; y: number; section: number; quote: string } | null>(null)
  const noted = new Set(editing.draft.notes.filter(n => n.text.trim()).map(n => n.section))

  useEffect(() => {
    if (!float) return
    const hide = (): void => {
      if (getSelection()?.isCollapsed !== false) setFloat(null)
    }
    // 只在计划所在的滚动区（或它的外层）滚动时收起；别的窗格在滚（流式输出）不管
    const drop = (e: Event): void => {
      if (e.target instanceof Node && e.target.contains(box.current)) setFloat(null)
    }
    document.addEventListener('selectionchange', hide)
    document.addEventListener('scroll', drop, true)
    return () => {
      document.removeEventListener('selectionchange', hide)
      document.removeEventListener('scroll', drop, true)
    }
  }, [float])

  const onMouseUp = (): void => {
    const sel = getSelection()
    const text = sel && !sel.isCollapsed ? quoteOf(sel.toString()) : ''
    const at = (node: Node | null | undefined): HTMLElement | null =>
      (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-plan-section]') ?? null
    const section = at(sel?.anchorNode)
    // 只认落在同一段里、在这块计划里的选区
    if (!text || !section || section !== at(sel?.focusNode) || !box.current?.contains(section)) return setFloat(null)
    const rect = sel!.getRangeAt(0).getBoundingClientRect()
    setFloat({
      x: Math.min(rect.right, window.innerWidth - 96),
      y: Math.max(8, rect.top - 34),
      section: Number(section.dataset.planSection),
      quote: text,
    })
  }

  return (
    <div ref={box} className="selectable" onMouseUp={onMouseUp}>
      {editing.sections.map((s, i) => (
        <div
          key={i}
          data-plan-section={i}
          className={cn(
            'group relative -ml-3 rounded-r-md border-l-2 py-1 pr-1 pl-3',
            noted.has(i) ? 'border-accent' : 'border-transparent',
          )}
        >
          <button
            type="button"
            className="absolute top-1 right-0 z-[1] rounded-md border border-line bg-surface px-2 py-0.5 text-meta text-fg-muted opacity-0 group-hover:opacity-100 hover:border-line-strong hover:text-fg focus-visible:opacity-100"
            onClick={() => addNote(editing, root.current, i, null)}
          >
            {tr('plan.note')}
          </button>
          <Markdown text={s.text} />
        </div>
      ))}
      {float &&
        createPortal(
          <button
            type="button"
            data-plan-float
            style={{ left: float.x, top: float.y }}
            className="fixed z-50 rounded-lg bg-primary px-2.5 py-1 text-meta font-medium text-primary-fg shadow-menu"
            // 不让点按钮清掉选区
            onMouseDown={e => e.preventDefault()}
            onClick={() => {
              const { section, quote } = float
              setFloat(null)
              getSelection()?.removeAllRanges()
              addNote(editing, root.current, section, quote)
            }}
          >
            {tr('plan.noteSelection')}
          </button>,
          document.body,
        )}
    </div>
  )
}

/** 意见列表：一条一张小卡（引用 + 输入框 + 删除） */
function NoteList({ editing, root }: { editing: Editing; root: RefObject<HTMLElement | null> }) {
  useI18n()
  const { sections, draft, setDraft } = editing
  return (
    <>
      {draft.notes.map(n => {
        const s = sections[n.section]
        return (
          <div
            key={n.id}
            className="flex flex-col gap-0.5 rounded-lg border border-line bg-surface py-1.5 pr-1.5 pl-2.5 focus-within:border-accent-line"
          >
            <div className="flex min-w-0 items-baseline gap-1.5 text-meta text-fg-muted">
              <span className="shrink-0 font-semibold text-accent-fg">{s?.title ?? tr('plan.untitled')}</span>
              <button
                type="button"
                title={tr('plan.jump')}
                className="min-w-0 flex-1 truncate text-left hover:text-accent-fg"
                onClick={() => jumpTo(root.current, n.section)}
              >
                {n.quote ? tr('plan.quoted', { text: n.quote }) : `${tr('plan.wholeSection')} · ${s?.first ?? ''}`}
              </button>
              <IconButton
                icon={X}
                label={tr('plan.deleteNote')}
                size={20}
                iconSize={13}
                onClick={() => setDraft({ ...draft, notes: draft.notes.filter(x => x.id !== n.id) })}
              />
            </div>
            <textarea
              rows={1}
              data-plan-input
              data-plan-note={n.id}
              value={n.text}
              placeholder={tr('plan.notePlaceholder')}
              className={cn(INPUT, 'max-h-40')}
              onChange={e =>
                setDraft({
                  ...draft,
                  notes: draft.notes.map(x => (x.id === n.id ? { ...x, text: e.target.value } : x)),
                })
              }
            />
          </div>
        )
      })}
    </>
  )
}

function WholeInput({ editing, keys }: { editing: Editing; keys: string }) {
  useI18n()
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2 focus-within:border-accent-line">
      <textarea
        rows={2}
        data-plan-input
        value={editing.draft.whole}
        placeholder={tr('plan.wholePlaceholder')}
        className={cn(INPUT, 'max-h-40 min-h-[2lh]')}
        onChange={e => editing.setDraft({ ...editing.draft, whole: e.target.value })}
      />
      <p className="text-label text-fg-faint">{tr('plan.wholeHint', { keys })}</p>
    </div>
  )
}

/** 卡片里的计划正文和意见区；open 时另外在对话窗格上盖一层全屏审阅（同一份草稿） */
export function PlanReview({
  editing,
  keys,
  open,
  onClose,
  actions,
  title,
}: {
  editing: Editing
  /** 「Ctrl+Enter」或「⌘+Enter」 */
  keys: string
  open: boolean
  onClose: () => void
  /** 底部按钮（和卡片底部同一组），全屏里竖排 */
  actions: ReactNode
  title: string
}) {
  useI18n()
  const card = useRef<HTMLDivElement>(null)
  const full = useRef<HTMLDivElement>(null)
  // 盖住的是卡片所在的对话窗格（main 是 relative）
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => setHost(card.current?.closest('main') ?? null), [])
  useEffect(() => {
    if (open) full.current?.focus()
  }, [open])
  // 关掉全屏：焦点回到卡片的第一个按钮，卡片的快捷键接着能用
  const close = (): void => {
    onClose()
    card.current?.closest('[data-approval-card]')?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
  }
  const n = noteCount(editing.draft)

  return (
    <div ref={card} className="flex min-h-0 flex-col">
      <div
        data-approval-plan
        className="max-h-[28vh] min-h-16 overflow-auto rounded-lg border border-line bg-wall-tint px-4 py-2"
      >
        <PlanSections editing={editing} root={card} />
      </div>
      <p className="mt-1.5 shrink-0 text-label text-fg-faint">{tr('plan.tip')}</p>
      {editing.draft.notes.length > 0 && (
        <div className="mt-2 flex max-h-40 shrink-0 flex-col gap-1.5 overflow-auto p-0.5">
          <NoteList editing={editing} root={card} />
        </div>
      )}
      <div className="mt-2 shrink-0">
        <WholeInput editing={editing} keys={keys} />
      </div>

      {open &&
        host &&
        createPortal(
          <div
            ref={full}
            tabIndex={-1}
            data-plan-review
            className="@container absolute inset-0 z-40 flex flex-col bg-surface outline-none"
            onKeyDown={e => {
              if (e.key !== 'Escape' || e.nativeEvent.isComposing) return
              e.preventDefault()
              close()
            }}
          >
            <header className="flex shrink-0 items-center gap-2.5 border-b border-line-subtle px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-ui font-semibold text-fg">
                {tr('plan.reviewTitle')} · {title}
              </span>
              {n > 0 && <span className="text-meta font-medium text-accent-fg">{tr('plan.notes', { n })}</span>}
              <span className="text-meta text-fg-faint">{tr('approvals.waiting')}</span>
              <IconButton icon={X} label={`${tr('plan.close')} · Esc`} onClick={close} />
            </header>
            <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] @min-[900px]:grid-cols-[minmax(0,1fr)_340px] @min-[900px]:grid-rows-1">
              <div className="overflow-auto px-8 py-5">
                <div className="mx-auto max-w-[720px]">
                  <PlanSections editing={editing} root={full} />
                </div>
              </div>
              <aside className="flex max-h-[45vh] min-h-0 flex-col border-t border-line-subtle bg-wall-tint @min-[900px]:max-h-none @min-[900px]:border-t-0 @min-[900px]:border-l">
                <div className="px-4 pt-3.5 pb-2 text-meta font-semibold text-fg-secondary">{tr('plan.feedback')}</div>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-4 pb-2">
                  {editing.draft.notes.length ? (
                    <NoteList editing={editing} root={full} />
                  ) : (
                    <p className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-meta leading-relaxed text-fg-faint">
                      {tr('plan.emptyNotes')}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-2.5 border-t border-line-subtle px-4 py-3">
                  <WholeInput editing={editing} keys={keys} />
                  <div className="flex flex-wrap gap-2 [&>*]:flex-1 [&>*]:justify-center [&>*:first-child]:basis-full">
                    {actions}
                  </div>
                </div>
              </aside>
            </div>
          </div>,
          host,
        )}
    </div>
  )
}
