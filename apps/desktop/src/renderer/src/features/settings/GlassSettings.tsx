import type { JSX } from 'react'
import { UI_THEME_GLASS_RANGES } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Button, Segmented, Select, Slider } from '@/ui'
import { useTheme } from '@/features/appearance/ThemeProvider'
import { useCustomThemes } from '@/features/appearance/customTheme'
import {
  resetGlass,
  selectGlassPreset,
  setGlassPrefs,
  useGlassMaterials,
  useGlassPrefs,
  useGlassResolved,
} from '@/features/appearance/glass'
import { useWallpaper } from '@/features/appearance/wallpaper'
import {
  effectiveMaterial,
  effectiveSource,
  GLASS_CODE_RANGE,
  GLASS_MENU_RANGE,
  GLASS_PRESET_IDS,
  GLASS_PRESETS,
  GLASS_RADIUS_RANGE,
  GLASS_ZONE_RANGE,
  presetOfTheme,
  type GlassPrefs,
  type GlassPresetId,
  type GlassReadable,
  type GlassSource,
} from '@/features/appearance/glassCore'
import { SettingRow, Toggle } from './SettingRow'

type Key = Parameters<typeof tr>[0]

function RangeRow({
  id,
  range,
  value,
  unit,
  step,
  signed,
  onChange,
}: {
  id: string
  range: readonly [number, number]
  value: number
  unit: string
  step?: number
  signed?: boolean
  onChange(v: number): void
}): JSX.Element {
  const title = tr(id as Key)
  return (
    <SettingRow title={title} description={tr(`${id}.desc` as Key)}>
      <Slider
        label={title}
        min={range[0]}
        max={range[1]}
        step={step}
        value={value}
        onChange={onChange}
        display={`${signed && value > 0 ? '+' : ''}${value}${unit}`}
      />
    </SettingRow>
  )
}

function SwitchRow({ id, value, onChange }: { id: string; value: boolean; onChange(v: boolean): void }): JSX.Element {
  const title = tr(id as Key)
  return (
    <SettingRow
      title={title}
      description={tr(`${id}.desc` as Key)}
      control={<Toggle label={title} checked={value} onChange={onChange} />}
    />
  )
}

