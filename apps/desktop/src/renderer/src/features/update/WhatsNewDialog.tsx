// 更新后的「更新内容」弹窗（GitHub #13，docs/release-update.md §8）：每个版本只弹一次；「不再提示」以后都不弹，关于页能再打开。
// 说明按「亮点 / 新功能 / 改动 / 修复」分组，每条开头加粗的一句当标题；亮点排最前、做成强调色卡片；正文里的 **加粗** 用正文色突出；
// 跳过了几版时最新的展开、其余折叠；更早的版本在底下能翻
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, ExternalLink, RefreshCw, Sparkles, Star, Wrench, X, type LucideIcon } from 'lucide-react'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Markdown } from '@/ui/markdown/Markdown'
import {
  countKinds,
  issueUrl,
  noteWhatsNewShown,
  notesFor,
  olderNotes,
  parseNotes,
  startWhatsNew,
  useWhatsNew,
  whatsNewActions,
  type NoteItem,
  type NoteSection,
  type SectionKind,
  type VersionNotes,
} from './whatsNew'

const KIND_STYLE: Record<SectionKind, { icon: LucideIcon; tone: string }> = {
  highlight: { icon: Star, tone: 'text-accent-on bg-accent' },
  feature: { icon: Sparkles, tone: 'text-accent-fg bg-accent-soft' },
  change: { icon: RefreshCw, tone: 'text-warn bg-warn/10' },
  fix: { icon: Wrench, tone: 'text-success bg-success/10' },
  other: { icon: ChevronRight, tone: 'text-fg-muted bg-subtle' },
}
const ORDER: SectionKind[] = ['highlight', 'feature', 'change', 'fix', 'other']
/** 正文里的 **加粗**：用正文色、加重，长条目里一眼看到重点 */
const STRONG = '[&_strong]:font-semibold [&_strong]:text-fg'

export function WhatsNewDialog() {
  useI18n()
  const { open, manual } = useWhatsNew()
  useEffect(startWhatsNew, [])
  if (!open) return null
  return <Dialog key={open.version} version={open.version} previous={open.previous} manual={manual} />
}

