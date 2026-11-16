import { useEffect, useRef, useState } from 'react'
import { cn } from '@/ui'
import { useUnmountFlush } from '@/ui/useUnmountFlush'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { formatTokens, isTokenDraftDirty, parseTokens } from './tokenCount'

/**
 * 上下文长度：可以写 1m、200k、200000；离开时显示成 1M / 200K。
 * 输入中不标红（打 5000 会经过 5、50、500）；离开时认不出或超出范围就保留原文、标红，并告诉外面不能保存。
 * commit="blur"（设置页直接保存的地方）：离开或回车时才交出去，不按每次按键保存
 */
export function ContextWindowInput({
  value,
  label,
  commit = 'change',
  onChange,
  onValidity,
  onDraftDirty,
  placeholder,
  ghost = false,
}: {
  value: number | null
  label?: string
  commit?: 'change' | 'blur'
  /** 留空时的灰字（如官方表里的 1M）；不给用「自动」 */
  placeholder?: string
  /** 平时不画边框、窄一些，悬停所在行或聚焦时才像输入框（菜单里显示的模型，docs/ui/menu-models.md） */
  ghost?: boolean
  onChange(value: number | null): void
  onValidity?(ok: boolean): void
  /** 输入中就报告：输入框里的文字和当前值对不上（含认不出的）；打字时不标红，只给外面判断关闭前要不要确认 */
  onDraftDirty?(dirty: boolean): void
}) {
  useI18n()
  const [draft, setDraft] = useState(value === null ? '' : formatTokens(value))
  const [editing, setEditing] = useState(false)
  const editingRef = useRef(false)
  // 外面改了值（例如从接口读取模型）且没在输入时，跟着显示
  useEffect(() => {
    if (!editingRef.current) setDraft(value === null ? '' : formatTokens(value))
  }, [value])
  // 改了还没离开输入框就被卸载（关掉设置、切走分区）：补交一次，认不出的照旧不交
  const unsaved = useUnmountFlush(() => {
    const next = parseTokens(draft)
    if (commit === 'blur' && next !== undefined && next !== value) onChange(next)
  })
  const parsed = parseTokens(draft)
  const invalid = !editing && parsed === undefined
  return (
    <input
      aria-label={label ?? tr('customApi.contextWindow')}
      aria-invalid={invalid}
      title={invalid ? tr('customApi.contextWindowHint') : tr('customApi.contextWindowTip')}
      placeholder={
        placeholder ?? (commit === 'blur' ? tr('contextWindow.auto') : tr('customApi.contextWindowPlaceholder'))
      }
      value={draft}
      onFocus={() => {
        editingRef.current = true
        setEditing(true)
      }}
      onChange={e => {
        setDraft(e.target.value)
        unsaved.current = true
        onDraftDirty?.(isTokenDraftDirty(e.target.value, value))
        const next = parseTokens(e.target.value)
        if (commit === 'change' && next !== undefined) onChange(next)
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      onBlur={e => {
        editingRef.current = false
        unsaved.current = false
        setEditing(false)
        // 读输入框当前的值：打完字马上离开时，这次渲染里的 draft 可能还是旧的
        const next = parseTokens(e.currentTarget.value)
        onValidity?.(next !== undefined)
        onDraftDirty?.(next === undefined)
        if (next === undefined) return
        setDraft(next === null ? '' : formatTokens(next))
        if (commit === 'blur' && next !== value) onChange(next)
      }}
      className={cn(
        'shrink-0 rounded-md border text-meta tabular-nums text-fg outline-none placeholder:text-fg-faint',
        ghost
          ? 'h-6 w-20 px-1.5 text-right group-hover:border-line group-hover:bg-subtle focus:bg-surface'
          : 'h-7 w-28 bg-subtle px-2',
        invalid
          ? 'border-danger'
          : ghost
            ? 'border-transparent bg-transparent focus:border-line-strong'
            : 'border-line focus:border-line-strong',
      )}
    />
  )
}
