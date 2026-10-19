// 搜索框、项目筛选、对话内容的搜索结果（docs/mobile-remote.md §17 第 6 项、§18.3）
import { MessageSquareText, Search, X } from 'lucide-react'
import type { SearchResult } from '@pixelsky/protocol'
import { Section, Spinner, cn } from './index'

export function SearchField({
  value,
  onChange,
  placeholder,
  className = 'mx-4',
}: {
  value: string
  onChange(value: string): void
  placeholder: string
  className?: string
}) {
  return (
    <label
      className={cn(
        'flex min-h-11 items-center gap-2 rounded-xl bg-subtle px-3 text-fg-muted focus-within:text-fg-secondary',
        className,
      )}
    >
      <Search size={17} className="shrink-0" />
      <input
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        enterKeyHint="search"
        className="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-faint [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button type="button" aria-label="清除" onClick={() => onChange('')} className="-mr-1 p-1 text-fg-faint">
          <X size={16} />
        </button>
      )}
    </label>
  )
}

/** 一排可以横着滑的选项（「全部」+ 各个项目） */
export function Chips<T extends string>({
  items,
  value,
  onChange,
}: {
  items: readonly { value: T; label: string }[]
  value: T
  onChange(value: T): void
}) {
  return (
    <div role="radiogroup" className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-1">
      {items.map(i => (
        <button
          key={i.value}
          type="button"
          role="radio"
          aria-checked={i.value === value}
          onClick={() => onChange(i.value)}
          className={cn(
            'max-w-48 shrink-0 truncate rounded-full border px-3 py-1.5 text-meta',
            i.value === value
              ? 'border-transparent bg-primary text-primary-fg'
              : 'border-line-subtle bg-surface text-fg-secondary',
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  )
}

/** 对话内容里搜到的：每个会话一条（最相关的那段），标题、项目名已经在手机上筛过的不重复列 */
export function ContentResults({
  results,
  loading,
  truncated,
  when,
  onOpen,
  className,
}: {
  results: readonly SearchResult[]
  loading: boolean
  truncated: boolean
  /** 「3 分钟前」 */
  when(at: number): string
  onOpen(sessionId: string): void
  className?: string
}) {
  const seen = new Set<string>()
  const hits = results.filter(r => {
    if (r.kind === 'title' || r.kind === 'project' || seen.has(r.sessionId)) return false
    seen.add(r.sessionId)
    return true
  })
  if (!hits.length && !loading) return null
  return (
    <Section
      className={className}
      title={
        <>
          <MessageSquareText size={13} /> 对话内容
          {loading && <Spinner size={11} className="text-fg-faint" />}
        </>
      }
    >
      {hits.map((r, i) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onOpen(r.sessionId)}
          className={cn(
            'flex w-full flex-col gap-1 px-4 py-3 text-left active:bg-hover',
            i > 0 && 'border-t border-line-subtle',
          )}
        >
          <span className="line-clamp-1 text-ui">{r.title.trim() || '未命名会话'}</span>
          <span className="line-clamp-2 text-meta text-fg-muted">
            {r.snippet.map((f, j) =>
              f.match ? (
                <mark key={j} className="rounded-sm bg-accent-soft px-0.5 text-accent-fg">
                  {f.text}
                </mark>
              ) : (
                <span key={j}>{f.text}</span>
              ),
            )}
          </span>
          <span className="text-label text-fg-faint">
            {r.projectName} · {when(r.updatedAt)}
            {(r.sessionMatches ?? 0) > 1 && <> · {r.sessionMatches} 处</>}
          </span>
        </button>
      ))}
      {!hits.length && (
        <div className="flex items-center justify-center gap-2 py-4 text-meta text-fg-muted">
          <Spinner size={12} /> 正在搜对话内容…
        </div>
      )}
      {truncated && (
        <p className="border-t border-line-subtle px-4 py-2.5 text-label text-fg-faint">结果较多，只显示最相关的</p>
      )}
    </Section>
  )
}
