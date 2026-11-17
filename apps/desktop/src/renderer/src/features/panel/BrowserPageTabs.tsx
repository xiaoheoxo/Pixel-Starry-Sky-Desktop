// 内置浏览器的页面标签（docs/ui/browser-v2.md §3.1）：两个以上页面才出。网站图标、加载中转圈、有问题时红点；中键关闭；右键菜单
import { useRef, useState } from 'react'
import { Copy, CopyPlus, Globe, Plus, RefreshCw, X } from 'lucide-react'
import { IconButton, Spinner, cn, useToast } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import type { BrowserPage } from '../../../../shared/types/project-browser'
import { pageHasProblem } from './browserModel'

export function PageIcon({ page, size = 14 }: { page: BrowserPage; size?: number }) {
  if (page.loading) return <Spinner size={size} />
  return (
    <span className="relative flex shrink-0" style={{ width: size, height: size }}>
      {page.favicon ? (
        <img src={page.favicon} alt="" draggable={false} className="size-full rounded-[3px] object-contain" />
      ) : (
        <Globe size={size} strokeWidth={1.75} className="text-fg-muted" />
      )}
      {pageHasProblem(page) && (
        <span data-page-problem className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-danger" />
      )}
    </span>
  )
}

export function BrowserPageTabs({
  pages,
  activeId,
  busy,
  canAddPage,
  onSelect,
  onClose,
  onNewPage,
  onReload,
  onDuplicate,
  onCloseOthers,
}: {
  pages: BrowserPage[]
  activeId: string | null
  busy: boolean
  canAddPage: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNewPage: () => void
  onReload: (id: string) => void
  onDuplicate: (page: BrowserPage) => void
  onCloseOthers: (id: string) => void
}) {
  useI18n()
  const toast = useToast()
  const [menu, setMenu] = useState<{ page: BrowserPage; x: number; y: number; trigger: HTMLElement } | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  const actions = (p: BrowserPage): MenuAction[] => [
    { label: tr('projectTools.reload'), icon: RefreshCw, run: () => onReload(p.id) },
    {
      label: tr('projectTools.copyAddress'),
      icon: Copy,
      run: () =>
        void navigator.clipboard.writeText(p.remoteUrl ?? p.url).then(() => toast(tr('projectTools.addressCopied'))),
    },
    { label: tr('projectTools.duplicatePage'), icon: CopyPlus, disabled: !canAddPage, run: () => onDuplicate(p) },
    {
      label: tr('projectTools.closeOtherPages'),
      separator: true,
      disabled: pages.length < 2,
      run: () => onCloseOthers(p.id),
    },
    { label: tr('projectTools.closePage'), hint: 'Ctrl+W', run: () => onClose(p.id) },
  ]
  return (
    <div className="flex shrink-0 items-center gap-1">
      <div
        ref={strip}
        role="tablist"
        aria-label={tr('projectTools.pageTabsLabel')}
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
      >
        {pages.map(p => {
          const on = p.id === activeId
          return (
            <div
              key={p.id}
              data-browser-page-tab={p.id}
              className={cn(
                'group flex max-w-40 shrink-0 items-center gap-1.5 rounded-md border pl-2',
                on ? 'border-line bg-surface text-fg' : 'border-transparent text-fg-secondary hover:bg-hover',
              )}
              onAuxClick={e => {
                if (e.button === 1 && !busy) {
                  e.preventDefault()
                  onClose(p.id)
                }
              }}
              onContextMenu={e => {
                e.preventDefault()
                setMenu({ page: p, x: e.clientX, y: e.clientY, trigger: e.currentTarget })
              }}
            >
              <PageIcon page={p} />
              <button
                type="button"
                role="tab"
                aria-selected={on}
                title={`${p.title}\n${p.remoteUrl ?? p.url}`}
                disabled={busy}
                onClick={() => onSelect(p.id)}
                className="min-w-0 truncate py-1.5 text-meta"
              >
                {p.title}
              </button>
              <IconButton
                size={24}
                iconSize={12}
                icon={X}
                label={tr('projectTools.closePage')}
                disabled={busy}
                onClick={() => onClose(p.id)}
              />
            </div>
          )
        })}
      </div>
      <IconButton
        icon={Plus}
        label={tr('projectTools.newPage')}
        title={`${tr('projectTools.newPage')} (Ctrl+T)`}
        disabled={busy || !canAddPage}
        onClick={onNewPage}
      />
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={menu.page.title}
          actions={actions(menu.page)}
          onClose={() => {
            setMenu(null)
            menu.trigger.querySelector('button')?.focus({ preventScroll: true })
          }}
        />
      )}
    </div>
  )
}
