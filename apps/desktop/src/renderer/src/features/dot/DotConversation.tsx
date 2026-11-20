import { dotError } from './errors'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Clock,
  ExternalLink,
  File,
  ImageIcon,
  Info,
  Monitor,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Plus,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { SessionSnapshot, WorkflowRun } from '@pixelsky/protocol'
import type { DotChatMessage, DotOverview } from '@pixelsky/engine'
import type { DotEntry, DotLocalFile } from '../../../../shared/types/dot-chat'
import { CopyButton, IconButton, Spinner, useToast } from '@/ui'
import { Markdown } from '@/ui/markdown/Markdown'
import { ActionMenu } from '@/ui/ActionMenu'
import { ComposerArea } from '@/features/session/ComposerArea'
import { CARD_STYLE } from '@/features/session/composerStyles'
import '@/features/session/conversation.css'
import { tr, translateMessage } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { DotAvatar } from './DotAvatar'
import { DotProfilePanel, dotWebUrl } from './DotProfilePanel'
import { DotStatusIcon, dotPresence, dotStatus } from './status'
import { DotExperimental } from './DotExperimental'
import {
  dotComposerState,
  dotNotice,
  dotTranscript,
  markDotRows,
  mergeDotHistory,
  placeDotTasks,
  readDropped,
} from './conversation'
import { formatClock, formatDay } from '@/features/channels/format'
import { fileSize } from '@/features/session/attachments/files'
import { keyForConversation } from '@/features/search/ConversationFind'
import { TOGGLE_VOICE } from '@/features/layout/shortcuts'
import { useSettings } from '@/features/settings/SettingsProvider'
import { insertSpoken } from '@/features/voice/model'
import { VoiceButton, useVoiceInput } from '@/features/voice/useVoiceInput'
import { DotFile, isDotImage } from './DotFile'
import { DotComputer } from './DotComputer'
import { DotDeliveryNotice } from './DotDeliveryNotice'
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
  const [resolving, setResolving] = useState(false)
  const refreshSnapshot = useRef<() => Promise<void>>(async () => {})
  const [snapshotError, setSnapshotError] = useState('')
  const [picking, setPicking] = useState(false)
  const [files, setFiles] = useState<DotLocalFile[]>([])
  /** 拖进来、粘贴的图片的缩略图（文件 id → 本页的对象地址）；从对话框选的没有内容，只画图标 */
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const thumbUrls = useRef<Record<string, string>>({})
  thumbUrls.current = thumbs
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
  const marks = useMemo(() => markDotRows(rows), [rows])
  // 任务卡片放在派出它的那条消息下面（docs/ui/dot-optimize.md §7 #4）
  const tasks = useMemo(() => placeDotTasks(rows, snapshot?.runs.workflows ?? []), [rows, snapshot?.runs.workflows])
  /** 会话正在回复：消息由会话事件带来，界面不另外拉历史（§7 #6） */
  const running = useRef(false)
  running.current = !!snapshot && snapshot.state !== 'idle'
  const [dragging, setDragging] = useState(false)
  const root = useRef<HTMLElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const toast = useToast()
  const settings = useSettings()
  const outputs = useMemo(() => rows.filter(row => row.role === 'assistant').flatMap(row => row.attachments), [rows])
  const web = dotWebUrl(entry?.id)
  const name = entry?.name ?? tr('dot.yourDot')

  const readRemote = useCallback(
    async (options: { before?: string; overview?: boolean } = {}) => {
      if (network.current) return
      network.current = true
      setReading(true)
      try {
        // 正看着这个对话（标签可见、窗口在前台）读到的消息算看过，侧栏的未读点消掉（§7 #3）
        const seen = !options.before && visible.current && document.visibilityState === 'visible' && document.hasFocus()
        const next = await window.pixelsky!.dotChat.read(entryKey, { ...options, ...(seen ? { seen } : {}) })
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
    if (!active) setComputer(false)
    else if (haveHistory.current && !running.current) void remote.current()
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
      if (!visible.current || document.visibilityState !== 'visible' || running.current) return
      void remote.current({ overview: ++polls % 6 === 0 })
    }, 10_000)
    // 回到这个窗口：马上读一次（把读到的记成看过），不等下一个 10 秒
    const back = (): void => {
      if (visible.current && document.visibilityState === 'visible' && !running.current) void remote.current()
    }
    window.addEventListener('focus', back)
    return () => {
      alive.current = false
      clearInterval(timer)
      window.removeEventListener('focus', back)
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
    setThumbs(current => {
      const keep = new Set(files.map(file => file.id))
      const gone = Object.keys(current).filter(id => !keep.has(id))
      if (!gone.length) return current
      const next = { ...current }
      for (const id of gone) {
        URL.revokeObjectURL(next[id]!)
        delete next[id]
      }
      return next
    })
  }, [files])
  useEffect(() => () => Object.values(thumbUrls.current).forEach(url => URL.revokeObjectURL(url)), [])
  // 输入框一行起，跟着内容增高（语音、点建议、发送后清空也要重算）
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(192, el.scrollHeight)}px`
    // 从电脑页切回来、开关详情栏后宽度变了，也要重算
  }, [text, computer, details])
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
  // Dot 正在回复时也能发，消息排队、忙完自动发出（docs/ui/dot-optimize.md §9）
  const { busy, replying, uncertain, queued } = dotComposerState(snapshot, { sending, resolving })
  const queueAction = (action: () => Promise<unknown>): void => {
    setError('')
    void action()
      .then(() => refreshSnapshot.current())
      .catch(e => setError(dotError(e)))
  }
  useEffect(() => {
    if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [rows, replying])
  const send = async (): Promise<void> => {
    if (!snapshot || (!text.trim() && !files.length) || busy) return
    setSending(true)
    setError('')
    try {
      await window.pixelsky!.dotChat.send(
        entryKey,
        snapshot.record.id,
        text,
        files.map(f => f.id),
      )
      setText(current => (current === text ? '' : current))
      // Dot 正在忙时这条进了队列，不会马上有会话事件：主动刷新一次，排队卡片立刻出来
      void refreshSnapshot.current()
      const sentIds = new Set(files.map(file => file.id))
      setFiles(current => current.filter(file => !sentIds.has(file.id)))
    } catch (e) {
      setError(dotError(e))
    } finally {
      setSending(false)
    }
  }

  /** 拖进来、粘贴的文件（§7 #5）：有本机路径的传路径，没有的（剪贴板截图）传内容 */
  const addDropped = async (list: File[]): Promise<void> => {
    if (!list.length || picking) return
    setPicking(true)
    setError('')
    try {
      if (files.length + list.length > 10) throw new Error('Dot supports at most 10 attachments per message')
      const items = await readDropped(list, file => window.pixelsky?.pathForFile(file) ?? '')
      const chosen = await window.pixelsky!.dotChat.addFiles(entryKey, items)
      if (!alive.current) return
      // 返回的和传进去的一一对应时才配缩略图
      if (chosen.length === list.length) {
        const made: Record<string, string> = {}
        chosen.forEach((file, i) => {
          if (list[i]!.type.startsWith('image/')) made[file.id] = URL.createObjectURL(list[i]!)
        })
        setThumbs(current => ({ ...current, ...made }))
      }
      setFiles(previous => [...previous, ...chosen].slice(0, 10))
    } catch (e) {
      setError(dotError(e))
    } finally {
      setPicking(false)
    }
  }
  // 语音输入（docs/ui/voice-input.md）：和普通对话一样，识别出的文字放到光标处，不自动发送
  const voice = useVoiceInput({
    onText: spoken => {
      const el = area.current
      const from = el?.selectionStart ?? text.length
      const to = el?.selectionEnd ?? from
      setText(
        current => insertSpoken(current, Math.min(from, current.length), Math.min(to, current.length), spoken).text,
      )
    },
    onError: message => setError(message ?? ''),
    onSetup: () =>
      toast(tr('voice.setup'), {
        action: { label: tr('voice.openSettings'), run: () => settings.openSettings('assist') },
      }),
  })
  const voiceToggle = useRef(voice.toggle)
  voiceToggle.current = voice.toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!root.current || !TOGGLE_VOICE.match(e) || !keyForConversation(root.current, e)) return
      e.preventDefault()
      voiceToggle.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const taskCard = (run: WorkflowRun) => (
    <a
      key={run.id}
      className="dot-task-card"
      data-need={run.status === 'needsInput' || undefined}
      href={web}
      target="_blank"
      rel="noreferrer"
    >
      <DotStatusIcon status={run.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-fg">{run.name || tr('dot.task')}</span>
        <span className="block text-meta text-fg-muted">{dotStatus(run.status)}</span>
      </span>
      <span className={run.status === 'needsInput' ? 'dot-small-button' : 'dot-web-link'}>
        {tr(run.status === 'needsInput' ? 'dot.handleInWeb' : 'dot.openWeb')}
        <ExternalLink size={12} />
      </span>
    </a>
  )

  const pickFiles = async () => {
    if (picking) return
    setPicking(true)
    setError('')
    try {
      const chosen = await window.pixelsky!.dotChat.pickFiles(entryKey)
      setFiles(previous => [...previous, ...chosen].slice(0, 10))
    } catch (e) {
      setError(dotError(e))
    } finally {
      setPicking(false)
    }
  }

  return (
    <main
      ref={root}
      className="dot-conversation conversation-view"
      data-dragging={dragging || undefined}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={e => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(false)
        void addDropped([...e.dataTransfer.files])
      }}
    >
      <header className="dot-toolbar">
        <div className="dot-tab">
          <DotAvatar name={name} url={entry?.avatarUrl} size={26} status={entry?.status} />
          <h1 className="dot-tab-title">{name}</h1>
          {entry?.accountName && (
            <span className="min-w-0 truncate text-meta text-fg-faint" title={entry.accountName}>
              · {entry.accountName}
            </span>
          )}
          <DotExperimental />
        </div>
        <span className="flex-1" />
        <details ref={menuRef} className="relative" open={menu} onToggle={e => setMenu(e.currentTarget.open)}>
          <summary className="dot-icon-button list-none" aria-label={tr('dot.more')}>
            <MoreHorizontal size={18} />
          </summary>
          <div className="absolute top-full right-0 z-30 mt-2 flex w-52 flex-col gap-1 rounded-xl border border-line bg-popover p-1.5 shadow-popover">
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
            <p className="border-t border-line-subtle px-3 pt-2 pb-1 text-label text-fg-faint">{tr('dot.closeHint')}</p>
          </div>
        </details>
        <span className="dot-toolbar-divider" aria-hidden="true" />
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
                  <DotAvatar name={name} url={entry?.avatarUrl} size={56} status={entry?.status} />
                  <div>
                    <h2 className="text-section font-semibold text-fg">{name}</h2>
                    <p className="mt-1 text-meta">
                      {entry ? `${dotPresence(entry.status)} · ` : ''}
                      {tr('dot.welcome')}
                    </p>
                  </div>
                  <div className="dot-suggestions">
                    {(['today', 'summary', 'lookup'] as const).map(id => (
                      <button
                        key={id}
                        type="button"
                        className="dot-suggestion"
                        onClick={() => {
                          // 填进输入框，不自动发；已经写了东西就不动它
                          setText(current => (current.trim() ? current : tr(`dot.suggest.${id}.fill`)))
                          area.current?.focus()
                        }}
                      >
                        {tr(`dot.suggest.${id}`)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {rows.flatMap(row => {
                const mark = marks.get(row.id)
                const day =
                  mark?.day == null
                    ? []
                    : [
                        <div key={`day-${row.id}`} role="separator" className="dot-day">
                          {formatDay(mark.day)}
                        </div>,
                      ]
                const notice = row.role === 'notice' ? dotNotice(row.text) : null
                if (notice) {
                  const NoteIcon = row.level === 'info' || !row.level ? Info : TriangleAlert
                  return [
                    ...day,
                    <div
                      key={row.id}
                      role={row.level === 'error' ? 'alert' : undefined}
                      className="dot-note"
                      data-level={row.level ?? 'info'}
                    >
                      <NoteIcon size={14} className="dot-note-icon" />
                      <span className="min-w-0 flex-1">{translateMessage(notice.text)}</span>
                      {notice.web && (
                        <a className="dot-web-link" href={web} target="_blank" rel="noreferrer">
                          {tr('dot.openWeb')}
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </div>,
                  ]
                }
                const clock = mark?.time == null ? null : formatClock(mark.time)
                const stamp = mark?.time == null ? undefined : new Date(mark.time).toISOString()
                return [
                  ...day,
                  <article key={row.id} className={`dot-message ${row.role === 'user' ? 'is-user' : 'is-assistant'}`}>
                    {mark?.head && (
                      <div className="dot-who">
                        <DotAvatar name={name} url={entry?.avatarUrl} size={20} />
                        <b>{name}</b>
                        {clock && <time dateTime={stamp}>{clock}</time>}
                      </div>
                    )}
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
                          {/* 图片排前面，文件卡片另起一行 */}
                          {[...row.attachments]
                            .sort((a, b) => Number(isDotImage(b)) - Number(isDotImage(a)))
                            .map((file, i) => (
                              <DotFile key={file.fileId ?? i} file={file} />
                            ))}
                        </div>
                      )}
                    </div>
                    {row.role === 'user' && clock && (
                      <time className="dot-time" dateTime={stamp}>
                        {clock}
                      </time>
                    )}
                    {row.role === 'assistant' && row.text && (
                      <div className="dot-message-actions flex text-fg-faint">
                        <CopyButton text={row.text} iconOnly />
                      </div>
                    )}
                  </article>,
                  ...(tasks.under.get(row.id) ?? []).map(taskCard),
                ]
              })}
              {tasks.rest.map(taskCard)}
              {replying && (
                <div role="status" className="dot-typing">
                  <DotAvatar name={name} url={entry?.avatarUrl} size={20} />
                  <span>{tr('dot.replying', { name })}</span>
                  <span className="dot-typing-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              )}
              {snapshot &&
                queued.map(item => (
                  <div key={item.id} className="dot-queued" data-queued={item.id}>
                    {item.text && <div className="dot-queued-text">{item.text}</div>}
                    {!!item.files?.length && (
                      <div className="dot-queued-files">
                        {item.files.map(file => (
                          <span key={file.id}>
                            <Paperclip size={12} />
                            {file.name}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="dot-queued-meta">
                      <Clock size={12} />
                      <span>{snapshot.queuePaused ? tr('dot.queue.paused') : tr('dot.queue.waiting', { name })}</span>
                      {snapshot.queuePaused && (
                        <button
                          type="button"
                          className="dot-small-button"
                          onClick={() => queueAction(() => window.pixelsky!.engine.resumeQueue(snapshot.record.id))}
                        >
                          {tr('dot.queue.resume')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="dot-small-button"
                        onClick={() =>
                          queueAction(async () => {
                            await window.pixelsky!.engine.cancelQueued(snapshot.record.id, item.id)
                            // 撤回的文字放回输入框（已经在写别的就不覆盖）；附件要重新选
                            setText(current => (current.trim() ? current : item.text))
                          })
                        }
                      >
                        {tr('dot.queue.withdraw')}
                      </button>
                    </div>
                  </div>
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
                <div role="alert" className="dot-note mb-2" data-level="error">
                  <TriangleAlert size={14} className="dot-note-icon" />
                  <span className="min-w-0 flex-1">{translateMessage(error || snapshotError || serverError)}</span>
                  <button type="button" className="dot-small-button" disabled={reading} onClick={retry}>
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
              <div className={`${CARD_STYLE} dot-composer`}>
                {!!files.length && (
                  <div className="dot-pending-files" aria-label={tr('dot.pendingFiles')}>
                    {files.map(file => (
                      <div className="dot-file-card" key={file.id} title={file.name}>
                        <span className="dot-file-thumb">
                          {thumbs[file.id] ? (
                            <img src={thumbs[file.id]} alt="" />
                          ) : isDotImage({ type: 'file', name: file.name }) ? (
                            <ImageIcon size={16} />
                          ) : (
                            <File size={16} />
                          )}
                        </span>
                        <span className="dot-file-text">
                          <b>{file.name}</b>
                          <span>{fileSize(file.bytes)}</span>
                        </span>
                        <button
                          type="button"
                          className="dot-file-remove"
                          aria-label={`${tr('composer.attachment.remove')} ${file.name}`}
                          onClick={() => setFiles(current => current.filter(f => f.id !== file.id))}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="dot-composer-line">
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
                  <textarea
                    ref={area}
                    autoFocus
                    onPaste={e => {
                      const pasted = [...e.clipboardData.files]
                      if (!pasted.length) return
                      e.preventDefault()
                      void addDropped(pasted)
                    }}
                    rows={1}
                    aria-label={tr('dot.message')}
                    placeholder={tr('dot.placeholderName', { name })}
                    value={text}
                    maxLength={100000}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        void send()
                      }
                    }}
                  />
                  <VoiceButton voice={voice} size={32} />
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
      {dragging && (
        <div className="dot-drop-hint" aria-hidden>
          <Paperclip size={18} />
          {tr('dot.dropHint')}
        </div>
      )}
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
