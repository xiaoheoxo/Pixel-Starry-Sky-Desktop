import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { Popover, cn } from '@/ui'
import { useUnmountFlush } from '@/ui/useUnmountFlush'
import { listLocalFonts } from '@/features/appearance/fonts'

interface FontPickerProps {
  /** 无障碍名称，例如「界面字体」 */
  label: string
  /** 当前字体（逗号分隔的回退链），空字符串表示系统默认 */
  value: string
  onChange: (value: string) => void
  /** 系统默认时输入框里显示的提示，例如默认字体链 */
  placeholder: string
  /** 预览用的示例文字 */
  sample: string
}

/**
 * 字体选择：可以直接输入字体名（逗号分隔，回车或离开输入框时生效），
 * 也可以点右边的箭头从本机已安装字体里搜索选择，每一项用该字体本身预览。docs/ui/settings.md §7
 */
export function FontPicker({ label, value, onChange, placeholder, sample }: FontPickerProps) {
  useI18n()
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [fonts, setFonts] = useState<string[] | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => setDraft(value), [value])

  // 按 Esc 关闭列表（点外面由 Popover 处理）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  const openList = () => {
    setOpen(v => !v)
    setQuery('')
    // 读本机字体需要用户点击触发（浏览器的限制），所以在这里才读
    if (fonts === null) void listLocalFonts().then(setFonts)
  }

  const commit = () => {
    unsaved.current = false
    if (draft.trim() !== value) onChange(draft.trim())
  }
  // 打了字还没离开输入框就关掉设置：补存一次
  const unsaved = useUnmountFlush(commit)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = fonts ?? []
    return (q ? list.filter(f => f.toLowerCase().includes(q)) : list).slice(0, 300)
  }, [fonts, query])

  return (
    <div ref={boxRef} className="relative w-full max-w-[420px]">
      <div className="flex h-9 items-stretch overflow-hidden rounded-md border border-line-strong bg-surface focus-within:border-accent-line">
        <input
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          onChange={e => {
            setDraft(e.target.value)
            unsaved.current = true
          }}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit()
          }}
          className="min-w-0 flex-1 bg-transparent px-3 text-list text-fg outline-none placeholder:text-fg-faint"
          style={{ fontFamily: draft.trim() ? `${draft}, var(--font-sans)` : undefined }}
        />
        <button
          type="button"
          aria-label={tr('settings.FontPicker.chooseFromInstalledFonts', { p0: label })}
          aria-expanded={open}
          aria-controls={listId}
          onClick={openList}
          className="flex w-9 shrink-0 items-center justify-center border-l border-line text-fg-muted hover:bg-hover hover:text-fg"
        >
          <ChevronDown size={15} strokeWidth={1.5} />
        </button>
      </div>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={boxRef}
        matchWidth
        bare
        className="flex max-h-72 flex-col overflow-hidden"
      >
        <div id={listId} className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-3 text-fg-muted">
            <Search size={14} strokeWidth={1.5} className="shrink-0" />
            <input
              autoFocus
              aria-label={tr('settings.FontPicker.searchFonts')}
              value={query}
              placeholder={tr('settings.FontPicker.searchInstalledFonts')}
              onChange={e => setQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-list text-fg outline-none placeholder:text-fg-faint"
            />
          </div>
          <ul role="listbox" aria-label={label} className="min-h-0 flex-1 overflow-y-auto p-1">
            <FontOption
              selected={!value}
              onSelect={() => {
                onChange('')
                setOpen(false)
              }}
            >
              <span className="text-fg">{tr('settings.FontPicker.systemDefault')}</span>
            </FontOption>
            {fonts === null && (
              <li className="px-2.5 py-2 text-meta text-fg-faint">{tr('settings.FontPicker.loadingInstalledFonts')}</li>
            )}
            {fonts !== null && fonts.length === 0 && (
              <li className="px-2.5 py-2 text-meta text-fg-faint">{tr('settings.FontPicker.couldNotLoadInstalled')}</li>
            )}
            {fonts !== null && fonts.length > 0 && shown.length === 0 && (
              <li className="px-2.5 py-2 text-meta text-fg-faint">{tr('settings.FontPicker.noMatchingFonts')}</li>
            )}
            {shown.map(family => (
              <FontOption
                key={family}
                selected={value === family}
                onSelect={() => {
                  onChange(family)
                  setOpen(false)
                }}
              >
                <span className="min-w-0 truncate text-fg" style={{ fontFamily: `"${family}"` }}>
                  {family}
                </span>
                <span
                  className="ml-auto shrink-0 truncate pl-3 text-meta text-fg-faint"
                  style={{ fontFamily: `"${family}"` }}
                >
                  {sample}
                </span>
              </FontOption>
            ))}
          </ul>
        </div>
      </Popover>
    </div>
  )
}

function FontOption({
  selected,
  onSelect,
  children,
}: {
  selected: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  useI18n()
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex h-8 w-full items-center rounded-md px-2.5 text-left text-list hover:bg-hover',
          selected && 'bg-selected hover:bg-selected',
        )}
      >
        {children}
      </button>
    </li>
  )
}
