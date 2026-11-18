import { dotError } from './errors'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  ExternalLink,
  File,
  Link,
  Mic,
  Monitor,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Plus,
  X,
} from 'lucide-react'
import type { SessionSnapshot } from '@pixelsky/protocol'
import type { DotChatMessage, DotOverview } from '@pixelsky/engine'
import type { DotClipboardFile, DotEntry } from '../../../../shared/types/dot-chat'
import { DOT_CLIPBOARD_FILE_LIMIT, DOT_COMPOSER_FILE_LIMIT } from '../../../../shared/types/dot-chat'
import { CopyButton, IconButton, Spinner } from '@/ui'
import { Markdown } from '@/ui/markdown/Markdown'
import { ActionMenu } from '@/ui/ActionMenu'
import { ComposerArea } from '@/features/session/ComposerArea'
import { CARD_STYLE } from '@/features/session/composerStyles'
import { discardStaged, releaseStaged, stageFile } from '@/features/session/attachments/stage'
import '@/features/session/conversation.css'
import { tr, translateMessage } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { DotAvatar } from './DotAvatar'
import { DotProfilePanel, DotStatusPill, dotWebUrl } from './DotProfilePanel'
import { DotExperimental } from './DotExperimental'
import { dotTranscript, mergeDotHistory } from './conversation'
import { DotFile } from './DotFile'
import { DotComputer } from './DotComputer'
import { DotDeliveryNotice } from './DotDeliveryNotice'
import { dotMessageWithReferences, dotPathReference, dotTransferFiles, type DotComposerFile } from './composerFiles'
import './dot.css'

