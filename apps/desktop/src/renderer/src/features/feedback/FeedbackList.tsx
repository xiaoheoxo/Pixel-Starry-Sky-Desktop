// 设置 › 反馈 › 列表（docs/ui/feedback.md §2.2、feedback-v2.md §4）：未读横幅、状态分段、搜索、类型标签、卡片
import { useEffect, useState } from 'react'
import { AlertCircle, Paperclip, Plus, Search, Users } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { Button, Dot, Segmented, Spinner, cn, useToast } from '@/ui'
import { SectionTitle, SettingGroup, SettingRow } from '../settings/SettingRow'
import type { FeedbackSummary } from '../../../../shared/types/feedback'
import { clip, errorText, isAuthExpired, mergeThreads } from './logic'
import { StatusWord, TypeIcon, friendlyTime } from './parts'
import { feedbackApi, markAllRead, useFeedback } from './store'
import { filterThreads, segmentCounts, shortId, type Segment, type TypeFilter } from './view'

const TYPE_FILTERS: TypeFilter[] = ['all', 'bug', 'feature', 'other']
const typeLabel = (t: TypeFilter): string =>
  t === 'all'
    ? tr('feedback.filterAll')
    : t === 'bug'
      ? tr('feedback.type.bug')
      : t === 'feature'
        ? tr('feedback.type.feature')
        : tr('feedback.type.other')

