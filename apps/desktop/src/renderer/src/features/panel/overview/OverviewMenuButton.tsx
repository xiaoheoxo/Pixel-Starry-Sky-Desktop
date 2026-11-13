// 标签栏上概况的两个按钮：全部折叠 / 展开，滑杆图标选显示哪些分组
import { useRef, useState } from 'react'
import { ChevronsDownUp, ChevronsUpDown, SlidersHorizontal } from 'lucide-react'
import { IconButton, Popover, Switch } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { FOLDABLE_IDS, OVERVIEW_SECTIONS } from './OverviewPanel'
import { overviewPrefs, useOverviewPrefs } from './overviewPrefs'

export function OverviewMenuButton() {
  useI18n()
  const { hidden, collapsed } = useOverviewPrefs()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const folded = FOLDABLE_IDS.every(id => collapsed.includes(id))
  return (
    <>
      {/* 全部折叠成速览：每组一行摘要；「要处理」不收 */}
      <IconButton
        icon={folded ? ChevronsUpDown : ChevronsDownUp}
        label={tr(folded ? 'overview.unfoldAll' : 'overview.foldAll')}
        size={28}
        iconSize={15}
        onClick={() => overviewPrefs.setAllCollapsed(FOLDABLE_IDS, !folded)}
      />
      <IconButton
        ref={anchor}
        icon={SlidersHorizontal}
        label={tr('overview.customize')}
        size={28}
        iconSize={15}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        align="end"
        bare
        role="dialog"
        aria-label={tr('overview.menuTitle')}
        className="w-[214px] p-1.5"
      >
        <div className="px-1.5 pt-0.5 pb-1 text-meta text-fg-muted">{tr('overview.menuTitle')}</div>
        {OVERVIEW_SECTIONS.map(({ id, title }) => (
          <label
            key={id}
            className="flex min-h-[26px] items-center justify-between gap-2 rounded-sm px-1.5 text-list text-fg hover:bg-hover"
          >
            {tr(title)}
            <Switch
              size="sm"
              label={tr(title)}
              checked={!hidden.includes(id)}
              onChange={() => overviewPrefs.toggleHidden(id)}
            />
          </label>
        ))}
        <div className="mt-1 border-t border-line-subtle px-1.5 pt-1 pb-px">
          <button
            type="button"
            onClick={overviewPrefs.reset}
            className="press h-6 rounded-sm px-0.5 text-meta text-accent-fg hover:underline"
          >
            {tr('overview.reset')}
          </button>
        </div>
      </Popover>
    </>
  )
}
