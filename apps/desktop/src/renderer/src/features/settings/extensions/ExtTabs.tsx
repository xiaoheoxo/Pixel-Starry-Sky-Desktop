import { useRef, type KeyboardEvent } from 'react'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import type { ExtTab } from '@/features/extstore/nav'

// 设置 › 扩展 顶上的三个页签（发现 | 已安装 N | 我的发布）：下划线页签，照示意图 mock-store.png。
// ui/Segmented 是填底色的分段，示意图里是文字加下划线，所以这里单独做一个小组件

export function ExtTabs({
  value,
  onChange,
  installedCount,
}: {
  value: ExtTab
  onChange(tab: ExtTab): void
  /** 已安装的个数；还没取到（0）时不显示 */
  installedCount: number
}) {
  const { t } = useI18n()
  const refs = useRef<Partial<Record<ExtTab, HTMLButtonElement | null>>>({})
  const tabs: Array<{ id: ExtTab; label: string }> = [
    { id: 'discover', label: t('extstore.tab.discover') },
    { id: 'installed', label: t('extstore.tab.installed') },
    { id: 'publish', label: t('extstore.tab.publish') },
  ]

  // 左右键在页签间移动（角色是 tablist，选中即切换）
  const onKeyDown = (e: KeyboardEvent): void => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const index = tabs.findIndex(x => x.id === value)
    const next = tabs[(index + step + tabs.length) % tabs.length].id
    onChange(next)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={t('extstore.tabs.label')}
      onKeyDown={onKeyDown}
      className="mb-4 flex gap-1 border-b border-line"
    >
      {tabs.map(({ id, label }) => {
        const selected = id === value
        return (
          <button
            key={id}
            ref={el => {
              refs.current[id] = el
            }}
            type="button"
            role="tab"
            id={`ext-tab-${id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            className={cn(
              'press no-drag relative -mb-px flex h-9 items-center gap-1.5 border-b-2 px-3 text-ui whitespace-nowrap',
              selected ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg',
            )}
          >
            {label}
            {id === 'installed' && installedCount > 0 && (
              <span className={cn('text-meta', selected ? 'text-fg-muted' : 'text-fg-faint')}>{installedCount}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
