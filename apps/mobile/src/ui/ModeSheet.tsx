// 改模式的面板（docs/mobile-remote.md §21.5）：几组单选（权限模式、模型、强度）加几个开关。
// 只管画，选项和规则由调用方算好传进来（data/mode.ts）；窄屏从底部弹出，宽屏是右侧面板（Sheet）。
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { Sheet } from './sheet'
import { Spinner, cn } from './index'

export interface ModeChoice {
  value: string
  label: string
  hint?: string
  disabled?: boolean
}

export interface ModeGroup {
  key: string
  title: string
  options: ModeChoice[]
  value: string
  onPick(value: string): void
}

export interface ModeToggle {
  key: string
  label: string
  hint?: string
  value: boolean
  onChange(value: boolean): void
}

export function ModeSheet({
  title,
  groups,
  toggles = [],
  note,
  error,
  busy,
  readOnly,
  onClose,
}: {
  title: ReactNode
  groups: ModeGroup[]
  toggles?: ModeToggle[]
  /** 底部一行说明（「下一轮生效」「会影响费用」） */
  note?: string
  error?: string | null
  /** 正在改：选项先不让点 */
  busy?: boolean
  /** 只看档的手机：只显示当前值 */
  readOnly?: boolean
  onClose(): void
}) {
  const locked = busy || readOnly
  return (
    <Sheet
      title={
        <span className="inline-flex items-center gap-2">
          {title}
          {busy && <Spinner size={14} />}
        </span>
      }
      onClose={onClose}
      footer={
        (note || error) && (
          <div className="flex flex-col gap-1 px-4 py-3 text-label">
            {error && <span className="text-danger">{error}</span>}
            {note && <span className="text-fg-muted">{note}</span>}
          </div>
        )
      }
    >
      <div className="flex flex-col gap-5 py-3">
        {groups.map(g => (
          <section key={g.key} className="flex flex-col">
            <h3 className="px-4 pb-1.5 text-meta font-medium text-fg-muted">{g.title}</h3>
            <div className="mx-3 overflow-hidden rounded-xl border border-line-subtle bg-surface">
              {g.options.map((o, i) => {
                const selected = o.value === g.value
                return (
                  <button
                    key={o.value || '_default'}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={o.disabled || (locked && !selected)}
                    onClick={() => !selected && g.onPick(o.value)}
                    className={cn(
                      'flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left active:bg-hover disabled:active:bg-transparent',
                      i > 0 && 'border-t border-line-subtle',
                      (o.disabled || (locked && !selected)) && 'opacity-50',
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn('truncate text-ui', selected && 'font-medium')}>{o.label}</span>
                      {o.hint && <span className="line-clamp-2 text-label text-fg-muted">{o.hint}</span>}
                    </span>
                    {selected && <Check size={18} className="shrink-0 text-accent-fg" />}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
        {toggles.length > 0 && (
          <div className="mx-3 overflow-hidden rounded-xl border border-line-subtle bg-surface">
            {toggles.map((t, i) => (
              <label
                key={t.key}
                className={cn(
                  'flex min-h-12 items-center gap-3 px-4 py-2',
                  i > 0 && 'border-t border-line-subtle',
                  locked && 'opacity-50',
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-ui">{t.label}</span>
                  {t.hint && <span className="text-label text-fg-muted">{t.hint}</span>}
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={t.value}
                  disabled={locked}
                  onChange={e => t.onChange(e.target.checked)}
                  className="size-5 shrink-0 accent-[var(--color-primary)]"
                />
              </label>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  )
}