function Dialog({ version, previous, manual }: { version: string; previous: string | null; manual: boolean }) {
  const ref = useRef<HTMLDivElement>(null),
    done = useRef<HTMLButtonElement>(null),
    titleId = useId()
  const notes = useMemo(() => notesFor({ version, previous }), [version, previous])
  const older = useMemo(() => olderNotes({ version, previous }), [version, previous])
  const total = useMemo(() => countKinds(notes.flatMap(n => parseNotes(n.text))), [notes])
  const logged = useRef(false)
  useEffect(() => {
    // StrictMode 下效果会跑两遍，只记一次
    if (logged.current) return
    logged.current = true
    noteWhatsNewShown({ version, previous }, manual, notes.length)
  }, [version, previous, manual, notes.length])
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    done.current?.focus({ preventScroll: true })
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        whatsNewActions.close(false, 'esc')
      }
      if (event.key === 'Tab') {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? [])]
        const first = items[0],
          last = items.at(-1)
        if (!first || !last) return
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('keydown', key, true)
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])
  const subtitle =
    notes.length > 1
      ? tr('whatsNew.included', { p0: notes.length })
      : previous && previous !== version
        ? tr('whatsNew.from', { p0: previous })
        : null
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-scrim p-6"
      onMouseDown={event => {
        if (event.target === event.currentTarget) whatsNewActions.close(false, 'backdrop')
      }}
    >
      <div
        ref={ref}
        data-whats-new={version}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="pop-in flex max-h-[min(720px,88vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line-card bg-popover text-fg shadow-popover outline-none"
      >
        <div className="flex shrink-0 items-start gap-3 px-6 pt-5 pb-4">
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="text-section font-semibold">
              {tr(manual ? 'whatsNew.history' : 'whatsNew.title', { p0: version })}
            </h3>
            {subtitle && <p className="mt-0.5 text-meta text-fg-muted">{subtitle}</p>}
            <KindCounts counts={total} className="mt-2.5" />
          </div>
          <button
            type="button"
            aria-label={tr('whatsNew.close')}
            title={tr('whatsNew.close')}
            onClick={() => whatsNewActions.close(false, 'x')}
            className="press no-drag -mt-1 -mr-2 flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
        <div className="selectable min-h-0 flex-1 overflow-y-auto border-y border-line-subtle px-6 py-4">
          {notes.map((n, i) =>
            notes.length > 1 ? (
              <VersionBlock key={n.version} notes={n} current={n.version === version} initiallyOpen={i === 0} />
            ) : (
              <Sections key={n.version} version={n.version} sections={parseNotes(n.text)} />
            ),
          )}
          {older.length > 0 && (
            <div data-whats-new-older className="mt-6">
              <p className="mb-1 text-label font-medium text-fg-faint">{tr('whatsNew.older')}</p>
              {older.map(n => (
                <VersionBlock key={n.version} notes={n} current={false} initiallyOpen={false} />
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 py-3">
          <button
            type="button"
            onClick={() => void window.pixelsky?.app.open('releases')}
            className="press no-drag -ml-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-meta text-fg-secondary hover:bg-hover hover:text-fg"
          >
            <ExternalLink size={13} strokeWidth={1.5} />
            {tr('whatsNew.fullLog')}
          </button>
          <div className="flex-1" />
          {!manual && (
            <button
              type="button"
              onClick={() => whatsNewActions.close(true, 'mute')}
              className="press rounded-md px-3 py-2 text-ui text-fg-secondary hover:bg-hover hover:text-fg"
            >
              {tr('whatsNew.mute')}
            </button>
          )}
          <button
            ref={done}
            type="button"
            onClick={() => whatsNewActions.close(false, 'done')}
            className="press rounded-md bg-primary px-3 py-2 text-ui font-medium text-primary-fg"
          >
            {tr(manual ? 'whatsNew.close' : 'whatsNew.done')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 「3 项新功能 · 5 项修复」 */
function KindCounts({ counts, className }: { counts: Partial<Record<SectionKind, number>>; className?: string }) {
  const kinds = ORDER.filter(k => counts[k])
  if (!kinds.length) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {kinds.map(kind => {
        const { icon: Icon, tone } = KIND_STYLE[kind]
        return (
          <span
            key={kind}
            className={cn('inline-flex h-5 items-center gap-1 rounded-full px-2 text-label font-medium', tone)}
          >
            <Icon size={11} strokeWidth={2} />
            {tr(`whatsNew.count.${kind}`, { p0: counts[kind] })}
          </span>
        )
      })}
    </div>
  )
}

/** 一版：标题行点开 / 收起；收起时显示各组条数 */
function VersionBlock({
  notes,
  current,
  initiallyOpen,
}: {
  notes: VersionNotes
  current: boolean
  initiallyOpen: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const sections = useMemo(() => parseNotes(notes.text), [notes.text])
  return (
    <section data-whats-new-version={notes.version} className="border-b border-line-subtle last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="press flex h-10 w-full items-center gap-2 rounded-md text-left hover:bg-hover"
      >
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          className={cn('shrink-0 text-fg-muted transition-transform', open && 'rotate-90')}
        />
        <span className="text-ui font-semibold text-fg">{notes.version}</span>
        {current && (
          <span className="rounded-full bg-accent-soft px-1.5 text-label font-medium text-accent-fg">
            {tr('whatsNew.current')}
          </span>
        )}
        <span className="flex-1" />
        {!open && <KindCounts counts={countKinds(sections)} className="mr-1" />}
      </button>
      {open && (
        <div className="pt-1 pb-4 pl-6">
          <Sections version={notes.version} sections={sections} />
        </div>
      )}
    </section>
  )
}

function Sections({ version, sections }: { version: string; sections: NoteSection[] }) {
  return (
    <div data-whats-new-notes={version} className="space-y-5">
      {[...sections]
        .sort((a, b) => Number(b.kind === 'highlight') - Number(a.kind === 'highlight'))
        .map((section, i) => (
          <Section key={`${section.heading}-${i}`} section={section} />
        ))}
    </div>
  )
}

function Section({ section }: { section: NoteSection }) {
  const { icon: Icon, tone } = KIND_STYLE[section.kind]
  return (
    <div data-whats-new-section={section.kind}>
      {section.heading && (
        <h4 className="mb-2 flex items-center gap-1.5">
          <span className={cn('inline-flex size-5 items-center justify-center rounded-md', tone)}>
            <Icon size={12} strokeWidth={2} />
          </span>
          <span className="text-ui font-semibold text-fg">
            {section.kind === 'other' ? section.heading : tr(`whatsNew.kind.${section.kind}`)}
          </span>
          <span className="text-meta text-fg-faint tabular-nums">{section.items.length}</span>
        </h4>
      )}
      {section.kind === 'highlight' ? (
        <ul className="grid gap-2">
          {section.items.map((item, i) => (
            <Highlight key={i} item={item} />
          ))}
        </ul>
      ) : (
        <ul className="space-y-2.5">
          {section.items.map((item, i) => (
            <Item key={i} item={item} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** 亮点：强调色细边框的卡片，标题用强调色 */
function Highlight({ item }: { item: NoteItem }) {
  return (
    <li className="rounded-lg border border-accent-line bg-accent-soft/50 px-3.5 py-2.5">
      {item.title && <p className="text-ui leading-relaxed font-semibold text-accent-fg">{item.title}</p>}
      {item.body && (
        <Markdown
          text={item.body}
          className={cn(
            'text-list leading-relaxed text-fg-body',
            item.title && 'mt-0.5',
            STRONG,
            '[&_li]:my-0.5 [&_p]:my-0 [&_ul]:my-1',
          )}
        />
      )}
    </li>
  )
}

function Item({ item }: { item: NoteItem }) {
  const issues: ReactNode = item.issues.map(n => (
    <a
      key={n}
      href={issueUrl(n)}
      target="_blank"
      rel="noreferrer"
      title={tr('whatsNew.issue', { p0: n })}
      className="ml-1.5 inline-flex h-[18px] items-center rounded-full border border-line-card px-1.5 align-[1px] text-label font-normal text-fg-muted no-underline hover:border-line-strong hover:text-fg"
    >
      #{n}
    </a>
  ))
  return (
    <li className="relative pl-3.5 before:absolute before:top-[0.6em] before:left-0 before:size-1 before:rounded-full before:bg-fg-faint">
      {item.title && (
        <p className="text-ui leading-relaxed font-medium text-fg">
          {item.title}
          {issues}
        </p>
      )}
      {item.body && (
        <Markdown
          text={item.body}
          className={cn(
            'text-list leading-relaxed',
            item.title ? 'mt-0.5 text-fg-secondary' : 'text-fg-body',
            STRONG,
            '[&_li]:my-0.5 [&_p]:my-0 [&_ul]:my-1',
          )}
        />
      )}
      {!item.title && item.issues.length > 0 && <p className="-mt-0.5">{issues}</p>}
    </li>
  )
}
