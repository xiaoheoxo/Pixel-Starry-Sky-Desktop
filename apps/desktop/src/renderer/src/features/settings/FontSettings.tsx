import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Button, Segmented, type SegmentedOption } from '@/ui'
import { DEFAULT_FONTS, FONT_SCALES, resetFontPrefs, setFontPrefs, useFontPrefs } from '@/features/appearance/fonts'
import { FontPicker } from './FontPicker'
import { SettingRow } from './SettingRow'

const SCALE_OPTIONS: Array<SegmentedOption<string>> = FONT_SCALES.map(s => ({
  value: String(s),
  label: `${Math.round(s * 100)}%`,
}))

const SERIF_OPTIONS: Array<SegmentedOption<'on' | 'off'>> = [
  {
    value: 'off',
    get label() {
      return tr('settings.motion.off')
    },
  },
  {
    value: 'on',
    get label() {
      return tr('settings.FontSettings.on')
    },
  },
]

/** 外观 → 字体：界面字体、代码字体、字号、对话正文衬线体（docs/ui/settings.md §7） */
export function FontSettings() {
  useI18n()
  const f = useFontPrefs()
  const isDefault =
    f.sans === DEFAULT_FONTS.sans &&
    f.mono === DEFAULT_FONTS.mono &&
    f.scale === DEFAULT_FONTS.scale &&
    f.serifProse === DEFAULT_FONTS.serifProse

  return (
    <>
      <SettingRow
        title={tr('settings.FontSettings.interfaceFont')}
        description={tr('settings.FontSettings.usedInSidebarButtons')}
      >
        <FontPicker
          label={tr('settings.FontSettings.interfaceFont')}
          value={f.sans}
          onChange={sans => setFontPrefs({ sans })}
          placeholder={tr('settings.FontSettings.systemDefaultInterSegoe')}
          sample={tr('settings.FontSettings.pixelStarrySkyAa')}
        />
      </SettingRow>
      <SettingRow
        title={tr('settings.FontSettings.codeFont')}
        description={tr('settings.FontSettings.usedForCodePaths')}
      >
        <FontPicker
          label={tr('settings.FontSettings.codeFont')}
          value={f.mono}
          onChange={mono => setFontPrefs({ mono })}
          placeholder={tr('settings.FontSettings.systemDefaultJetbrainsMono')}
          sample="const a = 0x1f;"
        />
      </SettingRow>
      <SettingRow
        title={tr('settings.FontSettings.fontSize')}
        description={tr('settings.FontSettings.scaleTextOnlyButtons')}
        control={
          <Segmented
            label={tr('settings.FontSettings.fontSize')}
            options={SCALE_OPTIONS}
            value={String(f.scale)}
            onChange={v => setFontPrefs({ scale: Number(v) })}
          />
        }
      />
      <SettingRow
        title={tr('settings.FontSettings.serifConversationText')}
        description={tr('settings.FontSettings.useSerifFontsSongti')}
        control={
          <Segmented
            label={tr('settings.FontSettings.serifConversationText')}
            options={SERIF_OPTIONS}
            value={f.serifProse ? 'on' : 'off'}
            onChange={v => setFontPrefs({ serifProse: v === 'on' })}
          />
        }
      />
      {!isDefault && (
        <div className="border-t border-line-subtle px-4 py-2.5">
          <Button variant="ghost" className="-ml-2 h-7 px-2 text-meta" onClick={resetFontPrefs}>
            {tr('settings.FontSettings.resetFontSettings')}{' '}
          </Button>
        </div>
      )}
    </>
  )
}
