import { useRef, useState, type ReactNode } from 'react'
import { Columns2, Ellipsis, GitCompare, Sparkles, X } from 'lucide-react'
import { FileIcon } from '@/features/files/icons/FileIcon'
import { IconButton, SEGMENT_TRACK, cn, segmentItem } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { useTabStripScroll } from '../../panes/tabScroll'
import { TabStripArrows } from '../../panes/TabStripArrows'
import '../../panes/panes.css'
import type { EditorViewMode } from '../types'
import type { ViewAvailability } from './viewModel'

export interface TabItem {
  id: string
  name: string
  /** 完整路径，给悬停提示用 */
  title: string
  dirty: boolean
  ai: boolean
  /** Git 对比标签的小标记（更改 / 暂存 / 提交短哈希）；有它就是对比标签 */
  tag?: string
}

const hint = (avail: ViewAvailability, mode: EditorViewMode): string | undefined => {
  if (mode === 'code' || mode === 'preview') return undefined
  if (avail.reason === 'noHead') return tr('coding.editor.view.noHead')
  if (avail.reason === 'binary') return tr('coding.editor.view.binary')
  if (avail.reason === 'noChange') return tr('coding.editor.view.noChange')
  if (mode === 'split' && avail.narrow) return tr('coding.editor.view.narrow')
  return undefined
}

/** 预览（Markdown）| 代码 | 变更 | 并排 */
function ViewSwitch({
  mode,
  avail,
  onChange,
}: {
  mode: EditorViewMode
  avail: ViewAvailability
  onChange(mode: EditorViewMode): void
}) {
  useI18n()
  const items: { value: EditorViewMode; label: string; enabled: boolean }[] = [
    ...(avail.preview ? [{ value: 'preview' as const, label: tr('coding.editor.view.preview'), enabled: true }] : []),
    { value: 'code', label: tr('coding.editor.view.code'), enabled: true },
    { value: 'diff', label: tr('coding.editor.view.diff'), enabled: avail.diff },
    { value: 'split', label: tr('coding.editor.view.split'), enabled: avail.split },
  ]
  return (
    <div role="group" aria-label={tr('coding.editor.view')} className={SEGMENT_TRACK} data-editor-view-switch>
      {items.map(item => (
        <button
          key={item.value}
          type="button"
          aria-pressed={mode === item.value}
          disabled={!item.enabled}
          title={item.enabled ? undefined : hint(avail, item.value)}
          className={cn(
            segmentItem(mode === item.value),
            'px-2 text-meta disabled:opacity-40 disabled:hover:bg-transparent',
          )}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** 中栏顶部（分屏时每组一条）：文件标签、视图切换、向右分屏、更多菜单 */
export function CodeTabs({
  tabs,
  active,
  focused,
  mode,
  avail,
  split,
  onActivate,
  onClose,
  onMode,
  onSplit,
  menu,
}: {
  tabs: TabItem[]
  active: string | null
  /** 是当前那组：当前标签顶上画主色线（只有一组时总是 true） */
  focused: boolean
  mode: EditorViewMode
  avail: ViewAvailability | null
  /** 「向右分屏」按钮；已经分屏时不传（最多两组），hint 是置灰的原因 */
  split?: { disabled: boolean; hint?: string }
  onActivate(id: string): void
  onClose(id: string): void
  onMode(mode: EditorViewMode): void
  onSplit(): void
  /** 「⋯」菜单里的动作；没有标签时不显示按钮 */
  menu: MenuAction[]
}): ReactNode {
  useI18n()
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  const list = useRef<HTMLDivElement>(null)
  // 滚轮横向滚、空白处拖动平移、当前标签滚进可视区、两头淡出和翻页箭头（与会话标签栏共用，tabScroll.ts）
  useTabStripScroll(
    list,
    active,
    tabs.map(tab => tab.id),
  )
  return (
    <div data-coding-tabs className="flex h-10 shrink-0 items-center gap-1 border-b border-line-layout bg-sidebar pr-2">
      <div className="tab-strip-wrap h-full">
        <div
          ref={list}
          role="tablist"
          aria-label={tr('coding.editor.tabs')}
          className="code-tab-strip flex h-full min-w-0 flex-1 items-end overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map(tab => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === active}
              data-code-tab={tab.id}
              title={tab.title}
              tabIndex={0}
              className={cn(
                'group/tab press relative flex h-full max-w-48 min-w-0 shrink-0 cursor-default items-center gap-1.5 border-r border-line-layout pr-1 pl-3 text-ui select-none',
                tab.id === active
                  ? cn(
                      'bg-app text-fg',
                      focused && 'after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-accent',
                    )
                  : 'text-fg-muted hover:bg-hover hover:text-fg',
              )}
              onMouseDown={e => {
                if (e.button === 1) e.preventDefault()
              }}
              onClick={() => onActivate(tab.id)}
              onAuxClick={e => {
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(tab.id)
                }
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onActivate(tab.id)
                }
              }}
            >
              {tab.tag ? (
                <GitCompare size={13} strokeWidth={1.5} aria-hidden className="shrink-0 text-fg-muted" />
              ) : (
                <FileIcon name={tab.name} kind="file" size={14} />
              )}
              <span className="truncate">{tab.name}</span>
              {tab.tag && (
                <span data-git-diff-tag className="shrink-0 rounded bg-subtle px-1 text-label text-fg-muted">
                  {tab.tag}
                </span>
              )}
              {tab.ai && (
                <Sparkles
                  size={12}
                  strokeWidth={1.5}
                  className="shrink-0 text-accent"
                  aria-label={tr('coding.editor.tab.ai')}
                />
              )}
              <button
                type="button"
                tabIndex={-1}
                aria-label={tr('coding.editor.tab.close', { name: tab.name })}
                className="press relative flex size-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-selected hover:text-fg"
                onClick={e => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
              >
                {tab.dirty && (
                  <span
                    aria-label={tr('coding.editor.tab.unsaved')}
                    className="absolute size-1.5 rounded-full bg-fg-muted group-hover/tab:hidden"
                  />
                )}
                <X
                  size={14}
                  strokeWidth={1.5}
                  className={cn(
                    'shrink-0',
                    tab.dirty ? 'hidden group-hover/tab:block' : 'opacity-0 group-hover/tab:opacity-100',
                  )}
                />
              </button>
            </div>
          ))}
        </div>
        <TabStripArrows strip={list} />
      </div>
      {avail && <ViewSwitch mode={mode} avail={avail} onChange={onMode} />}
      {split && (
        // 置灰的按钮不接鼠标事件（pointer-events-none），悬停提示挂在外面这层
        <span title={split.disabled ? split.hint : undefined} className="flex shrink-0">
          <IconButton
            icon={Columns2}
            size={28}
            iconSize={15}
            label={tr('coding.editor.splitRight')}
            disabled={split.disabled}
            onClick={onSplit}
          />
        </span>
      )}
      {tabs.length > 0 && (
        <IconButton
          icon={Ellipsis}
          size={28}
          iconSize={15}
          label={tr('coding.editor.more')}
          aria-haspopup="menu"
          aria-expanded={open !== null}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect()
            setOpen({ x: rect.right - 192, y: rect.bottom + 4 })
          }}
        />
      )}
      {open && (
        <ActionMenu
          x={open.x}
          y={open.y}
          label={tr('coding.editor.more')}
          actions={menu}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}