function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export function DotConversation({ entryKey, active = true }: { entryKey: string; active?: boolean }) {
  useI18n()
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
  const current = useRef<string | null>(null)
  const [entry, setEntry] = useState<DotEntry | null>(null)
  const [history, setHistory] = useState<DotChatMessage[]>([])
  const [before, setBefore] = useState<string | null>(null)
  const [overview, setOverview] = useState<DotOverview>()
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [serverError, setServerError] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const submitting = useRef(false)
  const [resolving, setResolving] = useState(false)
  const refreshSnapshot = useRef<() => Promise<void>>(async () => {})
  const [snapshotError, setSnapshotError] = useState('')
  const [picking, setPicking] = useState(false)
  const [files, setFiles] = useState<(DotComposerFile & { id: string })[]>([])
  const [dragging, setDragging] = useState(false)
  const composerInput = useRef<HTMLTextAreaElement>(null)
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const [computer, setComputer] = useState(false)
  const [details, setDetails] = useState(() => window.innerWidth > 940)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDetailsElement>(null)
  const network = useRef(false)
  const haveHistory = useRef(false)
  const alive = useRef(true)
  const draftKey = `pixelsky.dot.draft.${entryKey}`
  const [text, setText] = useState(() => readDraft(draftKey))
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const rows = useMemo(() => dotTranscript(history, snapshot?.items ?? []), [history, snapshot?.items])
  const outputs = useMemo(() => rows.filter(row => row.role === 'assistant').flatMap(row => row.attachments), [rows])
  const web = dotWebUrl(entry?.id)

  const readRemote = useCallback(
    async (options: { before?: string; overview?: boolean } = {}) => {
      if (network.current) return
      network.current = true
      setReading(true)
      try {
        const next = await window.pixelsky!.dotChat.read(entryKey, options)
        if (!alive.current) return
        setEntry(next.entry)
        setHistory(previous => mergeDotHistory(previous, next.history.items))
        if (options.before || !haveHistory.current) setBefore(next.history.before)
        haveHistory.current = true
        if (next.overview) setOverview(next.overview)
        setServerError('')
      } catch (e) {
        if (alive.current) setServerError(dotError(e))
      } finally {
        network.current = false
        if (alive.current) {
          setLoading(false)
          setReading(false)
        }
      }
    },
    [entryKey],
  )
  const remote = useRef(readRemote)
  remote.current = readRemote
  const visible = useRef(active)
  visible.current = active
  useEffect(() => {
    if (!active) {
      setComputer(false)
      setDragging(false)
    }
  }, [active])

  useEffect(() => {
    alive.current = true
    void window.pixelsky?.dotChat
      .catalog()
      .then(catalog => {
        if (alive.current) setEntry(catalog.entries.find(e => e.key === entryKey) ?? null)
      })
      .catch(() => undefined)
    void remote.current({ overview: true })
    let polls = 0
    const timer = window.setInterval(() => {
      if (!visible.current || document.visibilityState !== 'visible') return
      void remote.current({ overview: ++polls % 6 === 0 })
    }, 10_000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [entryKey])

  useEffect(() => {
    let mounted = true
    let fetching = false
    let again = false
    const refresh = async (): Promise<void> => {
      if (fetching) {
        again = true
        return
      }
      fetching = true
      do {
        again = false
        try {
          const next = await window.pixelsky!.dotChat.snapshot(entryKey)
          if (mounted) {
            current.current = next.record.id
            setSnapshot(next)
            setSnapshotError('')
          }
        } catch (e) {
          if (mounted) setSnapshotError(dotError(e))
        }
      } while (mounted && again)
      fetching = false
    }
    refreshSnapshot.current = refresh
    const off = window.pixelsky?.engine.onEvent(e => {
      if (e.kind !== 'session' || (current.current && e.sessionId !== current.current)) return
      void refresh()
      if (e.event.type === 'turn_completed') void remote.current({ overview: true })
    })
    void refresh()
    return () => {
      mounted = false
      off?.()
    }
  }, [entryKey])
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, text)
    } catch {
      /* 保留内存草稿 */
    }
  }, [draftKey, text])
  useEffect(() => {
    if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [rows])
  useEffect(() => {
    if (!menu) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(false)
        menuRef.current?.querySelector('summary')?.focus()
      }
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [menu])

  const retry = () => {
    void refreshSnapshot.current()
    void remote.current({ overview: true })
  }
  const uncertain = snapshot?.queue.filter(q => q.status === 'uncertain') ?? []
  const busy =
    resolving || sending || !snapshot || snapshot.state !== 'idle' || snapshot.queue.some(q => q.status !== 'failed')
  const send = async (): Promise<void> => {
    if (!snapshot || (!text.trim() && !files.length) || busy || picking || submitting.current) return
    const message = dotMessageWithReferences(text, files)
    if (message.length > 100_000) {
      setError(tr('dot.composerTooLong'))
      return
    }
    const ref = { sessionId: snapshot.record.id }
    const staged: DotClipboardFile[] = []
    submitting.current = true
    setSending(true)
    setError('')
    try {
      for (const item of files) {
        if ('file' in item) staged.push({ name: item.name, path: await stageFile(item.file, ref) })
      }
      await window.pixelsky!.dotChat.send(entryKey, ref.sessionId, message, staged)
      releaseStaged(staged.map(item => item.path))
      setText(current => (current === text ? '' : current))
      const sentIds = new Set(files.map(file => file.id))
      setFiles(current => current.filter(file => !sentIds.has(file.id)))
    } catch (e) {
      await Promise.all(staged.map(item => discardStaged(item.path, ref)))
      setError(dotError(e))
    } finally {
      submitting.current = false
      setSending(false)
    }
  }

  const addFiles = (incoming: DotComposerFile[], missingPath = false): void => {
    const paths = new Set(files.flatMap(file => ('path' in file ? [file.path] : [])))
    let issue = missingPath ? tr('dot.dropMissingPath') : ''
    const added = incoming.filter(item => {
      if ('path' in item) {
        if (paths.has(item.path)) return false
        paths.add(item.path)
      } else if (item.file.size > DOT_CLIPBOARD_FILE_LIMIT) {
        issue ||= tr('dot.error.fileTooLarge')
        return false
      }
      return true
    })
    const next = added
      .slice(0, DOT_COMPOSER_FILE_LIMIT - files.length)
      .map(item => ({ ...item, id: crypto.randomUUID() }))
    setFiles(previous => [...previous, ...next].slice(0, DOT_COMPOSER_FILE_LIMIT))
    setError(issue || (next.length < added.length ? tr('composer.file.tooMany') : ''))
  }

  const addTransfer = (transfer: DataTransfer, source: 'paste' | 'drop'): boolean => {
    const incoming = dotTransferFiles(transfer, source, file => window.pixelsky?.pathForFile(file) ?? '')
    if (!incoming.files.length && !incoming.missingPath) return false
    addFiles(incoming.files, incoming.missingPath)
    return true
  }

  const pickFiles = async () => {
    if (picking) return
    setPicking(true)
    setError('')
    try {
      const chosen = await window.pixelsky!.dotChat.pickFiles(entryKey)
      if (alive.current && chosen.length) {
        addFiles(chosen.map(dotPathReference))
        composerInput.current?.focus()
      }
    } catch (e) {
      setError(dotError(e))
    } finally {
      setPicking(false)
    }
  }

  return (
    <main className="dot-conversation conversation-view">
      <header className="dot-toolbar">
        <div className="dot-tab">
          <DotAvatar name={entry?.name ?? 'Dot'} url={entry?.avatarUrl} size={26} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="dot-tab-title">{entry?.name ?? tr('dot.yourDot')}</h1>
              <DotExperimental />
            </div>
            {entry?.accountName && (
              <p className="truncate text-meta leading-4 text-fg-faint" title={entry.accountName}>
                {entry.accountName}
              </p>
            )}
          </div>
        </div>
        <span className="flex-1" />
        <details ref={menuRef} className="relative" open={menu} onToggle={e => setMenu(e.currentTarget.open)}>
          <summary className="dot-icon-button list-none" aria-label={tr('dot.more')}>
            <MoreHorizontal size={18} />
          </summary>
          <div className="absolute top-full right-0 z-30 mt-2 flex w-48 flex-col gap-1 rounded-xl border border-line bg-popover p-1.5 shadow-popover">
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-left text-ui hover:bg-hover"
              onClick={() => {
                setMenu(false)
                retry()
              }}
            >
              {tr('dot.refreshConversation')}
            </button>
            <a
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-ui hover:bg-hover"
              href={web}
              target="_blank"
              rel="noreferrer"
            >
              <span className="flex-1">{tr('dot.openWeb')}</span>
              <ExternalLink size={13} className="text-fg-faint" />
            </a>
          </div>
        </details>
        <IconButton
          icon={Monitor}
          label={tr('dot.computer')}
          size={32}
          iconSize={17}
          active={computer}
          onClick={() => setComputer(v => !v)}
        />
        <IconButton
          icon={PanelRight}
          label={tr('dot.details')}
          size={32}
          iconSize={17}
          active={details}
          aria-expanded={details}
          onClick={() => setDetails(v => !v)}
        />
      </header>
      <div className="dot-body">
        <div className="dot-chat-column" hidden={computer}>
          <div
            ref={scroller}
            className="dot-message-scroll conversation-scroller selectable"
            role="log"
            aria-label={tr('dot.messages')}
            onScroll={e => {
              const el = e.currentTarget
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
            <div className="dot-messages conversation-inset conversation-reading">
              {before && (
                <button
                  type="button"
                  className="self-center rounded-lg px-3 py-2 text-meta text-fg-muted hover:bg-hover"
                  disabled={reading}
                  onClick={() => {
                    follow.current = false
                    void readRemote({ before })
                  }}
                >
                  {tr('dot.loadEarlier')}
                </button>
              )}
              {loading && (
                <div className="self-center">
                  <Spinner />
                </div>
              )}
              {!loading && !rows.length && !serverError && (
                <div className="dot-chat-empty">
                  <DotAvatar name={entry?.name ?? 'Dot'} url={entry?.avatarUrl} size={80} />
                  <p>{tr('dot.welcome')}</p>
                </div>
              )}
              {rows.map(row =>
                row.role === 'notice' ? (
                  <p
                    key={row.id}
                    role={row.level === 'error' ? 'alert' : undefined}
                    className={row.level === 'error' ? 'text-meta text-danger' : 'text-meta text-fg-muted'}
                  >
                    {translateMessage(row.text)}
                  </p>
                ) : (
                  <article key={row.id} className={`dot-message ${row.role === 'user' ? 'is-user' : 'is-assistant'}`}>
                    <div
                      className={
                        row.role === 'user'
                          ? 'conversation-user-bubble dot-user-bubble rounded-2xl rounded-br-md bg-subtle px-4 py-2.5 text-prose whitespace-pre-wrap text-fg'
                          : 'conversation-message text-prose text-fg-body'
                      }
                    >
                      {row.text && (row.role === 'user' ? row.text : <Markdown text={row.text} />)}
                      {!!row.attachments.length && (
                        <div className="dot-attachments">
                          {row.attachments.map((file, i) => (
                            <DotFile key={file.fileId ?? i} file={file} />
                          ))}
                        </div>
                      )}
                    </div>
                    {row.role === 'assistant' && row.text && (
                      <div className="dot-message-actions mt-2 flex text-fg-faint">
                        <CopyButton text={row.text} iconOnly />
                      </div>
                    )}
                  </article>
                ),
              )}
              {snapshot?.runs.workflows.map(run => (
                <a key={run.id} className="dot-task-card" href={web} target="_blank" rel="noreferrer">
                  <File size={16} className="shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1 truncate text-ui text-fg">{run.name || tr('dot.task')}</span>
                  <DotStatusPill status={run.status} />
                  <span className="flex shrink-0 items-center gap-1 text-meta text-fg-muted">
                    {tr(run.status === 'needsInput' ? 'dot.handleInWeb' : 'dot.openWeb')}
                    <ExternalLink size={12} />
                  </span>
                </a>
              ))}
            </div>
          </div>
          <ComposerArea>
            <form
              className="dot-composer-form"
              onSubmit={e => {
                e.preventDefault()
                void send()
              }}
            >
              {(error || snapshotError || serverError) && (
                <div role="alert" className="mb-2 flex items-center gap-2 text-meta text-danger">
                  <span className="min-w-0 flex-1">{translateMessage(error || snapshotError || serverError)}</span>
                  <button type="button" className="shrink-0 underline" disabled={reading} onClick={retry}>
                    {tr('modelChannels.action.retry')}
                  </button>
                </div>
              )}
              {uncertain.map(item => (
                <DotDeliveryNotice
                  key={item.id}
                  text={item.text}
                  web={web}
                  busy={resolving}
                  onResolve={() => {
                    setResolving(true)
                    void window
                      .pixelsky!.engine.cancelQueued(snapshot!.record.id, item.id)
                      .then(() => refreshSnapshot.current())
                      .catch(e => setError(dotError(e)))
                      .finally(() => setResolving(false))
                  }}
                />
              ))}
              {busy && snapshot && !uncertain.length && (
                <p role="status" className="mb-2 text-meta text-fg-muted">
                  {tr('dot.waiting')}
                </p>
              )}
              <div
                className={`${CARD_STYLE} dot-composer relative${dragging ? ' ring-2 ring-accent' : ''}`}
                onDragEnter={e => {
                  if (!e.dataTransfer.types.includes('Files')) return
                  e.preventDefault()
                  setDragging(true)
                }}
                onDragOver={e => {
                  if (!e.dataTransfer.types.includes('Files')) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                }}
                onDragLeave={e => {
                  if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget))
                    setDragging(false)
                }}
                onDrop={e => {
                  setDragging(false)
                  if (!e.dataTransfer.types.includes('Files')) return
                  e.preventDefault()
                  addTransfer(e.dataTransfer, 'drop')
                  composerInput.current?.focus()
                }}
              >
                {dragging && (
                  <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent-line bg-accent-soft/80 text-ui font-medium text-accent-fg">
                    {tr('dot.dropReferences')}
                  </div>
                )}
                {!!files.length && (
                  <div className="mb-3 flex flex-wrap gap-2" aria-label={tr('dot.pendingFiles')}>
                    {files.map(file => (
                      <div
                        className="dot-file-chip max-w-full"
                        key={file.id}
                        title={'path' in file ? file.path : file.name}
                      >
                        {'path' in file ? (
                          <Link size={16} aria-label={tr('dot.pathReference')} />
                        ) : (
                          <Paperclip size={16} />
                        )}
                        <span>{file.name}</span>
                        <button
                          type="button"
                          className="dot-icon-button"
                          aria-label={`${tr('composer.attachment.remove')} ${file.name}`}
                          onClick={() => setFiles(current => current.filter(f => f.id !== file.id))}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  ref={composerInput}
                  autoFocus
                  rows={3}
                  aria-label={tr('dot.message')}
                  placeholder={tr('dot.placeholder')}
                  value={text}
                  maxLength={100000}
                  onInput={e => {
                    const el = e.currentTarget
                    el.style.height = 'auto'
                    el.style.height = `${Math.min(192, Math.max(72, el.scrollHeight))}px`
                  }}
                  onChange={e => setText(e.target.value)}
                  onPaste={e => {
                    if (addTransfer(e.clipboardData, 'paste')) e.preventDefault()
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                <div className="dot-composer-actions">
                  <button
                    type="button"
                    className="dot-icon-button"
                    aria-label={tr('dot.add')}
                    title={tr('dot.add')}
                    aria-haspopup="menu"
                    aria-expanded={!!addMenu}
                    disabled={picking}
                    onClick={e => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      setAddMenu({ x: rect.left, y: rect.top - 100 })
                    }}
                  >
                    {picking ? <Spinner /> : <Plus size={19} />}
                  </button>
                  <span className="flex-1" />
                  <a
                    className="dot-icon-button"
                    href={web}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={tr('dot.voiceInWeb')}
                    title={tr('dot.voiceInWeb')}
                  >
                    <Mic size={17} />
                  </a>
                  <button
                    type="submit"
                    className="dot-send"
                    aria-label={tr('dot.send')}
                    title={tr('dot.send')}
                    disabled={busy || picking || (!text.trim() && !files.length)}
                  >
                    <ArrowUp size={18} />
                  </button>
                </div>
              </div>
              <p className="dot-composer-hint">{tr('dot.closeHint')}</p>
            </form>
          </ComposerArea>
        </div>
        {computer && <DotComputer onClose={() => setComputer(false)} />}
        {details && (
          <div className="dot-detail-column">
            <button
              type="button"
              className="dot-icon-button ml-auto flex min-[941px]:hidden"
              aria-label={tr('dot.closeDetails')}
              onClick={() => setDetails(false)}
            >
              <X size={18} />
            </button>
            <DotProfilePanel
              entry={entry}
              overview={overview}
              outputs={outputs}
              onOpenComputer={() => setComputer(true)}
            />
          </div>
        )}
      </div>
      {addMenu && (
        <ActionMenu
          {...addMenu}
          label={tr('dot.add')}
          onClose={() => setAddMenu(null)}
          actions={[
            { label: tr('dot.addFiles'), section: tr('dot.add'), icon: Paperclip, run: () => void pickFiles() },
            { label: tr('dot.computer'), icon: Monitor, run: () => setComputer(true) },
          ]}
        />
      )}
    </main>
  )
}
