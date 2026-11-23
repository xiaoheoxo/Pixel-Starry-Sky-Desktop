import { createContext, useContext, type ReactNode } from 'react'
import { cn, Switch } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'

const SettingsPaneContext = createContext(false)
const SettingGroupContext = createContext(false)

/** 包裹在 SettingsContent 右栏外，使吸顶页头已经展示过标题的页面不重复渲染大标题，单测独立挂载各 Section 时仍可见 */
export function SettingsPaneProvider({ children }: { children: ReactNode }) {
  return <SettingsPaneContext.Provider value={true}>{children}</SettingsPaneContext.Provider>
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const { text } = useI18n()
  const inPane = useContext(SettingsPaneContext)
  return (
    <h3
      data-section-title={inPane ? '' : undefined}
      className={inPane ? 'sr-only' : 'mb-4 text-section font-semibold text-fg'}
    >
      {typeof children === 'string' ? text(children) : children}
    </h3>
  )
}

/** 设置分组小标题（用于独立卡片列表上方，与 SettingGroup 标题视觉一致） */
export function GroupTitle({ children }: { children: ReactNode }) {
  const { text } = useI18n()
  return (
    <h4
      data-setting-title={typeof children === 'string' ? children : undefined}
      className="mt-6 mb-2 px-0.5 text-label font-semibold text-fg-muted [h3+&]:mt-0"
    >
      {typeof children === 'string' ? text(children) : children}
    </h4>
  )
}

/** 圆角分组卡片容器（docs/ui/settings-layout-plan.md §2.4）：小标题在卡片上方，内部按行细线分隔 */
export function SettingGroup({
  title,
  description,
  action,
  anchorId,
  className,
  children,
}: {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  anchorId?: string
  className?: string
  children: ReactNode
}) {
  const { text } = useI18n()
  const rawTitle = typeof title === 'string' ? title : undefined
  return (
    <div data-appearance-group={anchorId} className={cn('mb-5 last:mb-0 scroll-mt-4', className)}>
      {(title || description || action) && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-0.5">
          <div className="min-w-0">
            {title && (
              <h4 data-setting-title={rawTitle} className="text-label font-semibold text-fg-muted">
                {typeof title === 'string' ? text(title) : title}
              </h4>
            )}
            {description && (
              <p className="mt-0.5 text-meta text-fg-muted">
                {typeof description === 'string' ? text(description) : description}
              </p>
            )}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      <SettingGroupContext.Provider value={true}>
        <div className="overflow-hidden rounded-xl bg-surface shadow-sm">{children}</div>
      </SettingGroupContext.Provider>
    </div>
  )
}

/** 一行设置：标题、说明、控件、可选的展开内容与提示 */
export function SettingRow({
  title,
  description,
  hint,
  hintTone = 'muted',
  control,
  children,
}: {
  title: string
  description: string
  hint?: string
  hintTone?: 'muted' | 'danger'
  control?: ReactNode
  children?: ReactNode
}) {
  const { text } = useI18n()
  const inGroup = useContext(SettingGroupContext)
  const translatedTitle = text(title)
  const translatedDesc = description ? text(description) : ''
  const hasChildren = children !== undefined && children !== null && children !== false
  return (
    <div
      data-setting-title={title}
      className={
        inGroup
          ? 'relative px-5 py-3.5 first:[&>.setting-row-divider]:hidden'
          : 'rounded-md border-t border-line-subtle/60 py-4 first-of-type:border-t-0 first-of-type:pt-0 [h4+&]:first-of-type:border-t [h4+&]:first-of-type:pt-4'
      }
    >
      {inGroup && (
        <div
          aria-hidden
          className="setting-row-divider pointer-events-none absolute top-0 right-5 left-5 h-px bg-line-subtle/55"
        />
      )}
      <div className={control ? 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2' : undefined}>
        <div className={control ? 'min-w-[12rem] flex-1' : 'min-w-0'}>
          <div className="text-ui font-medium text-fg">{translatedTitle}</div>
          {translatedDesc && <p className="mt-0.5 text-meta text-fg-muted">{translatedDesc}</p>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {hasChildren && <div className="mt-3">{children}</div>}
      {hint && (
        <p className={cn('mt-2 text-meta', hintTone === 'danger' ? 'text-danger' : 'text-fg-faint')}>{text(hint)}</p>
      )}
    </div>
  )
}

/** 设置页的开关（ui/Switch，md） */
export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return <Switch checked={checked} label={label} onChange={onChange} />
}
