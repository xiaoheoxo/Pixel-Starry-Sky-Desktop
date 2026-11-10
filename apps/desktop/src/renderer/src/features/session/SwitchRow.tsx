import { useI18n } from '@/i18n/I18nProvider'
import type { ReactNode } from 'react'
import { Clock } from 'lucide-react'
import { Switch, cn } from '@/ui'

/** 开关一行：名字 + 说明 + 开关 */
export function SwitchRow({
  icon,
  label,
  desc,
  descClass,
  pending,
  checked = false,
  disabled,
  tone,
  onChange,
  control,
  tip,
}: {
  icon?: ReactNode
  label: string
  desc: string
  descClass?: string
  /** 改了但还没生效：标签旁的小字，说明前加时钟 */
  pending?: string
  checked?: boolean
  disabled?: boolean
  tone?: 'ultracode'
  onChange?: (on: boolean) => void
  /** 换掉默认的开关（Fast 行要能按住） */
  control?: ReactNode
  /** 名字后面的「?」（功能提示） */
  tip?: ReactNode
}) {
  useI18n()
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-ui text-fg">
          {icon}
          <span className={cn(tone === 'ultracode' && checked && 'effort-max ultracode-glow')}>{label}</span>
          {tip}
          {pending && (
            <span className="rounded-sm bg-subtle px-1.5 text-label leading-5 whitespace-nowrap text-fg-muted">
              {pending}
            </span>
          )}
        </span>
        {pending ? (
          <span className={cn('mt-0.5 flex items-start gap-1 text-meta text-fg-secondary', descClass)}>
            <Clock size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warn" />
            {desc}
          </span>
        ) : (
          <span className={cn('mt-0.5 block text-meta text-fg-muted', descClass)}>{desc}</span>
        )}
      </span>
      {control ?? (
        <Switch
          checked={checked}
          disabled={disabled}
          label={label}
          size="sm"
          tone={tone}
          onChange={v => onChange?.(v)}
        />
      )}
    </div>
  )
}
