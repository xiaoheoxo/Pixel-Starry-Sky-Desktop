import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { cn } from '@/ui'
import { slashName, type SlashId } from './slash'

/** 频道输入框的斜杠命令菜单（docs/ui/channels-local-rest.md §3.3 a）；样式照 MentionMenu */
export function SlashMenu({
  id,
  items,
  selected,
  onChoose,
}: {
  id: string
  items: readonly SlashId[]
  selected: number
  onChoose: (index: number) => void
}) {
  useI18n()
  return (
    <div className="no-drag absolute right-0 bottom-full left-0 z-30 mb-2 overflow-hidden rounded-lg border border-line-card bg-popover p-1 shadow-menu">
      <div id={id} role="listbox" aria-label={tr('channels.slash.label')} className="max-h-64 overflow-y-auto">
        {items.map((item, i) => (
          <button
            type="button"
            role="option"
            tabIndex={-1}
            key={item}
            id={`${id}-${i}`}
            data-slash={item}
            aria-selected={i === selected}
            onMouseDown={e => e.preventDefault()}
            onClick={() => onChoose(i)}
            className={cn(
              'flex h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-list',
              i === selected ? 'bg-selected' : 'hover:bg-hover',
            )}
          >
            <span className="shrink-0 font-medium text-fg">/{slashName(item)}</span>
            <span className="min-w-0 truncate text-meta text-fg-faint">{tr(`channels.slash.${item}.desc`)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
