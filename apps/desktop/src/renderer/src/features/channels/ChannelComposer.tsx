import { useI18n } from '@/i18n/I18nProvider'
import { getLocale, tr, translateMessage } from '../../i18n/core'
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from 'react'
import { ArrowUp, CornerUpLeft, Paperclip, TriangleAlert, X } from 'lucide-react'
import { cn, IconButton, useToast } from '@/ui'
import { CARD_STYLE } from '@/features/session/Composer'
import { composerDraft, useComposerDraft } from '@/features/engine/drafts'
import { isDemo } from '@/data'
import type { Channel, ChannelMember } from '@/data/types'
import type { ChannelAttachments, TeamRole } from '../../../../shared/types/channels'
import { ImageAttachments } from '@/features/session/attachments/ImageAttachments'
import { FileAttachments } from '@/features/session/attachments/FileAttachments'
import { transferFiles, useChannelAttachments } from './useChannelAttachments'
import type { Quotable } from './ChannelMessage'
import { channelsLive } from './store'
import {
  excerpt,
  filterMentionable,
  continuesTask,
  defaultMentionIndex,
  insertMention,
  mentionAllOption,
  mentionAt,
  mentionsAll,
  sharedDirAgents,
} from './model'
import { MENTION_ALL } from '../../../../shared/channels/mentions'
import { MentionMenu } from './MentionMenu'
import { canDispatch, mentionNote } from './teamModel'

const LINE_HEIGHT = 24
const MAX_ROWS = 8

