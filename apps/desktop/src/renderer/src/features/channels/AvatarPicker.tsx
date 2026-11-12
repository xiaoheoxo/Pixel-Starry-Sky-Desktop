import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage, type TranslationKey } from '../../i18n/core'
import { useEffect, useRef, useState } from 'react'
import { cn, Popover, useToast } from '@/ui'
import type { AgentMember } from '@/data/types'
import type { AgentAvatar } from '../../../../shared/types/channels'
import {
  AVATAR_COLORS,
  AVATAR_EMOJIS,
  AVATAR_ICONS,
  AVATAR_PATTERNS,
  AVATAR_STYLES,
  defaultAvatar,
} from '../../../../shared/channels/avatar'
import { MemberAvatar } from './ChannelMessage'
import { AVATAR_ICON } from './AgentAvatar'
import { channelActions } from './store'

const TEXT_DEBOUNCE = 300

const chip = (on: boolean) =>
  cn(
    'press inline-flex items-center justify-center rounded-md border',
    on ? 'border-accent bg-selected' : 'border-transparent hover:bg-hover',
  )

/** 右栏成员卡上的头像：可换时是按钮，点了弹出换头像面板（docs/ui/channels-side-panels.md §4.2），点一下就保存 */
export function AvatarPicker({ member, size, editable }: { member: AgentMember; size: number; editable: boolean }) {
  useI18n()
  const toast = useToast()
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // 保存中先显示新的；store 里的头像变了（保存成功推回来）就跟着 store
  const [draft, setDraft] = useState<AgentAvatar | null | undefined>(undefined)
  const stored = member.avatar ?? null
  const storedKey = JSON.stringify(stored)
  useEffect(() => setDraft(undefined), [storedKey])
  const shown = draft === undefined ? stored : draft
  const current: AgentAvatar = shown ?? { style: 'engine', color: defaultAvatar(member.name).color }
  const view = { ...member, avatar: shown }

  const save = (next: AgentAvatar) => {
    setDraft(next)
    channelActions.setAvatar(member.id, next).catch(e => {
      setDraft(undefined)
      toast(tr('channels.task.actionFailed', { error: translateMessage((e as Error).message) }))
    })
  }
  const pick = (patch: Partial<AgentAvatar>) => save({ ...current, ...patch })

  // 文字：输入法选字中不存，停 300ms 或失焦再存
  const [text, setText] = useState(current.text ?? '')
  const composing = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const flushText = (value: string) => {
    clearTimeout(timer.current)
    const t = [...value.trim()].slice(0, 2).join('')
    if (t !== (current.text ?? '')) pick({ text: t || undefined })
  }
  const typeText = (value: string) => {
    setText(value)
    if (composing.current) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => flushText(value), TEXT_DEBOUNCE)
  }

  if (!editable) return <MemberAvatar member={member} size={size} />
  const worded = current.style === 'letter' || current.style === 'gradient'
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={tr('channels.avatar.change')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={tr('channels.avatar.change')}
        onClick={() => {
          setText(current.text ?? '')
          setOpen(o => !o)
        }}
        className="press inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-accent"
      >
        <MemberAvatar member={view} size={size} />
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        role="dialog"
        aria-label={tr('channels.avatar.change')}
        className="w-72 p-3"
      >
        <div className="flex flex-col gap-2 text-meta">
          <div className="flex items-center gap-2.5 pb-1">
            <MemberAvatar member={view} size={40} />
            <span className="min-w-0 truncate text-list font-medium text-fg">{member.name}</span>
          </div>
          <span className="font-medium text-fg-muted">{tr('channels.avatar.style')}</span>
          <div className="grid grid-cols-3 gap-1">
            {AVATAR_STYLES.map(style => (
              <button
                key={style}
                type="button"
                aria-pressed={current.style === style}
                // 面板挂在 body 末尾：打开时把焦点放进来，键盘才够得着
                autoFocus={current.style === style}
                onClick={() => pick({ style })}
                className={cn(chip(current.style === style), 'h-8 justify-start gap-1.5 px-1.5 text-fg-secondary')}
              >
                <MemberAvatar member={{ ...member, avatar: { ...current, style } }} size={18} />
                <span className="truncate">{tr(`channels.avatar.style.${style}` as TranslationKey)}</span>
              </button>
            ))}
          </div>
          {current.style !== 'engine' && (
            <>
              <span className="font-medium text-fg-muted">{tr('channels.avatar.color')}</span>
              <div className="flex flex-wrap gap-1.5">
                {AVATAR_COLORS.map(color => (
                  <button
                    key={color}
                    type="button"
                    aria-pressed={current.color === color}
                    aria-label={tr(`channels.avatar.color.${color}`)}
                    title={tr(`channels.avatar.color.${color}`)}
                    onClick={() => pick({ color })}
                    className={cn(
                      'press size-6 rounded-full ring-offset-2 ring-offset-surface',
                      current.color === color && 'ring-2 ring-accent',
                    )}
                    style={{ background: `var(--avatar-${color})` }}
                  />
                ))}
              </div>
            </>
          )}
          {current.style === 'icon' && (
            <>
              <span className="font-medium text-fg-muted">{tr('channels.avatar.icon')}</span>
              <div className="grid grid-cols-6 gap-1">
                {AVATAR_ICONS.map(icon => {
                  const Icon = AVATAR_ICON[icon]
                  return (
                    <button
                      key={icon}
                      type="button"
                      aria-pressed={current.icon === icon}
                      aria-label={tr(`channels.avatar.icon.${icon}`)}
                      title={tr(`channels.avatar.icon.${icon}`)}
                      onClick={() => pick({ icon })}
                      className={cn(chip(current.icon === icon), 'h-8 text-fg-secondary')}
                    >
                      <Icon size={16} strokeWidth={1.9} />
                    </button>
                  )
                })}
              </div>
            </>
          )}
          {current.style === 'emoji' && (
            <>
              <span className="font-medium text-fg-muted">{tr('channels.avatar.emoji')}</span>
              <div className="grid grid-cols-6 gap-1">
                {AVATAR_EMOJIS.map(emoji => (
                  <button
                    key={emoji}
                    type="button"
                    aria-pressed={current.emoji === emoji}
                    aria-label={emoji}
                    onClick={() => pick({ emoji })}
                    className={cn(chip(current.emoji === emoji), 'h-8 text-ui')}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </>
          )}
          {current.style === 'pixel' && (
            <>
              <span className="font-medium text-fg-muted">{tr('channels.avatar.pattern')}</span>
              <div className="grid grid-cols-6 gap-1">
                {Array.from({ length: AVATAR_PATTERNS }, (_, i) => i + 1).map(seed => (
                  <button
                    key={seed}
                    type="button"
                    aria-pressed={(current.seed ?? 1) === seed}
                    aria-label={tr('channels.avatar.patternN', { n: seed })}
                    onClick={() => pick({ seed })}
                    className={cn(chip((current.seed ?? 1) === seed), 'h-8')}
                  >
                    <MemberAvatar member={{ ...member, avatar: { ...current, seed } }} size={22} />
                  </button>
                ))}
              </div>
            </>
          )}
          {worded && (
            <label className="flex flex-col gap-1">
              <span className="font-medium text-fg-muted">{tr('channels.avatar.text')}</span>
              <input
                value={text}
                maxLength={8}
                autoComplete="off"
                onChange={e => typeText(e.target.value)}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={e => {
                  composing.current = false
                  typeText(e.currentTarget.value)
                }}
                onBlur={e => flushText(e.currentTarget.value)}
                className="h-8 rounded-md border border-line bg-surface px-2 text-ui text-fg outline-none focus:border-accent"
              />
              <span className="text-fg-faint">{tr('channels.avatar.textHint')}</span>
            </label>
          )}
          {current.style === 'engine' && <p className="text-fg-faint">{tr('channels.avatar.engineHint')}</p>}
        </div>
      </Popover>
    </>
  )
}
