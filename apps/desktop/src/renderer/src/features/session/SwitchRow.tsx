import { useI18n } from '@/i18n/I18nProvider'
import type { ReactNode } from 'react'
import { Switch } from '@/ui'

/** 开关一行：名字 + 说明 + 开关 */
export function SwitchRow({
  icon,
  label,
  desc,
  checked,
  onChange,
}: {
  icon?: ReactNode
  label: string
  desc: string
  checked: boolean
  onChange: (on: boolean) => void
}) {
  useI18n()
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-ui text-fg">
          {icon}
          <span>{label}</span>
        </span>
        <span className="mt-0.5 block text-meta text-fg-muted">{desc}</span>
      </span>
      <Switch checked={checked} label={label} size="sm" onChange={onChange} />
    </div>
  )
}