/** 频道输入框（docs/ui/channels.md §6）：文本、附件（本机频道，可粘贴 / 拖进来）和发送；@ 菜单、引用条、按频道保存草稿 */
export function ChannelComposer({
  channel,
  members,
  selfId,
  replyTo,
  replyAuthor,
  followUp,
  role,
  offline = false,
  onSend,
  onCancelReply,
  inputRef,
}: {
  channel: Channel
  /** 这个频道的成员 */
  members: readonly ChannelMember[]
  selfId: string | null
  replyTo: Quotable | null
  replyAuthor: ChannelMember | undefined
  /** 引用的是任务卡或任务结果：这条消息是给那项活追加要求（docs/ui/channels-phase-b.md §7.1） */
  followUp: { assigneeId: string; assignee: string; title: string } | null
  /** Phase C：我在这个团队里的角色（观察者不能派活） */
  role?: TeamRole
  /** Phase C：团队频道连不上云端，不能发送 */
  offline?: boolean
  /** 发出去了才清空输入框；失败时抛出原因 */
  onSend: (text: string, extra: ChannelAttachments) => Promise<void>
  onCancelReply: () => void
  inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  useI18n()
  const menuId = useId()
  const team = channel.scope === 'team'
  // 演示数据和真实数据共用草稿存储，演示模式加前缀避免混在一起
  const draftKey = `${isDemo ? 'demo:' : ''}channel:${channel.id}`
  const [value, setValue] = useComposerDraft(draftKey)
  const attach = useChannelAttachments(draftKey)
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [caret, setCaret] = useState(0)
  const [selected, setSelected] = useState(0)
  /** 按 Esc 关掉的那个 @ 的位置；光标移到别的 @ 时菜单重新出现 */
  const [dismissed, setDismissed] = useState<number | null>(null)
  const mention = mentionAt(value, caret)
  const candidates = useMemo(
    () => (mention ? filterMentionable(members, mention.query, selfId) : []),
    [members, mention?.query, mention?.start, selfId],
  )
  /** 最上面的「全体 AI 成员」：插入时按界面语言写「全体」或「all」 */
  const allToken = getLocale() === 'en-US' ? MENTION_ALL.en : MENTION_ALL.zh
  const all = useMemo(() => {
    const option = mention ? mentionAllOption(members, mention.query) : null
    if (!option) return null
    const approval = team ? members.filter(m => m.kind === 'agent' && mentionNote(m, role) === 'approval').length : 0
    return { ...option, token: allToken, approval }
  }, [members, mention?.query, mention?.start, team, role, allToken])
  const total = candidates.length + (all ? 1 : 0)
  const menuOpen = !!mention && dismissed !== mention.start
  /** 写了 @全体、又有成员用同一个目录：提示可能冲突 */
  const sharedDir = useMemo(() => (mentionsAll(value, members) ? sharedDirAgents(members) : []), [value, members])
  const toast = useToast()
  // 引用了任务卡但又 @全体 / @ 了别的 AI 成员：不再是追加要求，引用条照普通回复写
  const continuing = useMemo(
    () => (followUp && continuesTask(value, members, followUp.assigneeId) ? followUp : null),
    [followUp, value, members],
  )
  const [sending, setSending] = useState(false)
  const hasAttachments = !team && (attach.images.length > 0 || attach.files.length > 0)
  const canSend = (value.trim().length > 0 || hasAttachments) && !sending && !offline && !attach.busy
  const hasAgents = members.some(m => m.kind === 'agent')

  // 自动增高，最多 8 行
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, LINE_HEIGHT * MAX_ROWS + 16)}px`
  }, [value, inputRef])

  // 换了输入或候选变了（成员增减、「全体」出现 / 消失）都回到默认项，不会停在不存在的项上
  const hasAll = !!all
  useLayoutEffect(
    () => setSelected(defaultMentionIndex(mention?.query ?? '', hasAll, candidates.length)),
    [mention?.query, mention?.start, hasAll, candidates.length],
  )

  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? 0)

  const choose = (index: number) => {
    if (!mention) return
    const member = all ? (index === 0 ? null : candidates[index - 1]) : candidates[index]
    if (!member && !(all && index === 0)) return
    // 观察者不能派活：@ AI 成员只当文字，菜单里灰掉
    if (team && (member ? mentionNote(member, role) === 'observer' : !canDispatch(role))) return
    const next = insertMention(value, { start: mention.start, end: caret }, member ? member.name : all!.token)
    setValue(next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(next.caret, next.caret))
  }

  const send = () => {
    if (!canSend) return
    setSending(true)
    const sent = hasAttachments ? { images: attach.images, files: attach.files } : { images: [], files: [] }
    const text = value
    onSend(text, sent)
      .then(() => {
        // 发送期间又打的字留着：没动过就清空，接在后面打的只去掉发出去的那段，改过前面的整段保留
        const current = composerDraft(draftKey)
        if (current.startsWith(text)) {
          const rest = current.slice(text.length).trimStart()
          setValue(rest)
          setCaret(rest.length)
          if (!rest) setDismissed(null)
        }
        if (hasAttachments) void attach.clear(sent).catch(() => {})
      })
      .catch(error => toast(tr('channels.composer.sendFailed', { error: translateMessage((error as Error).message) })))
      .finally(() => setSending(false))
  }

  /** 粘贴 / 拖进来的文件当附件；团队频道不支持，说一声 */
  const takeFiles = (files: File[]): boolean => {
    if (!files.length) return false
    if (team) toast(tr('channels.attach.team'))
    else attach.add(files)
    return true
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!takeFiles(transferFiles(e.clipboardData))) return
    // 复制的文件同时带着文字（比如文件名）时，文字照常插进去
    e.preventDefault()
    const pasted = e.clipboardData.getData('text/plain')
    if (pasted && !team) {
      const el = e.currentTarget,
        start = el.selectionStart,
        end = el.selectionEnd
      setValue(value.slice(0, start) + pasted + value.slice(end))
      setCaret(start + pasted.length)
    }
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setDragging(false)
    takeFiles(transferFiles(e.dataTransfer))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法组合中（候选字还没上屏）不处理 Enter / 方向键
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (menuOpen) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && total) {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setSelected(i => (i + delta + total) % total)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && total) {
        e.preventDefault()
        choose(selected)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDismissed(mention.start)
        return
      }
    }
    if (e.key === 'Escape' && replyTo) {
      e.preventDefault()
      e.stopPropagation()
      onCancelReply()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="conversation-inset conversation-reading shrink-0 pb-4">
      <div className="relative">
        {menuOpen && (
          <MentionMenu
            id={menuId}
            members={candidates}
            all={all}
            selected={selected}
            onChoose={choose}
            team={team}
            role={role}
          />
        )}
        <div
          onDragEnter={e => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault()
              setDragging(true)
            }
          }}
          onDragOver={e => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault()
          }}
          onDragLeave={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
          }}
          onDrop={onDrop}
          className={cn(CARD_STYLE, 'relative overflow-hidden', dragging && !team && 'ring-2 ring-accent')}
        >
          {dragging && !team && (
            <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent-line bg-accent-soft/80 text-ui font-medium text-accent-fg">
              {tr('composer.file.drop')}
            </div>
          )}
          {replyTo && (
            <div className="flex min-w-0 items-center gap-2 border-b border-line-subtle py-1 pr-1.5 pl-3 text-meta text-fg-muted">
              <CornerUpLeft size={13} strokeWidth={1.5} className="shrink-0" />
              <span className="shrink-0 font-medium">
                {continuing
                  ? tr('channels.followUpTo', { name: continuing.assignee })
                  : tr('channels.replyingTo', { name: replyAuthor?.name ?? '?' })}
              </span>
              <span className="min-w-0 flex-1 truncate text-fg-faint">
                {excerpt(continuing ? continuing.title : replyTo.kind === 'task' ? replyTo.title : replyTo.text)}
              </span>
              <IconButton
                icon={X}
                label={tr('channels.cancelReply')}
                size={22}
                iconSize={13}
                onClick={() => {
                  onCancelReply()
                  inputRef.current?.focus()
                }}
              />
            </div>
          )}
          {sharedDir.length > 0 && (
            <div
              data-mention-all-warning=""
              className="flex min-w-0 items-center gap-2 border-b border-line-subtle px-3 py-1.5 text-meta text-fg-muted"
            >
              <TriangleAlert size={13} strokeWidth={1.5} className="shrink-0 text-warn" />
              <span className="min-w-0 flex-1">
                {tr('channels.composer.allSharesDir', { names: sharedDir.join(tr('channels.composer.nameSep')) })}
              </span>
            </div>
          )}
          {hasAttachments && (
            <div data-channel-composer-attachments="" className="flex flex-col gap-2 px-3 pt-3">
              {attach.images.length > 0 && (
                <ImageAttachments
                  images={attach.images}
                  onRemove={attach.removeImage}
                  onReplace={attach.replaceImage}
                />
              )}
              {attach.files.length > 0 && <FileAttachments files={attach.files} onRemove={attach.removeFile} />}
            </div>
          )}
          {attach.error && !team && (
            <div className="px-4 pt-2 text-meta whitespace-pre-wrap text-danger">{translateMessage(attach.error)}</div>
          )}
          <div className={cn('flex items-end gap-2 py-2 pr-2', team ? 'pl-4' : 'pl-1.5')}>
            {!team && (
              <>
                <IconButton
                  icon={Paperclip}
                  label={tr('channels.attach.add')}
                  size={32}
                  disabled={offline}
                  onClick={() => fileInput.current?.click()}
                />
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={event => {
                    if (event.currentTarget.files) attach.add(event.currentTarget.files)
                    event.currentTarget.value = ''
                  }}
                />
              </>
            )}
            <textarea
              ref={inputRef as Ref<HTMLTextAreaElement>}
              rows={1}
              value={value}
              aria-label={tr('channels.composer.label')}
              disabled={offline}
              placeholder={
                offline
                  ? tr('team.composer.offline')
                  : tr(
                      channelsLive && !hasAgents
                        ? 'channels.composer.placeholderNoAgents'
                        : 'channels.composer.placeholder',
                      { name: channel.name },
                    )
              }
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
              aria-activedescendant={menuOpen && total ? `${menuId}-${selected}` : undefined}
              onChange={e => {
                setValue(e.target.value)
                setCaret(e.target.selectionStart ?? e.target.value.length)
              }}
              onSelect={syncCaret}
              onKeyUp={syncCaret}
              onClick={syncCaret}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              className="block max-h-[208px] min-h-8 flex-1 resize-none bg-transparent py-1 text-prose leading-6 text-fg outline-none placeholder:text-fg-faint"
            />
            <button
              type="button"
              aria-label={tr('channels.composer.send')}
              title={tr('channels.composer.send')}
              aria-disabled={!canSend}
              onClick={send}
              className={cn(
                'no-drag inline-flex size-8 shrink-0 items-center justify-center rounded-full',
                canSend ? 'press bg-primary text-primary-fg hover:opacity-90' : 'bg-disabled text-disabled-fg',
              )}
            >
              <ArrowUp size={17} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
      {isDemo && <p className="mt-1.5 px-1 text-meta text-fg-faint">{tr('channels.composer.demoHint')}</p>}
    </div>
  )
}
