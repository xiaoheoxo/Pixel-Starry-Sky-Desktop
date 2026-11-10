// 对话查看模式的按钮和菜单（docs/ui/view-mode.md §6）：放在输入框状态栏，普通只有图标，思考、详细带文字和强调底色
import { useRef, useState } from 'react'
import { Brain, Eye, ListTree, type LucideIcon } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '../../i18n/core'
import { Popover, PopoverItem, cn } from '@/ui'
import { CYCLE_VIEW_MODE } from '@/features/layout/shortcuts'
import { VIEW_MODES, setViewMode, useStoredViewMode, type ViewMode } from './viewMode'

export const VIEW_MODE_META: Record<ViewMode, { icon: LucideIcon; label: TranslationKey; hint: TranslationKey }> = {
  normal: { icon: Eye, label: 'viewMode.normal', hint: 'viewMode.normalHint' },
  thinking: { icon: Brain, label: 'viewMode.thinking', hint: 'viewMode.thinkingHint' },
  detailed: { icon: ListTree, label: 'viewMode.detailed', hint: 'viewMode.detailedHint' },
}

export function ViewModeButton({ onPick }: { onPick: (mode: ViewMode) => void }) {
  useI18n()
  const mode = useStoredViewMode()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const { icon: Icon, label } = VIEW_MODE_META[mode]
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-view-mode-toggle
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={tr('viewMode.buttonLabel', { mode: tr(label) })}
        title={tr('viewMode.buttonTitle', { mode: tr(label), key: CYCLE_VIEW_MODE.label })}
        onClick={() => setOpen(v => !v)}
        className={cn(
          'press inline-flex items-center gap-1 rounded px-1 hover:bg-hover hover:text-fg',
          mode !== 'normal' && 'bg-accent-soft text-accent-fg hover:bg-accent-soft',
        )}
      >
        <Icon size={13} strokeWidth={1.5} />
        {mode !== 'normal' && <span>{tr(label)}</span>}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        side="top"
        role="menu"
        aria-label={tr('viewMode.title')}
        className="w-72"
      >
        {VIEW_MODES.map(m => {
          const meta = VIEW_MODE_META[m]
          const MIcon = meta.icon
          return (
            <PopoverItem
              key={m}
              role="menuitemradio"
              checked={m === mode}
              selected={m === mode}
              icon={<MIcon size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />}
              title={tr(meta.hint)}
              onClick={() => {
                setOpen(false)
                setViewMode(m)
                onPick(m)
              }}
            >
              {tr(meta.label)}
              <span className="ml-2 text-meta text-fg-faint">{tr(meta.hint)}</span>
            </PopoverItem>
          )
        })}
        <p className="mt-1 border-t border-line-subtle px-2 pt-1.5 pb-0.5 text-meta text-fg-faint">
          {tr('viewMode.footer', { key: CYCLE_VIEW_MODE.label })}
        </p>
      </Popover>
    </>
  )
}
