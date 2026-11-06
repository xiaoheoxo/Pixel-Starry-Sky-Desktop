import { useState } from 'react'
import { extText, type ExtLocale, type ExtPackInfo } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Check, X } from 'lucide-react'
import { cn, useToast } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { usePackState } from '@/features/extpacks/store'
import { packTitle } from './extensions/model'
import { SettingRow } from './SettingRow'
import { packOfTheme, uninstalledPresets } from './themePacks'
import { setActiveTheme, useCustomThemes } from '@/features/appearance/customTheme'
import { themeVars } from '@/features/appearance/customThemeCore'
import { DEFAULT_PALETTE } from '@/features/appearance/palettes'
import { useTheme } from '@/features/appearance/ThemeProvider'
import { CustomThemeEditor, MyThemes } from './CustomThemeSettings'
import { PalettePreview, paletteName } from './PalettePreview'

const CARD = 'rounded-lg border p-1.5 text-left hover:border-line-strong'
const cardState = (active: boolean): string => (active ? 'border-accent-line bg-accent-soft/40' : 'border-line-card')

function CardName({ name, active }: { name: string; active: boolean }) {
  return (
    <div className="mt-1.5 flex items-center justify-between gap-1 px-0.5 text-meta text-fg">
      <span className="truncate">{name}</span>
      {active && <Check size={13} className="shrink-0 text-accent-fg" />}
    </div>
  )
}

/** 配色主题：暖灰是应用自带的，其余都来自扩展（预装的和商店的），鼠标移上去能卸载。卡片按当前浅色 / 深色画缩略界面。自建主题在上面 */
export function PaletteSettings() {
  const { locale } = useI18n()
  const { resolved } = useTheme()
  const { themes, extThemes, activeId } = useCustomThemes()
  // id 指向已经没有的主题（扩展停用了、被另一台电脑删了）时界面是暖灰，也要有选中项
  const chosen = themes.some(t => t.id === activeId) || extThemes.some(t => t.id === activeId)
  const defaultName = paletteName(DEFAULT_PALETTE)
  const packs = usePackState()
  const toast = useToast()
  const bridge = window.pixelsky?.extpacks
  const [confirm, setConfirm] = useState<ExtPackInfo | null>(null)
  const failed = (): void => toast(tr('customTheme.uninstallFailed'))
  /** 预装的文件在安装目录里：停用，能撤销。商店和文件夹的真的删掉，撤销不了，要先确认 */
  const uninstall = (pack: ExtPackInfo, themeId: string, name: string): void => {
    if (pack.source !== 'builtin') return setConfirm(pack)
    bridge?.setEnabled(pack.key, false).then(() => {
      toast(tr(themeId === activeId ? 'customTheme.uninstalledFell' : 'customTheme.uninstalled', { name }), {
        action: {
          label: tr('customTheme.undo'),
          run: () => void bridge?.setEnabled(pack.key, true).catch(failed),
        },
      })
    }, failed)
  }
  const removed = uninstalledPresets(packs)
  return (
    <SettingRow title={tr('settings.PaletteSettings.palette')} description={tr('settings.PaletteSettings.description')}>
      <MyThemes />
      <CustomThemeEditor />
      <div className="mt-4 mb-2 text-meta text-fg-muted">{tr('customTheme.themes')}</div>
      <div
        role="radiogroup"
        aria-label={tr('settings.PaletteSettings.palette')}
        className="grid grid-cols-4 gap-3 @max-[720px]:grid-cols-3 @max-[520px]:grid-cols-2"
      >
        <button
          type="button"
          role="radio"
          aria-checked={!chosen}
          aria-label={tr('settings.PaletteSettings.choosePalette', { p0: defaultName })}
          onClick={() => setActiveTheme(null)}
          className={cn(CARD, cardState(!chosen))}
        >
          <PalettePreview value={DEFAULT_PALETTE} />
          <CardName name={defaultName} active={!chosen} />
        </button>
        {extThemes.map(theme => {
          const name = extText(theme.label, locale as ExtLocale)
          const active = theme.id === activeId
          const pack = packOfTheme(packs, theme.id)
          return (
            <div key={theme.id} className="group/theme relative">
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={tr('settings.PaletteSettings.choosePalette', { p0: name })}
                onClick={() => setActiveTheme(theme.id)}
                className={cn(CARD, 'size-full', cardState(active))}
              >
                <PalettePreview vars={themeVars(theme, resolved)} glass={!!theme.glass} />
                <CardName name={name} active={active} />
              </button>
              {/* 启动缓存读到、扩展状态还没回来时不知道属于哪个扩展，先不显示 */}
              {pack && (
                <button
                  type="button"
                  data-theme-uninstall={theme.id}
                  aria-label={tr('customTheme.uninstall', { name })}
                  title={tr('customTheme.uninstall', { name })}
                  onClick={() => uninstall(pack, theme.id, name)}
                  className="absolute top-2.5 right-2.5 grid size-5 place-items-center rounded-full border border-line bg-surface text-fg-secondary opacity-0 group-hover/theme:opacity-100 hover:text-fg focus-visible:opacity-100"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
      {removed.length > 0 && (
        <div data-themes-removed className="mt-3 flex flex-wrap items-center gap-2 text-meta text-fg-muted">
          <span>{tr('customTheme.uninstalledList', { n: removed.length })}</span>
          {removed.map(pack => (
            <span
              key={pack.key}
              className="inline-flex items-center gap-1.5 rounded-md bg-subtle px-2 py-0.5 text-fg-secondary"
            >
              {packTitle(pack, locale as ExtLocale)}
              <button
                type="button"
                onClick={() => void bridge?.setEnabled(pack.key, true).catch(failed)}
                className="text-accent-fg hover:underline"
              >
                {tr('customTheme.restore')}
              </button>
            </span>
          ))}
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={tr('extstore.installed.uninstallTitle', { name: packTitle(confirm, locale as ExtLocale) })}
          description={tr('extstore.installed.uninstallConfirm')}
          confirmLabel={tr('extstore.installed.uninstallYes')}
          cancelLabel={tr('extstore.installed.uninstallNo')}
          busy={false}
          danger
          onConfirm={() => {
            const target = confirm
            setConfirm(null)
            bridge?.remove(target.key).catch(failed)
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </SettingRow>
  )
}
