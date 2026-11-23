import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Check } from 'lucide-react'
import { cn } from '@/ui'
import { SettingRow } from './SettingRow'
import { ACCENTS, setAccent, useAccent, type Accent } from '@/features/appearance/accent'

const LABEL_KEYS = {
  theme: 'settings.AccentSettings.theme',
  blue: 'settings.AccentSettings.blue',
  violet: 'settings.AccentSettings.violet',
  teal: 'settings.AccentSettings.teal',
  amber: 'settings.AccentSettings.amber',
  rose: 'settings.AccentSettings.rose',
  graphite: 'settings.AccentSettings.graphite',
} as const satisfies Record<Accent, string>

/** 强调色：色块按当前浅色 / 深色显示这一套的实际颜色（tokens.css 的 [data-accent-swatch]） */
export function AccentSettings() {
  useI18n()
  const selected = useAccent()
  return (
    <SettingRow title={tr('settings.AccentSettings.accent')} description={tr('settings.AccentSettings.description')}>
      <div role="radiogroup" aria-label={tr('settings.AccentSettings.accent')} className="flex flex-wrap gap-2">
        {ACCENTS.map(value => {
          const label = tr(LABEL_KEYS[value])
          const active = selected === value
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={tr('settings.AccentSettings.chooseAccent', { p0: label })}
              data-accent-swatch={value}
              onClick={() => setAccent(value)}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-meta transition-colors',
                active
                  ? 'border-accent-line bg-accent-soft text-accent-fg'
                  : 'border-transparent bg-subtle/75 text-fg-muted hover:bg-hover hover:text-fg',
              )}
            >
              <span aria-hidden className="inline-flex size-4 items-center justify-center rounded-full bg-accent">
                {active && <Check size={10} strokeWidth={3} className="text-accent-on" />}
              </span>
              {label}
            </button>
          )
        })}
      </div>
    </SettingRow>
  )
}
