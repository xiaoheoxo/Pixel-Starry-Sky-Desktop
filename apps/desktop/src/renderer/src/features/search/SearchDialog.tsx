import { scrollInPane } from '@/ui/scrollInPane'
import { ENGINES, searchSnippet, searchTerms } from '@pixelsky/protocol'
import { openTask } from '@/features/panel/openTask'
import { useI18n } from '@/i18n/I18nProvider'
import { getLocale, tr, translateMessage } from '../../i18n/core'
import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ChevronRight, CornerDownLeft, Folder, Hash, MessageSquare, Search, SquareTerminal, X } from 'lucide-react'
import type { SearchQuery, SearchResponse, SearchResult, SearchScope } from '@pixelsky/protocol'
import { IconButton, Spinner, cn } from '@/ui'
import { OPEN_SESSION_EVENT, bridge, useEngineState } from '@/features/engine'
import { isDemo } from '@/data'
import { ProjectFilter } from './ProjectFilter'
import { demo } from '@/data/demo'
import { openFile } from '@/features/files/store'
import { FileIcon } from '@/features/files/icons/FileIcon'
import { isIgnoredPath, partitionIgnored, useIgnoredSet } from '@/features/files/ignored'
import { useActiveWorkspace } from '@/features/editor/target'
import { demoFileHits, searchFiles, type FileHit, type FileHits } from './fileSearch'
import { groupResults, titleFragments, type ResultGroup } from './groupResults'
import { fieldLabel, projectLabel } from './fieldLabel'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import type { ChannelSearchHit, ChannelSearchResult } from '../../../../shared/types/channels'
import { setPage } from '@/features/layout/page'
import { channelActions, useChannels } from '@/features/channels/store'
import { hitPlace, NO_HITS, searchChannelMessages } from '@/features/channels/search'

/** 「项目文件」「频道消息」只在界面里，不发给会话搜索 */
type Scope = SearchScope | 'files' | 'channels'

const SCOPES: Array<{ id: Scope; name: string }> = [
  {
    id: 'all',
    get name() {
      return tr('search.SearchDialog.allContent')
    },
  },
  {
    id: 'titles',
    get name() {
      return tr('search.SearchDialog.conversationTitles')
    },
  },
  {
    id: 'messages',
    get name() {
      return tr('search.SearchDialog.messages')
    },
  },
  {
    id: 'tools',
    get name() {
      return tr('search.SearchDialog.toolContent')
    },
  },
  {
    id: 'files',
    get name() {
      return tr('search.SearchDialog.projectFiles')
    },
  },
  {
    id: 'channels',
    get name() {
      return tr('channels.search.scope')
    },
  },
]
const noFiles: FileHits = { hits: [], truncated: false }
/** 「全部」里带前几条频道消息（docs/ui/channels-local-ai.md §3.1 #8），「频道消息」范围最多 50 条 */
const CHANNEL_BRIEF = 5
const CHANNEL_FULL = 50

const caretAtEnd = (input: HTMLInputElement | null): boolean =>
  !!input && input.selectionStart === input.selectionEnd && input.selectionEnd === input.value.length

/** 结果列表里的一行：一个会话（或项目、手动任务），或展开后它下面的一处命中 */
type ResultRow = { kind: 'group'; group: ResultGroup } | { kind: 'hit'; group: ResultGroup; hit: SearchResult }
let requestSequence = 0
const emptyResponse: SearchResponse = { requestId: 0, results: [], truncated: false, partial: false, sessionCount: 0 }

