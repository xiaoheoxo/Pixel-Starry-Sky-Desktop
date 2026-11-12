import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useContext, useMemo, useState } from 'react'
import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/ui'
import { highlightSegments, languageFromPath } from './highlight'
import { cutSegments, wordDiffRanges } from './wordDiff'
import { DiffCommentsContext, diffLineNumbers, type DiffComment, type DiffCommentsApi } from './diffComments'

/**
 * 带颜色的 diff（只用设计变量：增加行绿底、删除行红底）。给了 path 且认得文件类型时做语法高亮：
 * 行首 +/− 保持绿 / 红，代码本身用 --syn-* 着色（参考 Mirasim）。见 docs/ui/code-highlight.md
 * 成对的删除 / 增加行里真正变化的词再加深一层底色（docs/ui/content-highlight.md §2 C）。
 * 会话视图提供评论接口时，鼠标移到行上可以写评论（docs/ui/rewind-fork-sidechat.md §4）。
 */
export function DiffView({
  diff,
  path,
  className,
  commentable = true,
  maxLines,
}: {
  diff: string
  path?: string
  className?: string
  /** 只画前这么多行，不带「显示剩余」：外面限了高、有自己的「展开」（对话里详细模式自动展开的改动） */
  maxLines?: number
  /** 审批卡片里的 diff 不评论 */
  commentable?: boolean
}) {
  useI18n()
  const allLines = useMemo(() => diff.split('\n'), [diff])
  // 很长的 diff 先只画前 DIFF_LINE_LIMIT 行（高亮、逐词对比也只算这些），点「显示剩余」再全画
  // （原来几千行一挂载就是一个长任务，docs/perf-audit-2026-10-18.md B4）
  const [all, setAll] = useState(false)
  const limit = maxLines ?? (all ? Infinity : DIFF_LINE_LIMIT)
  const lines = useMemo(() => (allLines.length <= limit ? allLines : allLines.slice(0, limit)), [allLines, limit])
  const rest = maxLines === undefined ? allLines.length - lines.length : 0
  const lang = useMemo(() => languageFromPath(path), [path])
  // 去掉每行开头的 +/−/空格 后整段高亮（跨行的注释、字符串颜色才对）；@@ 段头和 ---/+++ 文件头不参与
  const segments = useMemo(
    () => highlightSegments(lines.map(l => (isCodeLine(l) ? l.slice(1) : '')).join('\n'), lang),
    [lines, lang],
  )
  // 只画前几行时，逐词对比要成对的两边都在：比到这一段删除 / 增加结束为止，画出来的行和画全时一样
  const words = useMemo(() => {
    if (maxLines === undefined) return wordDiffRanges(lines)
    let end = lines.length
    while (end < allLines.length && end < DIFF_LINE_LIMIT && /^[+-]/.test(allLines[end]!)) end++
    return wordDiffRanges(allLines.slice(0, end))
  }, [lines, allLines, maxLines])
  const numbers = useMemo(() => diffLineNumbers(allLines), [allLines])
  const api = useContext(DiffCommentsContext)
  const comments = commentable && api && path ? api : null
  const existing = comments && path ? comments.list(path) : []
  const [editing, setEditing] = useState<{ index: number; id: string | null } | null>(null)
  if (!diff)
    return (
      <div className={cn('px-3 py-2 text-meta text-fg-faint', className)}>
        {tr('session.live.ItemRows.noChangesToDisplay')}
      </div>
    )
  return (
    <pre className={cn('overflow-auto font-mono text-meta leading-[1.6]', className)}>
      {lines.map((line, i) => {
        const code = isCodeLine(line)
        const added = line.startsWith('+'),
          removed = line.startsWith('-')
        const num = numbers[i]
        const here = num ? existing.filter(c => c.line === num.n && c.side === num.side) : []
        return (
          <div key={i}>
            <div
              data-diff-line={num ? `${num.side}:${num.n}` : undefined}
              className={cn(
                'group/line relative px-3 whitespace-pre',
                added && cn('bg-success/10', lang && code ? 'text-fg' : 'text-success'),
                removed && cn('bg-danger/10', lang && code ? 'text-fg' : 'text-danger'),
                line.startsWith('@@') && 'text-fg-faint',
                line.startsWith(' ') && 'text-fg-secondary',
              )}
            >
              {comments && num && (
                <button
                  type="button"
                  aria-label={tr('review.add')}
                  title={tr('review.add')}
                  onClick={() => setEditing({ index: i, id: null })}
                  className="absolute top-0 left-0 hidden h-full w-3 items-center justify-center bg-accent text-accent-on group-hover/line:flex focus-visible:flex"
                >
                  <MessageSquarePlus size={9} strokeWidth={2} />
                </button>
              )}
              {code ? (
                <>
                  <span className={added ? 'text-success' : removed ? 'text-danger' : undefined}>{line[0]}</span>
                  {cutSegments(segments[i] ?? [], words.get(i) ?? []).map((s, j) => (
                    <span
                      key={j}
                      className={cn(
                        s.className,
                        s.changed && 'rounded-[2px]',
                        s.changed && (added ? 'bg-success/25' : 'bg-danger/25'),
                      )}
                    >
                      {s.text}
                    </span>
                  ))}
                </>
              ) : (
                line || ' '
              )}
            </div>
            {comments &&
              num &&
              here.map(c =>
                editing?.id === c.id ? (
                  <CommentEditor
                    key={c.id}
                    initial={c.text}
                    onSave={text => {
                      comments.update(c.id, text)
                      setEditing(null)
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <CommentNote
                    key={c.id}
                    comment={c}
                    api={comments}
                    onEdit={() => setEditing({ index: i, id: c.id })}
                  />
                ),
              )}
            {comments && num && editing?.index === i && editing.id === null && (
              <CommentEditor
                initial=""
                onSave={text => {
                  comments.add({ path: path!, line: num.n, side: num.side, code: code ? line.slice(1) : line, text })
                  setEditing(null)
                }}
                onCancel={() => setEditing(null)}
              />
            )}
          </div>
        )
      })}
      {rest > 0 && (
        <button
          type="button"
          data-diff-more
          onClick={() => setAll(true)}
          className="sticky left-0 mx-3 my-1.5 rounded-md border border-line px-2 py-0.5 font-sans text-meta text-fg-secondary hover:bg-hover"
        >
          {tr('ui.DiffView.showRest', { n: rest })}
        </button>
      )}
    </pre>
  )
}

/** 一次最多画多少行；超过的点按钮再画 */
export const DIFF_LINE_LIMIT = 400

const BOX = 'mx-3 my-1.5 max-w-[560px] rounded-lg border border-line bg-surface font-sans whitespace-normal'

function CommentEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string
  onSave: (text: string) => void
  onCancel: () => void
}) {
  useI18n()
  const [text, setText] = useState(initial)
  const save = (): void => {
    if (text.trim()) onSave(text.trim())
  }
  return (
    <div className={cn(BOX, 'p-2')} data-diff-comment-editor>
      <textarea
        autoFocus
        rows={2}
        value={text}
        placeholder={tr('review.placeholder')}
        aria-label={tr('review.add')}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
        className="w-full resize-y rounded-md border border-line bg-app px-2 py-1.5 text-list text-fg outline-none placeholder:text-fg-faint focus:border-line-strong"
      />
      <div className="mt-1.5 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="press rounded-md px-2.5 py-1 text-meta text-fg-secondary hover:bg-hover"
        >
          {tr('review.cancel')}
        </button>
        <button
          type="button"
          disabled={!text.trim()}
          onClick={save}
          className="press rounded-md bg-accent px-2.5 py-1 text-meta text-accent-on disabled:opacity-50"
        >
          {tr('review.save')}
        </button>
      </div>
    </div>
  )
}

function CommentNote({ comment, api, onEdit }: { comment: DiffComment; api: DiffCommentsApi; onEdit: () => void }) {
  useI18n()
  return (
    <div
      className={cn(BOX, 'group/note flex items-start gap-2 border-l-2 border-l-accent px-3 py-2')}
      data-diff-comment={comment.id}
    >
      <p className="min-w-0 flex-1 text-list break-words whitespace-pre-wrap text-fg">{comment.text}</p>
      <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover/note:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          aria-label={tr('review.edit')}
          title={tr('review.edit')}
          onClick={onEdit}
          className="press inline-flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
        >
          <Pencil size={12} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label={tr('review.delete')}
          title={tr('review.delete')}
          onClick={() => api.remove(comment.id)}
          className="press inline-flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-danger"
        >
          <Trash2 size={12} strokeWidth={1.5} />
        </button>
      </span>
    </div>
  )
}

/** 带 +/−/空格 前缀的代码行（不是 @@ 段头，也不是 ---/+++ 文件头） */
function isCodeLine(line: string): boolean {
  if (line.startsWith('+++') || line.startsWith('---')) return false
  return line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')
}
