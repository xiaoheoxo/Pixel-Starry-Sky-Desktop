import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Check } from 'lucide-react'
import { cn } from '@/ui'
import { SettingRow } from './SettingRow'
import { PALETTES, setPalette, usePalette } from '@/features/appearance/palette'
import { setActiveTheme, useCustomThemes } from '@/features/appearance/customTheme'
import { CustomThemeEditor, MyThemes } from './CustomThemeSettings'
import { PalettePreview, paletteName } from './PalettePreview'

/** 配色主题：每张卡片按当前浅色 / 深色画出这套配色的缩略界面（tokens.css 的 [data-palette-preview]）。自建主题在内置上面 */
export function PaletteSettings() {
  useI18n()
  const selected = usePalette()
  const { themes, activeId } = useCustomThemes()
  return (
    <SettingRow title={tr('settings.PaletteSettings.palette')} description={tr('settings.PaletteSettings.description')}>
      <MyThemes />
      <CustomThemeEditor />
      <div className="mt-4 mb-2 text-meta text-fg-muted">{tr('customTheme.builtin')}</div>
      <div
        role="radiogroup"
        aria-label={tr('settings.PaletteSettings.palette')}
        className="grid grid-cols-4 gap-3 @max-[720px]:grid-cols-3 @max-[520px]:grid-cols-2"
      >
        {PALETTES.map(value => {
          const name = paletteName(value)
          // id 指向已经没有的主题（被另一台电脑删了）时界面是基础配色，也要有选中项
          const active = !themes.some(t => t.id === activeId) && selected === value
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={tr('settings.PaletteSettings.choosePalette', { p0: name })}
              onClick={() => {
                setActiveTheme(null)
                setPalette(value)
              }}
              className={cn(
                'rounded-lg border p-1.5 text-left hover:border-line-strong',
                active ? 'border-accent-line bg-accent-soft/40' : 'border-line-card',
              )}
            >
              <PalettePreview value={value} />
              <div className="mt-1.5 flex items-center justify-between gap-1 px-0.5 text-meta text-fg">
                <span className="truncate">{name}</span>
                {active && <Check size={13} className="shrink-0 text-accent-fg" />}
              </div>
            </button>
          )
        })}
      </div>
    </SettingRow>
  )
}