function Fragments({ parts }: { parts: SearchResult['snippet'] }) {
  useI18n()
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-accent-fg">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

export function SearchDialog({
  inputRef,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  onClose: () => void
}) {
  useI18n()
  const [text, setText] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [fileHits, setFileHits] = useState<FileHits>(noFiles)
  const [channelHits, setChannelHits] = useState<ChannelSearchResult>(NO_HITS)
  const channelList = useChannels(s => s.channels)
  const channelMembers = useChannels(s => s.members)
  const memberNames = useMemo(() => new Map(channelMembers.map(m => [m.id, m.name])), [channelMembers])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [response, setResponse] = useState(emptyResponse)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [composing, setComposing] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const projects = useEngineState(s => s.projects)
  const options = isDemo ? demo().search.projects : projects
  // 搜文件的项目：选了项目筛选就用它，否则用当前窗格的项目
  const workspace = useActiveWorkspace()
  const fileRef: WorkspaceRef | null = projectId ? { projectId } : workspace.ref
  const fileRefKey = fileRef ? (fileRef.projectId ?? 'session:' + fileRef.sessionId) : ''
  // 被 .gitignore 忽略的文件排在后面、变暗
  const ignoredPaths = useIgnoredSet(fileRef)
  const fileHitList = useMemo(
    () => partitionIgnored(fileHits.hits, h => h.path, ignoredPaths),
    [fileHits.hits, ignoredPaths],
  )
  const openHit = (hit: FileHit) => {
    void openFile(hit.ref, hit.path, hit.line ?? undefined, hit.column ?? 1).catch(() => undefined)
    onClose()
  }
  // 会话结果按会话合并成一行，展开后下面列出其它命中（docs/ui/conversation-ux-2.md §2.5）
  const terms = useMemo(() => searchTerms(text), [text])
  const groups = useMemo(() => groupResults(response.results), [response])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const rows: ResultRow[] = useMemo(
    () =>
      groups.flatMap(group => [
        { kind: 'group' as const, group },
        ...(expanded.has(group.key) ? group.rest.map(hit => ({ kind: 'hit' as const, group, hit })) : []),
      ]),
    [groups, expanded],
  )
  // 顺序：项目文件、会话、频道消息
  const channelStart = fileHitList.length + rows.length
  const total = channelStart + channelHits.hits.length
  const openChannelHit = (hit: ChannelSearchHit) => {
    setPage('channels')
    void channelActions.focusMessage(hit.channelId, hit.messageId, hit.at)
    onClose()
  }
  const activateIndex = (i: number) => {
    if (i < fileHitList.length) openHit(fileHitList[i])
    else if (i >= channelStart) {
      const hit = channelHits.hits[i - channelStart]
      if (hit) openChannelHit(hit)
    } else {
      const row = rows[i - fileHitList.length]
      if (row) activate(row.kind === 'group' ? row.group.head : row.hit)
    }
  }
  /** 展开 / 收起一个会话的命中；收起时选中项落回这个会话那一行 */
  const toggleGroup = (key: string, open: boolean) => {
    const at = fileHitList.length + rows.findIndex(r => r.kind === 'group' && r.group.key === key)
    const shown = rows.filter(r => r.kind === 'hit' && r.group.key === key).length
    const extra = groups.find(g => g.key === key)?.rest.length ?? 0
    setExpanded(prev => {
      const next = new Set(prev)
      if (open) next.add(key)
      else next.delete(key)
      return next
    })
    // 下面的行跟着挪：展开时往后移，收起时往前移，原来选在收起的命中上就落回会话那一行
    setSelected(i => (i <= at ? i : open ? i + extra : i <= at + shown ? at : i - shown))
  }
  const activate = (r: SearchResult) => {
    if (r.id.startsWith('manual-task:')) {
      openTask(r.projectId, r.itemId!)
      onClose()
      return
    }
    window.dispatchEvent(
      new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId: r.sessionId, itemId: r.itemId, query: text } }),
    )
    onClose()
  }
  useEffect(() => {
    inputRef.current?.focus()
  }, [inputRef])
  useEffect(() => {
    const requestId = ++requestSequence
    request.current = requestId
    setLoading(true)
    setError(null)
    setResponse(emptyResponse)
    setFileHits(noFiles)
    setChannelHits(NO_HITS)
    setSelected(0)
    setExpanded(new Set())
    if (composing) return
    let disposed = false
    const timer = window.setTimeout(
      async () => {
        // 项目文件：「全部」里带前几条，「项目文件」范围取全部；需要有项目和搜索词
        const wantFiles = (scope === 'all' || scope === 'files') && !!text.trim() && !!fileRef
        const files = wantFiles
          ? isDemo
            ? Promise.resolve(
                demoFileHits(fileRef!, demo().files.contents, text.trim(), scope === 'files' ? 'full' : 'brief'),
              )
            : searchFiles(fileRef!, text, scope === 'files' ? 'full' : 'brief').catch(err =>
                // 「全部」里文件搜索出错不影响会话结果；「项目文件」范围直接显示错误
                scope === 'files' ? Promise.reject(err) : noFiles,
              )
          : Promise.resolve(noFiles)
        // 频道消息：「全部」里带前几条，「频道消息」范围取全部；「全部」里出错不影响会话结果
        const wantChannels = (scope === 'all' || scope === 'channels') && !!text.trim()
        const channels = wantChannels
          ? searchChannelMessages(text, {
              limit: scope === 'channels' ? CHANNEL_FULL : CHANNEL_BRIEF,
              projectId,
            }).catch(err => (scope === 'channels' ? Promise.reject(err) : NO_HITS))
          : Promise.resolve(NO_HITS)
        if (scope === 'channels') {
          try {
            const hits = await channels
            if (!disposed && request.current === requestId) setChannelHits(hits)
          } catch (err) {
            if (!disposed && request.current === requestId) setError((err as Error).message)
          } finally {
            if (!disposed && request.current === requestId) setLoading(false)
          }
          return
        }
        if (scope === 'files') {
          try {
            const hits = await files
            if (!disposed && request.current === requestId) setFileHits(hits)
          } catch (err) {
            if (!disposed && request.current === requestId) setError((err as Error).message)
          } finally {
            if (!disposed && request.current === requestId) setLoading(false)
          }
          return
        }
        const query: SearchQuery = { requestId, text, scope, projectId }
        try {
          const [result, tasks, hits, channelResult] = await Promise.all([
            isDemo ? demo().search.run(query) : bridge?.search(query),
            !isDemo && scope === 'all' && text.trim()
              ? window.pixelsky?.projectTools.searchTasks(text, projectId)
              : Promise.resolve([]),
            files,
            channels,
          ])
          if (result && tasks?.length) {
            const rows: SearchResult[] = tasks.map(task => ({
              id: 'manual-task:' + task.id,
              sessionId: '',
              itemId: task.id,
              kind: 'todo',
              field: tr('projectTools.myTasks'),
              title: task.title,
              projectId: task.projectId,
              projectName: projects.find(p => p.id === task.projectId)?.name ?? '',
              engine: 'claude',
              updatedAt: task.updatedAt,
              snippet: searchSnippet(task.title + '\n' + task.note, searchTerms(text)),
              rank: 0,
            }))
            result.results = [...rows, ...result.results].slice(0, 50)
          }
          if (disposed || request.current !== requestId || result?.cancelled) return
          if (!result) throw new Error(tr('search.SearchDialog.localConversationSearchIs'))
          setResponse(result)
          setFileHits(hits)
          setChannelHits(channelResult)
        } catch (err) {
          if (!disposed && request.current === requestId) setError((err as Error).message)
        } finally {
          if (!disposed && request.current === requestId) setLoading(false)
        }
      },
      text.trim() ? 180 : 0,
    )
    return () => {
      disposed = true
      window.clearTimeout(timer)
      if (!isDemo) void bridge?.cancelSearch(requestId).catch(() => undefined)
    }
  }, [text, scope, projectId, composing, fileRefKey])
  useEffect(() => {
    scrollInPane(dialog.current?.querySelector(`[data-result-index="${selected}"]`), 'nearest')
  }, [selected, response, fileHits, channelHits])

  return (
    <div
      className="fade-in no-drag fixed inset-0 z-50 flex items-start justify-center bg-scrim px-4 pt-[min(10vh,80px)]"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialog}
        data-global-search
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-title"
        className="pop-in flex max-h-[80vh] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-line-card bg-popover shadow-menu"
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || composing) return
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && total) {
            e.preventDefault()
            setSelected(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + total) % total)
          } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && caretAtEnd(inputRef.current)) {
            // 光标在输入框末尾时，右键展开选中会话的命中、左键收起；光标在中间时照常移动光标
            const row = rows[selected - fileHitList.length]
            if (!row) return
            const open = expanded.has(row.group.key)
            if (e.key === 'ArrowRight' && row.kind === 'group' && row.group.rest.length && !open) {
              e.preventDefault()
              toggleGroup(row.group.key, true)
            } else if (e.key === 'ArrowLeft' && open) {
              e.preventDefault()
              toggleGroup(row.group.key, false)
            }
          } else if (e.key === 'Enter' && e.target === inputRef.current && selected < total && !loading) {
            e.preventDefault()
            activateIndex(selected)
          } else if (e.key === 'Tab') {
            const focusable = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>('input,select,button:not(:disabled),[tabindex="0"]') ?? [],
            ).filter(el => el.getBoundingClientRect().width > 0)
            const first = focusable[0],
              last = focusable.at(-1)
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault()
              last?.focus()
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <header className="flex items-center gap-3 px-4 pt-3 pb-1.5">
          <h2 id="search-title" className="flex-1 text-ui font-medium text-fg-secondary">
            {tr('search.SearchDialog.searchConversationsAndContent')}
          </h2>
          <IconButton
            icon={X}
            label={tr('search.SearchDialog.closeSearchEsc')}
            size={24}
            iconSize={14}
            onClick={onClose}
          />
        </header>
        <div className="mx-4 flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 focus-within:border-accent-line">
          <Search size={16} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          <input
            ref={inputRef}
            type="search"
            value={text}
            maxLength={200}
            placeholder={tr('search.SearchDialog.searchTitlesMessagesCommands')}
            aria-label={tr('search.SearchDialog.searchTerms')}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded
            aria-controls="global-search-results"
            aria-activedescendant={selected < total ? `search-result-${selected}` : undefined}
            className="h-11 min-w-0 flex-1 bg-transparent text-prose text-fg outline-none placeholder:text-fg-faint"
            onChange={e => setText(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={e => {
              setText(e.currentTarget.value)
              setComposing(false)
            }}
          />
          {loading && <Spinner size={14} />}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-4 py-3">
          <div role="group" aria-label={tr('search.SearchDialog.searchScope')} className="flex flex-wrap gap-1">
            {SCOPES.map(s => (
              <button
                key={s.id}
                type="button"
                aria-pressed={scope === s.id}
                onClick={() => setScope(s.id)}
                className={cn(
                  'rounded-md px-2 py-1.5 text-meta',
                  scope === s.id ? 'bg-accent-soft text-accent-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
                )}
              >
                {s.name}
              </button>
            ))}
          </div>
          <div className="min-w-2 flex-1" />
          <ProjectFilter projects={options} value={projectId} onChange={setProjectId} />
        </div>
        <div
          className="min-h-36 min-w-0 flex-1 overflow-y-auto p-2"
          id="global-search-results"
          role="listbox"
          aria-label={tr('search.SearchDialog.searchResults')}
          aria-busy={loading}
        >
          {fileHitList.map((hit, i) => (
            <button
              key={hit.key}
              id={`search-result-${i}`}
              type="button"
              role="option"
              aria-selected={i === selected}
              tabIndex={-1}
              data-result-index={i}
              data-file-hit={hit.key}
              onMouseEnter={() => setSelected(i)}
              onClick={() => openHit(hit)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left',
                i === selected ? 'bg-selected' : 'hover:bg-hover',
              )}
            >
              <FileIcon
                name={hit.path.split('/').pop() ?? hit.path}
                kind="file"
                size={16}
                dim={isIgnoredPath(hit.path, ignoredPaths)}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-ui font-medium',
                    isIgnoredPath(hit.path, ignoredPaths) ? 'text-fg-faint' : 'text-fg',
                  )}
                >
                  {hit.path.split('/').pop()}
                </span>
                <span className="mt-0.5 block truncate text-label text-fg-faint">
                  {hit.path} ·{' '}
                  {hit.line === null
                    ? tr('search.SearchDialog.fileName')
                    : tr('search.SearchDialog.fileLine', { line: hit.line })}
                </span>
                {hit.text && (
                  <span className="mt-1 block truncate font-mono text-meta text-fg-muted">
                    <Fragments parts={searchSnippet(hit.text.trim(), searchTerms(text))} />
                  </span>
                )}
              </span>
              {i === selected && <CornerDownLeft size={13} className="mt-1 shrink-0 text-fg-faint" />}
            </button>
          ))}
          {rows.map((row, n) => {
            const i = n + fileHitList.length
            if (row.kind === 'hit') {
              const h = row.hit
              // 展开后的最后一处下面写明还有几处没列出（搜索每个会话最多只带最近 3 处）
              const unlisted = h === row.group.rest.at(-1) ? row.group.total - 1 - row.group.rest.length : 0
              return (
                <Fragment key={h.id}>
                  <div
                    id={`search-result-${i}`}
                    role="option"
                    aria-selected={i === selected}
                    tabIndex={-1}
                    data-result-index={i}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => activate(h)}
                    className={cn(
                      'ml-7 flex cursor-default items-start gap-2 rounded-lg px-3 py-2 text-left',
                      i === selected ? 'bg-selected' : 'hover:bg-hover',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-label text-fg-faint">{fieldLabel(h.field)}</span>
                      <span className="mt-0.5 block whitespace-pre-wrap break-words text-meta leading-relaxed text-fg-muted">
                        <Fragments parts={h.snippet} />
                      </span>
                    </span>
                    {i === selected && <CornerDownLeft size={13} className="mt-1 shrink-0 text-fg-faint" />}
                  </div>
                  {unlisted > 0 && (
                    <p className="ml-7 px-3 pt-0.5 pb-1.5 text-label text-fg-faint">
                      {tr('search.SearchDialog.unlistedMatches', { n: unlisted })}
                    </p>
                  )}
                </Fragment>
              )
            }
            const r = row.group.head
            const more = row.group.total - 1
            const open = expanded.has(row.group.key)
            const Icon = r.itemId
              ? ['command', 'tool', 'file_change'].includes(r.kind)
                ? SquareTerminal
                : MessageSquare
              : r.kind === 'project'
                ? Folder
                : MessageSquare
            return (
              <div
                key={row.group.key}
                id={`search-result-${i}`}
                role="option"
                aria-selected={i === selected}
                aria-expanded={more ? open : undefined}
                tabIndex={-1}
                data-result-index={i}
                onMouseEnter={() => setSelected(i)}
                onClick={() => activate(r)}
                className={cn(
                  'flex w-full cursor-default items-start gap-3 rounded-lg px-3 py-2.5 text-left',
                  i === selected ? 'bg-selected' : 'hover:bg-hover',
                )}
              >
                <Icon size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium text-fg">
                    {terms.length ? <Fragments parts={titleFragments(r.title, terms)} /> : r.title}
                  </span>
                  <span className="mt-0.5 block truncate text-label text-fg-faint">
                    {projectLabel(r.projectName)} ·{' '}
                    {r.id.startsWith('manual-task:') ? tr('projectTools.myTasks') : ENGINES[r.engine].name} ·{' '}
                    {new Date(r.updatedAt).toLocaleString(getLocale(), {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    · {fieldLabel(r.field)}
                  </span>
                  {text.trim() && (
                    <span className="mt-1 block whitespace-pre-wrap break-words text-meta leading-relaxed text-fg-muted">
                      <Fragments parts={r.snippet} />
                    </span>
                  )}
                </span>
                {more > 0 && !row.group.rest.length && (
                  <span className="shrink-0 px-1.5 text-label text-fg-muted">
                    {tr('search.SearchDialog.moreMatches', { n: more })}
                  </span>
                )}
                {more > 0 && !!row.group.rest.length && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={tr(open ? 'search.SearchDialog.hideMatches' : 'search.SearchDialog.showMatches')}
                    onClick={e => {
                      e.stopPropagation()
                      toggleGroup(row.group.key, !open)
                    }}
                    className="-my-0.5 inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-label text-fg-muted hover:bg-hover hover:text-fg"
                  >
                    {tr('search.SearchDialog.moreMatches', { n: more })}
                    <ChevronRight
                      size={13}
                      strokeWidth={1.5}
                      className={cn('transition-transform duration-(--dur-fast)', open && 'rotate-90')}
                    />
                  </button>
                )}
                {i === selected && <CornerDownLeft size={13} className="mt-1 shrink-0 text-fg-faint" />}
              </div>
            )
          })}
          {channelHits.hits.map((hit, n) => {
            const i = channelStart + n
            const place = hitPlace(hit, channelList, memberNames)
            return (
              <Fragment key={hit.messageId}>
                {/* 「全部」里频道消息排在会话后面，单独起个头 */}
                {n === 0 && scope === 'all' && (
                  <p role="presentation" className="px-3 pt-3 pb-1 text-label font-medium text-fg-faint">
                    {tr('channels.search.scope')}
                  </p>
                )}
                <div
                  id={`search-result-${i}`}
                  role="option"
                  aria-selected={i === selected}
                  tabIndex={-1}
                  data-result-index={i}
                  data-channel-hit={hit.messageId}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => openChannelHit(hit)}
                  className={cn(
                    'flex w-full cursor-default items-start gap-3 rounded-lg px-3 py-2.5 text-left',
                    i === selected ? 'bg-selected' : 'hover:bg-hover',
                  )}
                >
                  <Hash size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-medium text-fg">#{place.channel}</span>
                    <span className="mt-0.5 block truncate text-label text-fg-faint">
                      {place.author} ·{' '}
                      {new Date(hit.at).toLocaleString(getLocale(), {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      · {tr(hit.kind === 'task' ? 'channels.search.kind.task' : 'channels.search.kind.message')}
                      {place.archived && ` · ${tr('channels.search.archived')}`}
                    </span>
                    <span className="mt-1 block whitespace-pre-wrap break-words text-meta leading-relaxed text-fg-muted">
                      <Fragments parts={hit.snippet} />
                    </span>
                  </span>
                  {i === selected && <CornerDownLeft size={13} className="mt-1 shrink-0 text-fg-faint" />}
                </div>
              </Fragment>
            )
          })}
          {scope === 'all' && channelHits.truncated && (
            <button
              type="button"
              onClick={() => setScope('channels')}
              className="mx-3 my-1 text-label text-accent-fg hover:underline"
            >
              {tr('channels.search.globalMore')}
            </button>
          )}
          {scope === 'channels' && channelHits.truncated && (
            <p role="status" className="px-3 py-2 text-meta text-fg-muted">
              {tr('channels.search.latest', { count: channelHits.hits.length })}
            </p>
          )}
          {!total && (
            <div role="status" className="px-4 py-9 text-center text-ui text-fg-muted">
              {loading
                ? tr('search.SearchDialog.searching')
                : error
                  ? translateMessage(error)
                  : scope === 'channels'
                    ? text.trim()
                      ? tr('search.SearchDialog.noMatchingContentTry')
                      : tr('channels.search.typeToSearch')
                    : scope === 'files'
                      ? !fileRef
                        ? tr('search.SearchDialog.openAProjectFirst')
                        : text.trim()
                          ? tr('search.SearchDialog.noMatchingContentTry')
                          : tr('search.SearchDialog.typeToSearchFiles')
                      : !response.sessionCount
                        ? tr('search.SearchDialog.noConversationsYetStart')
                        : text.trim()
                          ? tr('search.SearchDialog.noMatchingContentTry')
                          : tr('search.SearchDialog.noConversationsInThis')}
            </div>
          )}
          {scope === 'files' && fileHits.truncated && (
            <p role="status" className="px-3 py-2 text-meta text-fg-muted">
              {tr('search.SearchDialog.fileResultsPartial')}
            </p>
          )}
          {response.partial && (
            <p role="status" className="px-3 py-2 text-meta text-warn">
              {tr('search.SearchDialog.someConversationRecordsCould')}
            </p>
          )}
          {response.truncated && (
            <p role="status" className="px-3 py-2 text-meta text-fg-muted">
              {tr('search.SearchDialog.tooManyResultsNarrow')}
            </p>
          )}
        </div>
        <footer className="flex items-center gap-3 border-t border-line-subtle px-4 py-2.5 text-label text-fg-faint">
          <span className="flex-1">
            {text.trim() ? tr('search.SearchDialog.localSearch') : tr('search.SearchDialog.recentConversations')}
          </span>
          <span>{tr('search.SearchDialog.select')}</span>
          {groups.some(g => g.rest.length > 0) && <span>{tr('search.SearchDialog.expandHint')}</span>}
          <span>{tr('search.SearchDialog.enterOpen')}</span>
          <span>{tr('search.SearchDialog.escClose')}</span>
        </footer>
      </div>
    </div>
  )
}