/** 选中带玻璃的主题时才有的调整项（docs/ui/ui-themes-extension.md §11） */
export function GlassSettings(): JSX.Element | null {
  useI18n()
  const { extThemes, activeId } = useCustomThemes()
  const themeGlass = extThemes.find(t => t.id === activeId)?.glass ?? null
  const prefs = useGlassPrefs()
  const materials = useGlassMaterials()
  const resolved = useGlassResolved()
  const wallpaper = useWallpaper()
  const { resolved: theme } = useTheme()
  if (!themeGlass) return null

  const set = (patch: Partial<GlassPrefs>): void => setGlassPrefs(patch)
  /** 预设管的那几项：改了就算自定义 */
  const tune = (patch: Partial<GlassPrefs>): void => setGlassPrefs(patch, { custom: true })
  const source = effectiveSource(prefs, materials)
  const desk = source === 'desk'
  const material = effectiveMaterial(prefs, materials)
  const zone = (key: keyof GlassPrefs['zones'], labelKey: string): JSX.Element => (
    <Slider
      key={key}
      label={tr(labelKey as Key)}
      min={GLASS_ZONE_RANGE[0]}
      max={GLASS_ZONE_RANGE[1]}
      value={prefs.zones[key]}
      onChange={v => set({ zones: { ...prefs.zones, [key]: v } })}
      display={`${prefs.zones[key] > 0 ? '+' : ''}${prefs.zones[key]}%`}
    />
  )
  const percent = (n: number): number => 100 - n

  return (
    <div data-glass-settings className="my-3 rounded-lg border border-line-card px-4">
      <div className="pt-3 pb-1">
        <div className="text-body font-medium text-fg">{tr('glass.title')}</div>
        {resolved && (
          <div className="mt-0.5 flex flex-col gap-0.5 text-meta text-fg-muted">
            {resolved.solid ? (
              <span>{tr('glass.status.solid', { p0: tr(`glass.why.${resolved.solid}` as Key) })}</span>
            ) : (
              <span>
                {tr('glass.status.alpha', {
                  p0: percent(resolved.alpha.side),
                  p1: percent(resolved.alpha.main),
                  p2: percent(resolved.alpha.right),
                })}
              </span>
            )}
            {resolved.raised.length > 0 && (
              <span>
                {tr('glass.status.raised', {
                  p0: resolved.raised.map(k => tr(`glass.zone.${k}` as Key)).join(' · '),
                })}
              </span>
            )}
            {resolved.contrast && (
              <span>
                {tr('glass.status.contrast', {
                  p0: resolved.contrast.weak.toFixed(1),
                  p1: resolved.contrast.body.toFixed(1),
                })}
              </span>
            )}
          </div>
        )}
      </div>

      <SettingRow
        title={tr('glass.source')}
        description={
          materials.length === 0
            ? tr('glass.source.unsupported')
            : desk
              ? tr('glass.source.deskDesc')
              : tr('glass.source.wallDesc')
        }
        hint={!desk && !wallpaper.name ? tr('glass.source.needWallpaper') : undefined}
      >
        <Segmented<GlassSource>
          label={tr('glass.source')}
          disabled={materials.length === 0}
          options={[
            { value: 'desk', label: tr('glass.source.desk') },
            { value: 'wall', label: tr('glass.source.wall') },
          ]}
          value={source}
          onChange={v => set({ source: v })}
        />
      </SettingRow>

      {desk && material && (
        <SettingRow title={tr('glass.material')} description={tr('glass.material.desc')}>
          <Select
            label={tr('glass.material')}
            value={material}
            options={materials.map(m => ({ value: m, label: tr(`glass.material.${m}` as Key) }))}
            onChange={v => set({ material: v })}
            fitContent
          />
        </SettingRow>
      )}

      <SettingRow title={tr('glass.preset')} description={tr('glass.preset.desc')}>
        <Segmented
          label={tr('glass.preset')}
          options={[
            ...(presetOfTheme(themeGlass) === 'theme' ? [{ value: 'theme', label: tr('glass.preset.theme') }] : []),
            ...GLASS_PRESET_IDS.map(id => ({ value: id, label: tr(`glass.preset.${id}` as Key) })),
            { value: 'custom', label: tr('glass.preset.custom') },
          ]}
          value={prefs.preset}
          onChange={id => {
            if (id === 'theme') selectGlassPreset(id, themeGlass)
            else if (id !== 'custom') selectGlassPreset(id, GLASS_PRESETS[id as GlassPresetId])
          }}
        />
      </SettingRow>

      <RangeRow
        id="glass.transparency"
        range={UI_THEME_GLASS_RANGES.transparency}
        value={prefs.transparency[theme]}
        unit="%"
        onChange={v => tune({ transparency: { ...prefs.transparency, [theme]: v } })}
      />
      {!desk && (
        <>
          <RangeRow
            id="glass.blur"
            range={UI_THEME_GLASS_RANGES.blur}
            step={2}
            value={prefs.blur}
            unit="px"
            onChange={blur => tune({ blur })}
          />
          <RangeRow
            id="glass.saturate"
            range={UI_THEME_GLASS_RANGES.saturate}
            step={5}
            value={prefs.saturate}
            unit="%"
            onChange={saturate => tune({ saturate })}
          />
          <RangeRow
            id="glass.brightness"
            range={UI_THEME_GLASS_RANGES.brightness}
            value={prefs.brightness[theme]}
            unit="%"
            onChange={v => tune({ brightness: { ...prefs.brightness, [theme]: v } })}
          />
        </>
      )}
      <RangeRow
        id="glass.grain"
        range={UI_THEME_GLASS_RANGES.grain}
        value={prefs.grain}
        unit="%"
        onChange={grain => tune({ grain })}
      />

      <SettingRow title={tr('glass.tint')} description={tr('glass.tint.desc')}>
        <div className="flex items-center gap-3">
          <Segmented
            label={tr('glass.tint')}
            options={[
              { value: 'theme', label: tr('glass.tint.theme') },
              { value: 'custom', label: tr('glass.tint.custom') },
            ]}
            value={prefs.tint ? 'custom' : 'theme'}
            onChange={v => set({ tint: v === 'custom' ? '#1d2a3a' : '' })}
          />
          {prefs.tint && (
            <input
              type="color"
              aria-label={tr('glass.tint')}
              value={prefs.tint}
              onChange={e => set({ tint: e.target.value })}
              className="h-6 w-7 shrink-0 cursor-pointer rounded border border-line bg-transparent p-0"
            />
          )}
        </div>
      </SettingRow>

      <SettingRow title={tr('glass.zones')} description={tr('glass.zones.desc')}>
        <div className="grid grid-cols-[auto_auto] items-center justify-start gap-x-4 gap-y-2 text-meta text-fg-secondary">
          {(
            [
              ['side', 'glass.zone.side'],
              ['main', 'glass.zone.main'],
              ['right', 'glass.zone.right'],
              ['card', 'glass.zone.card'],
            ] as const
          ).flatMap(([key, label]) => [<span key={label}>{tr(label)}</span>, zone(key, label)])}
        </div>
      </SettingRow>
      <RangeRow
        id="glass.code"
        range={GLASS_CODE_RANGE}
        value={prefs.codeTransparency}
        unit="%"
        onChange={codeTransparency => set({ codeTransparency })}
      />
      <RangeRow
        id="glass.menu"
        range={GLASS_MENU_RANGE}
        value={prefs.menuOpacity}
        unit="%"
        onChange={menuOpacity => set({ menuOpacity })}
      />
      <RangeRow
        id="glass.rim"
        range={UI_THEME_GLASS_RANGES.rim}
        value={prefs.rim}
        unit="%"
        onChange={rim => tune({ rim })}
      />
      <RangeRow
        id="glass.radius"
        range={GLASS_RADIUS_RANGE}
        value={prefs.radius}
        unit="px"
        onChange={radius => set({ radius })}
      />

      {!desk && (
        <SettingRow title={tr('glass.readable')} description={tr('glass.readable.desc')}>
          <Segmented<GlassReadable>
            label={tr('glass.readable')}
            options={[
              { value: 'off', label: tr('glass.readable.off') },
              { value: '3', label: '3:1' },
              { value: '4.5', label: '4.5:1' },
            ]}
            value={prefs.readable}
            onChange={readable => set({ readable })}
          />
        </SettingRow>
      )}
      <SwitchRow id="glass.boost" value={prefs.boostMuted} onChange={boostMuted => set({ boostMuted })} />
      <SwitchRow id="glass.shadow" value={prefs.textShadow} onChange={textShadow => set({ textShadow })} />
      <SwitchRow id="glass.solidOnBlur" value={prefs.solidOnBlur} onChange={solidOnBlur => set({ solidOnBlur })} />
      <SwitchRow
        id="glass.solidOnBattery"
        value={prefs.solidOnBattery}
        onChange={solidOnBattery => set({ solidOnBattery })}
      />
      <SwitchRow
        id="glass.followReduced"
        value={prefs.followReduced}
        onChange={followReduced => set({ followReduced })}
      />
      <div className="py-4">
        <Button onClick={resetGlass}>{tr('glass.reset')}</Button>
      </div>
    </div>
  )
}