export function FeedbackList({
  onOpen,
  onNew,
  onFailed,
}: {
  onOpen: (id: string) => void
  onNew: () => void
  onFailed: (e: unknown) => void
}) {
  useI18n()
  const state = useFeedback()
  const [segment, setSegment] = useState<Segment>('active')
  const [type, setType] = useState<TypeFilter>('all')
  const [query, setQuery] = useState('')
  // 手动加载的更早几页；cursor 为 undefined 时用状态里第一页的游标
  const [older, setOlder] = useState<FeedbackSummary[]>([])
  const [cursor, setCursor] = useState<string | null | undefined>(undefined)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const next = cursor === undefined ? state.nextBefore : cursor
  const all = mergeThreads(state.threads, older)
  const counts = segmentCounts(all)
  const shown = filterThreads(all, { segment, type, query })
  const unread = all.filter(t => t.unread)
  const refresh = (): void =>
    void feedbackApi()
      .refresh()
      .catch(() => {})
  // 标记已读的状态放在这里：乐观更新会让横幅卸载，横幅里的状态会丢
  const toast = useToast()
  const [marking, setMarking] = useState(false)
  const [markFailed, setMarkFailed] = useState(false)
  useEffect(() => {
    if (unread.length === 0) setMarkFailed(false)
  }, [unread.length])
  const mark = async (): Promise<void> => {
    setMarking(true)
    setMarkFailed(false)
    const count = unread.length
    const error = await markAllRead()
    setMarking(false)
    if (error) {
      setMarkFailed(true)
      if (isAuthExpired(error)) onFailed(error)
      return
    }
    setOlder(current => current.map(t => (t.unread ? { ...t, unread: false } : t)))
    toast(tr('feedback.markedRead', { p0: count }))
  }
  const filtering = query.trim() !== '' || type !== 'all'

  const loadOlder = async (): Promise<void> => {
    if (!next || loadingOlder) return
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await feedbackApi().list(next)
      setOlder(current => mergeThreads(current, page.threads))
      setCursor(page.nextBefore)
    } catch (e) {
      setOlderError(translateMessage(errorText(e)))
      if (isAuthExpired(e)) onFailed(e)
    } finally {
      setLoadingOlder(false)
    }
  }

  return (
    <section data-feedback-list>
      <SectionTitle>{tr('feedback.title')}</SectionTitle>
      <SettingGroup>
        <SettingRow
          title={tr('feedback.send')}
          description={tr('feedback.intro')}
          control={
            <Button icon={Plus} variant="primary" onClick={onNew} data-feedback-new>
              {tr('feedback.new')}
            </Button>
          }
        />
      </SettingGroup>

      {unread.length > 0 && (
        <UnreadBanner
          unread={unread}
          onOpen={onOpen}
          onMark={() => void mark()}
          marking={marking}
          failed={markFailed}
        />
      )}

      {state.status === 'error' && all.length > 0 && (
        <p className="selectable mb-4 flex items-center gap-2 rounded-md bg-subtle px-3 py-2 text-meta text-danger">
          <span className="min-w-0 flex-1 break-all">
            {state.error ? translateMessage(state.error) : tr('feedback.retry')}
          </span>
          <button type="button" className="shrink-0 text-accent hover:underline" onClick={refresh}>
            {tr('feedback.retry')}
          </button>
        </p>
      )}

      {all.length === 0 && state.status === 'error' ? (
        // 加载失败又没有数据：给原因和重试，不能说成「还没有提交过反馈」
        <div
          data-feedback-load-error
          role="alert"
          className="mt-4 flex items-start gap-3 rounded-xl bg-surface px-5 py-4 shadow-sm"
        >
          <AlertCircle size={18} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <p className="text-ui font-medium text-fg">{tr('feedback.loadFailed')}</p>
            <p className="selectable mt-1 text-meta break-all text-fg-muted">
              {state.error ? translateMessage(state.error) : tr('feedback.loadFailedHint')}
            </p>
          </div>
          <Button onClick={refresh}>{tr('feedback.retry')}</Button>
        </div>
      ) : all.length === 0 ? (
        <div className="mt-4 flex flex-col items-start gap-3 rounded-xl bg-surface px-5 py-8 shadow-sm">
          <p className="text-ui text-fg-muted">{tr('feedback.empty')}</p>
          <Button onClick={onNew}>{tr('feedback.emptyAction')}</Button>
        </div>
      ) : (
        <>
          <div className="mt-5 mb-3 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3">
              <h4 data-setting-title={tr('feedback.mine')} className="px-0.5 text-label font-semibold text-fg-muted">
                {tr('feedback.mine')}
              </h4>
              <Segmented<Segment>
                label={tr('feedback.filter')}
                value={segment}
                onChange={setSegment}
                options={[
                  { value: 'active', label: `${tr('feedback.segActive')} ${counts.active}` },
                  { value: 'closed', label: `${tr('feedback.filterClosed')} ${counts.closed}` },
                  { value: 'all', label: `${tr('feedback.filterAll')} ${counts.all}` },
                ]}
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-transparent bg-surface px-2.5 text-fg-muted shadow-sm transition-colors focus-within:border-accent-line">
                <Search size={14} className="shrink-0" />
                <input
                  data-feedback-search
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder={tr('feedback.search')}
                  aria-label={tr('feedback.search')}
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-list text-fg outline-none placeholder:text-fg-faint"
                />
              </label>
              <div role="group" aria-label={tr('feedback.type.label')} className="flex shrink-0 items-center gap-1">
                {TYPE_FILTERS.map(t => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={type === t}
                    onClick={() => setType(t)}
                    className={cn(
                      'press h-7 rounded-full px-2.5 text-meta',
                      type === t
                        ? 'bg-accent-soft font-medium text-accent-fg'
                        : 'text-fg-muted hover:bg-hover hover:text-fg',
                    )}
                  >
                    {typeLabel(t)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {shown.length === 0 ? (
            <p className="py-8 text-ui text-fg-muted">{tr('feedback.emptyFiltered')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shown.map(t => (
                <li key={t.id}>
                  <Card thread={t} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          )}

          {segment === 'active' && counts.closed > 0 && !filtering && (
            <p className="mt-4 text-center text-meta text-fg-faint">
              {tr('feedback.onlyActive', { p0: counts.active })}{' '}
              <button type="button" className="text-accent hover:underline" onClick={() => setSegment('closed')}>
                {tr('feedback.seeClosed')}
              </button>
            </p>
          )}
        </>
      )}

      {olderError && <p className="selectable mt-2 text-meta text-danger">{olderError}</p>}
      {next && (
        <div className="mt-3 flex justify-center">
          <Button onClick={() => void loadOlder()} disabled={loadingOlder}>
            {loadingOlder ? <Spinner size={13} /> : null}
            {tr('feedback.loadOlder')}
          </Button>
        </div>
      )}
    </section>
  )
}

/** 有团队回复（或团队关闭）还没看：一条横幅，一条时写标题和预览，多条时写数量，点开第一条 */
function UnreadBanner({
  unread,
  onOpen,
  onMark,
  marking,
  failed,
}: {
  unread: FeedbackSummary[]
  onOpen: (id: string) => void
  onMark: () => void
  marking: boolean
  failed: boolean
}) {
  useI18n()
  const first = unread[0]
  const preview = clip(first.preview.replace(/\s+/g, ' ').trim(), 120)
  // 团队没回复、直接关闭的写「关闭了」
  const oneKey =
    first.status === 'closed' && first.previewAuthor !== 'team' ? 'feedback.banner.closed' : 'feedback.banner.one'
  return (
    <div
      data-feedback-banner
      className="mb-4 flex items-center gap-3 rounded-lg border border-accent-line bg-accent-soft px-4 py-3"
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-on"
      >
        <Users size={16} strokeWidth={1.6} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui font-medium text-fg">
          {unread.length > 1 ? tr('feedback.banner.many', { p0: unread.length }) : tr(oneKey, { p0: first.title })}
        </p>
        {failed ? (
          <p role="alert" data-feedback-mark-error className="truncate text-meta text-danger">
            {tr('feedback.markReadFailed')}
          </p>
        ) : (
          unread.length === 1 && preview && <p className="truncate text-meta text-fg-muted">{preview}</p>
        )}
      </div>
      <Button variant="ghost" data-feedback-mark-read disabled={marking} onClick={onMark}>
        {unread.length > 1 ? tr('feedback.markAllRead') : tr('feedback.markOneRead')}
      </Button>
      <Button onClick={() => onOpen(first.id)}>{tr('feedback.attach.view')}</Button>
    </div>
  )
}

function Card({ thread, onOpen }: { thread: FeedbackSummary; onOpen: (id: string) => void }) {
  useI18n()
  const preview = thread.preview.replace(/\s+/g, ' ').trim()
  const closed = thread.status === 'closed'
  const meta = [
    thread.messageCount > 0 ? tr('feedback.meta.messages', { p0: thread.messageCount }) : null,
    thread.attachments.logs > 0 ? tr('feedback.meta.logs') : null,
    thread.attachments.images > 0 ? tr('feedback.meta.images', { p0: thread.attachments.images }) : null,
    shortId(thread.id),
  ].filter((x): x is string => x !== null)
  return (
    <button
      type="button"
      data-feedback-item={thread.id}
      data-unread={thread.unread || undefined}
      onClick={() => onOpen(thread.id)}
      className={cn(
        'press flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left shadow-sm transition-colors hover:bg-hover',
        thread.unread ? 'border-accent-line bg-accent-soft/40' : 'border-transparent bg-surface',
        closed && 'opacity-80',
      )}
    >
      <TypeIcon type={thread.type} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {thread.unread && <Dot tone="notify" size={7} />}
          <span className={cn('min-w-0 flex-1 truncate text-ui text-fg', thread.unread && 'font-medium')}>
            {thread.title}
          </span>
        </span>
        {preview && (
          <span className="mt-0.5 flex items-center gap-1.5 text-meta text-fg-muted">
            <span className="shrink-0 rounded bg-subtle px-1 text-label text-fg-secondary">
              {thread.previewAuthor === 'team' ? tr('feedback.teamShort') : tr('feedback.you')}
            </span>
            <span className="min-w-0 truncate">{preview}</span>
          </span>
        )}
        <span className="mt-1 flex items-center gap-1 text-label text-fg-faint">
          {(thread.attachments.logs > 0 || thread.attachments.images > 0) && <Paperclip size={11} />}
          <span className="truncate">{meta.join(' · ')}</span>
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <StatusWord thread={thread} />
        <span className="text-label text-fg-faint">{friendlyTime(thread.updatedAt)}</span>
      </span>
    </button>
  )
}
