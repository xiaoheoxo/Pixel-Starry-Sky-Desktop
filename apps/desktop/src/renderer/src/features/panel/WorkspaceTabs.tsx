import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, FileText, Maximize2, Minimize2, Plus, X } from 'lucide-react'
import { cn, CountBadge, IconButton } from '@/ui'
import { useInbox } from './inbox/useInbox'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { useI18n } from '@/i18n/I18nProvider'
import { dirtyFile, useFiles } from '@/features/files/store'
import { parseFileTab } from '@/features/panes/tree'
import { panelCloseTargets, TOOL_IDS, type PanelLayout, type ToolId } from './workspaceState'
import { GROUP_KEY, TOOLS, toolIcon } from './tools'
import { displayPath } from '@/features/files/extraFolders'
import { OverviewMenuButton } from './overview/OverviewMenuButton'
import { useOverviewAlert } from './overview/overviewAlert'
export function WorkspaceTabs({
  layout,
  maximized,
  busy,
  onSelect,
  onClose,
  onMoveFile,
}: {
  layout: PanelLayout
  maximized: boolean
  busy: boolean
  onSelect(id: string): void
  onClose(ids: string[]): void
  onMoveFile(id: string): void
}) {
  const { t, text } = useI18n(),
    files = useFiles(),
    strip = useRef<HTMLDivElement>(null)
  // 任务标签上显示待处理数量（docs/ui/tasks-inbox.md §2）
  const inboxCount = useInbox().length
  // 「概况」不是当前标签时，当前会话有要处理的就在标签上点一个点（D273）
  const overviewAlert = useOverviewAlert(layout.tabs.includes('overview') && layout.active !== 'overview')
  // id 为标签时是标签右键菜单；null 时是「+」菜单（all 为真时是「全部标签」溢出菜单）
  const [menu, setMenu] = useState<{
    id: string | null
    all?: boolean
    x: number
    y: number
    trigger: HTMLElement
  } | null>(null)
  /** 标签栏放不下（出现横向滚动）时显示「全部标签」按钮 */
  const [overflowing, setOverflowing] = useState(false)
  const label = (id: string): string =>
    files.tabs.find(f => f.id === id)?.name ??
    parseFileTab(id)?.path.split('/').pop() ??
    (TOOL_IDS.includes(id as ToolId) ? t(`workspace.${id as ToolId}`) : id)
  useLayoutEffect(() => {
    const list = strip.current
    const reveal = () => {
      if (list) setOverflowing(list.scrollWidth > list.clientWidth + 1)
      const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]')?.parentElement
      if (!list || !tab) return
      if (tab.offsetLeft < list.scrollLeft) list.scrollLeft = tab.offsetLeft
      else if (tab.offsetLeft + tab.offsetWidth > list.scrollLeft + list.clientWidth)
        list.scrollLeft = tab.offsetLeft + tab.offsetWidth - list.clientWidth
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    if (list) observer.observe(list)
    return () => observer.disconnect()
  }, [layout.active, layout.tabs.length])
  const actions: MenuAction[] = menu?.id
    ? [
        ...(parseFileTab(menu.id) ? [{ label: t('workspace.moveChat'), run: () => onMoveFile(menu.id!) }] : []),
        ...(['one', 'others', 'right', 'all'] as const).map(mode => ({
          label: t(mode === 'one' ? 'workspace.close' : `workspace.${mode}`),
          disabled: busy || !panelCloseTargets(layout, menu.id!, mode).length,
          run: () => onClose(panelCloseTargets(layout, menu.id!, mode)),
        })),
      ]
    : menu?.all
      ? // 溢出菜单：列出全部标签，当前标签打勾
        layout.tabs.map(id => ({
          label: label(id),
          icon: toolIcon(id) ?? FileText,
          checked: id === layout.active,
          run: () => onSelect(id),
        }))
      : // 「+」菜单：按分组列出工具，已打开的打勾（选中只是切换过去）
        TOOLS.map((tool, i) => ({
          label: t(`workspace.${tool.id}`),
          icon: tool.icon,
          checked: layout.tabs.includes(tool.id),
          section: TOOLS[i - 1]?.group !== tool.group ? t(GROUP_KEY[tool.group]) : undefined,
          run: () => onSelect(tool.id),
        }))
  return (
    <div data-panel-tabs className="flex h-8 min-w-0 shrink-0 items-stretch">
      <div
        ref={strip}
        role="tablist"
        aria-label={t('workspace.title')}
        className="relative flex min-w-0 flex-1 items-end gap-2 overflow-x-auto pt-1 [scrollbar-width:none]"
      >
        {layout.tabs.map(id => {
          const Icon = toolIcon(id) ?? FileText,
            file = files.tabs.find(f => f.id === id)
          return (
            <div
              key={id}
              data-panel-tab={id}
              data-active={id === layout.active || undefined}
              className={cn(
                // 轨道里的标签（样式在 panes.css）：当前标签 28 高连到内容上，别的 24 高、离底 4
                'group mb-1 flex h-6 max-w-[min(32rem,80vw)] shrink-0 items-center gap-1 rounded-md pr-1',
                id === layout.active ? 'text-fg' : 'text-fg-muted hover:bg-hover',
              )}
              onContextMenu={e => {
                e.preventDefault()
                setMenu({ id, x: e.clientX, y: e.clientY, trigger: e.currentTarget })
              }}
            >
              <button
                type="button"
                data-workspace-tab={id}
                role="tab"
                tabIndex={id === layout.active ? 0 : -1}
                aria-selected={id === layout.active}
                title={
                  file ? `${file.project} / ${displayPath(file.ref, file.path)}` : (parseFileTab(id)?.path ?? label(id))
                }
                className="flex h-full min-w-0 items-center gap-1.5 rounded-md px-2 text-meta"
                onClick={() => onSelect(id)}
                onKeyDown={e => {
                  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                    e.preventDefault()
                    const r = e.currentTarget.getBoundingClientRect()
                    setMenu({ id, x: r.left, y: r.bottom, trigger: e.currentTarget })
                  }
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault()
                    const next =
                      layout.tabs[
                        (layout.tabs.indexOf(id) + (e.key === 'ArrowRight' ? 1 : -1) + layout.tabs.length) %
                          layout.tabs.length
                      ]
                    onSelect(next)
                    requestAnimationFrame(() =>
                      strip.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(),
                    )
                  }
                }}
              >
                <Icon size={14} className="shrink-0" />
                <span className="truncate">{label(id)}</span>
                {id === 'tasks' && inboxCount > 0 && <CountBadge count={inboxCount} className="shrink-0" />}
                {id === 'overview' && overviewAlert && (
                  <span
                    role="img"
                    aria-label={t('overview.alert')}
                    className="size-1.5 shrink-0 rounded-full bg-warn"
                  />
                )}
                {file && dirtyFile(file) && (
                  <span aria-label={text('未保存')} className="size-1.5 shrink-0 rounded-full bg-fg-muted" />
                )}
              </button>
              <button
                type="button"
                disabled={busy}
                aria-label={`${t('workspace.close')}: ${label(id)}`}
                className="flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-faint hover:bg-hover hover:text-fg"
                onClick={() => onClose([id])}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
      {overflowing && (
        <IconButton
          icon={ChevronDown}
          label={t('workspace.allTabs')}
          size={32}
          iconSize={15}
          aria-haspopup="menu"
          aria-expanded={menu?.all === true}
          onClick={e => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu(menu ? null : { id: null, all: true, x: r.left, y: r.bottom, trigger: e.currentTarget })
          }}
        />
      )}
      <IconButton
        icon={Plus}
        label={t('workspace.add')}
        size={32}
        iconSize={15}
        aria-haspopup="menu"
        aria-expanded={menu?.id === null && !menu.all}
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu(menu ? null : { id: null, x: r.left, y: r.bottom, trigger: e.currentTarget })
        }}
      />
      {layout.active === 'overview' && <OverviewMenuButton />}
      <IconButton
        icon={maximized ? Minimize2 : Maximize2}
        label={t(maximized ? 'workspace.restore' : 'workspace.maximize')}
        size={32}
        iconSize={15}
        onClick={() => window.dispatchEvent(new Event('pixelsky:panel-maximize'))}
      />
      <IconButton
        icon={X}
        label={t('workspace.collapse')}
        size={32}
        iconSize={15}
        onClick={() => window.dispatchEvent(new Event('pixelsky:close-right-workspace'))}
      />
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={t('workspace.title')}
          actions={actions}
          onClose={() => {
            setMenu(null)
            menu.trigger.focus({ preventScroll: true })
          }}
        />
      )}
    </div>
  )
}
