import { useEffect, useRef, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Button, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useAccent } from '@/features/appearance/accent'
import { usePalette } from '@/features/appearance/palette'
import { useTheme } from '@/features/appearance/ThemeProvider'
import {
  ART_ACCEPT,
  addTheme,
  forkTheme,
  removeTheme,
  renameTheme,
  resetTheme,
  setActiveTheme,
  setArtMask,
  setArtOn,
  setThemeArt,
  setThemeColor,
  useCustomThemes,
} from '@/features/appearance/customTheme'
import type { ThemeColorKey } from '@/features/appearance/customThemeBase'
import {
  DEFAULT_ART_MASK,
  MAX_THEMES,
  THEME_NAME_MAX,
  contrast,
  deriveVars,
  exportTheme,
  modeMismatch,
  parseImport,
  type CustomTheme,
  type ThemeMode,
} from '@/features/appearance/customThemeCore'
import { PalettePreview, paletteName } from './PalettePreview'

// 自定义主题（docs/ui/custom-theme.md）：外观页「配色主题」里的「我的主题」和编辑器。改动立刻生效，界面本身就是预览

const INPUT = 'rounded-md border border-line bg-subtle text-fg outline-none focus:border-line-strong'

const GROUPS = [
  {
    title: 'customTheme.group.surface',
    colors: [
      { key: 'bg-sidebar', label: 'customTheme.color.sidebar' },
      { key: 'bg-app', label: 'customTheme.color.app' },
      { key: 'bg-workbench', label: 'customTheme.color.workbench' },
      { key: 'bg-surface', label: 'customTheme.color.surface' },
      { key: 'border', label: 'customTheme.color.border' },
    ],
  },
  {
    title: 'customTheme.group.text',
    colors: [
      { key: 'text', label: 'customTheme.color.text' },
      { key: 'text-secondary', label: 'customTheme.color.secondary' },
      { key: 'text-muted', label: 'customTheme.color.muted' },
    ],
  },
  {
    title: 'customTheme.group.accent',
    colors: [
      { key: 'theme-accent', label: 'customTheme.color.accent' },
      { key: 'btn-primary-bg', label: 'customTheme.color.primary' },
    ],
  },
  {
    title: 'customTheme.group.status',
    colors: [
      { key: 'success', label: 'customTheme.color.success' },
      { key: 'warn', label: 'customTheme.color.warn' },
      { key: 'danger', label: 'customTheme.color.danger' },
    ],
  },
] as const satisfies readonly { title: string; colors: readonly { key: ThemeColorKey; label: string }[] }[]

/** 「我的主题」：自建主题的卡片、新建、导入 */
export function MyThemes() {
  useI18n()
  const { themes, activeId } = useCustomThemes()
  const { resolved } = useTheme()
  const palette = usePalette()
  const [importing, setImporting] = useState(false)
  const full = themes.length >= MAX_THEMES
  const create = (): void => {
    const from = themes.find(t => t.id === activeId) ?? null
    forkTheme(
      from,
      palette,
      from
        ? tr('customTheme.forkMine', { name: from.name })
        : tr('customTheme.forkBuiltin', { name: paletteName(palette) }),
    )
  }
  return (
    <div data-my-themes>
      <div className="mb-2 flex items-center gap-3">
        <span className="text-meta text-fg-muted">{tr('customTheme.mine')}</span>
        <Button disabled={full} onClick={() => setImporting(v => !v)}>
          {tr('customTheme.import')}
        </Button>
      </div>
      <div
        role="radiogroup"
        aria-label={tr('customTheme.mine')}
        className="grid grid-cols-4 gap-3 @max-[720px]:grid-cols-3 @max-[520px]:grid-cols-2"
      >
        {themes.map(theme => {
          const active = theme.id === activeId
          const vars = deriveVars(theme[resolved], resolved)
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={tr('customTheme.choose', { name: theme.name })}
              onClick={() => setActiveTheme(theme.id)}
              className={cn(
                'rounded-lg border p-1.5 text-left hover:border-line-strong',
                active ? 'border-accent-line bg-accent-soft/40' : 'border-line-card',
              )}
            >
              {/* 缩略图的主区画的是对话区：真实界面里用户看到的就是它 */}
              <PalettePreview vars={{ ...vars, '--bg-app': vars['--bg-workbench'] }} />
              <div className="mt-1.5 flex items-center justify-between gap-1 px-0.5 text-meta text-fg">
                <span className="truncate">{theme.name}</span>
                {active && <Check size={13} className="shrink-0 text-accent-fg" />}
              </div>
            </button>
          )
        })}
        <button
          type="button"
          data-new-theme
          disabled={full}
          title={full ? tr('customTheme.limit', { n: MAX_THEMES }) : tr('customTheme.newHint')}
          onClick={create}
          className="flex min-h-[92px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-card text-meta text-fg-muted hover:border-line-strong disabled:opacity-50"
        >
          <Plus size={14} />
          {tr('customTheme.new')}
        </button>
      </div>
      {importing && <ImportPanel onClose={() => setImporting(false)} />}
    </div>
  )
}

function ImportPanel({ onClose }: { onClose(): void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = (): void => {
    const r = parseImport(text)
    if ('error' in r) {
      setError(tr(`customTheme.error.${r.error}`, { detail: r.detail ?? '' }))
      return
    }
    if (addTheme(r.theme)) onClose()
    else setError(tr('customTheme.limit', { n: MAX_THEMES }))
  }
  return (
    <div data-theme-import className="mt-3 rounded-lg border border-line-card p-3">
      <p className="mb-2 text-meta text-fg-muted">{tr('customTheme.importHint')}</p>
      <textarea
        aria-label={tr('customTheme.import')}
        spellCheck={false}
        value={text}
        onChange={e => setText(e.target.value)}
        className={cn(INPUT, 'selectable block h-40 w-full resize-y p-2 font-mono text-meta')}
      />
      {error && (
        <p role="alert" className="mt-2 text-meta text-danger">
          {error}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {tr('customTheme.cancel')}
        </Button>
        <Button variant="primary" disabled={!text.trim()} onClick={submit}>
          {tr('customTheme.importGo')}
        </Button>
      </div>
    </div>
  )
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange(next: string): void }) {
  // 手输到一半（#12）先留在输入框里，凑够 #RRGGBB 才生效；离开时不合法的退回现在的值
  const [draft, setDraft] = useState(value)
  // 手输大写时值已经一样（存的是小写）：不改写输入框，光标不跳
  useEffect(() => setDraft(d => (d.toLowerCase() === value ? d : value)), [value])
  return (
    <label className="flex items-center gap-2 py-1 text-meta text-fg-secondary">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="h-6 w-7 shrink-0 cursor-pointer rounded border border-line bg-transparent p-0"
      />
      <input
        type="text"
        aria-label={tr('customTheme.hexLabel', { name: label })}
        spellCheck={false}
        maxLength={7}
        value={draft}
        onChange={e => {
          setDraft(e.target.value)
          if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value)
        }}
        onBlur={() => setDraft(value)}
        className={cn(INPUT, 'selectable h-6 w-20 shrink-0 px-1.5 font-mono text-meta')}
      />
    </label>
  )
}

function ContrastChecks({ theme, mode, presetAccent }: { theme: CustomTheme; mode: ThemeMode; presetAccent: boolean }) {
  const c = theme[mode]
  const rows = [
    { label: 'customTheme.check.textApp', a: c.text, b: c['bg-workbench'], min: 4.5 },
    { label: 'customTheme.check.textSurface', a: c.text, b: c['bg-surface'], min: 4.5 },
    { label: 'customTheme.check.mutedApp', a: c['text-muted'], b: c['bg-workbench'], min: 3 },
    // 选了预设强调色时界面不用这个颜色，评它没有意义
    ...(presetAccent
      ? []
      : ([{ label: 'customTheme.check.accentApp', a: c['theme-accent'], b: c['bg-workbench'], min: 3 }] as const)),
  ] as const
  return (
    <div data-theme-checks className="mt-3 grid grid-cols-2 gap-x-6 gap-y-0.5 text-meta @max-[520px]:grid-cols-1">
      {rows.map(row => {
        const ratio = contrast(row.a, row.b)
        const low = ratio < row.min
        return (
          <div key={row.label} data-low={low || undefined} className={low ? 'text-warn' : 'text-fg-muted'}>
            {low ? '▲' : '✓'} {tr(row.label)} {ratio.toFixed(1)}:1
            {low && tr('customTheme.check.low', { min: row.min })}
          </div>
        )
      })}
      {modeMismatch(c, mode) && (
        <div data-low className="col-span-full text-warn">
          ▲ {tr(mode === 'dark' ? 'customTheme.check.mismatchDark' : 'customTheme.check.mismatchLight')}
        </div>
      )}
    </div>
  )
}

function ThemeArtRow({ theme, mode, artUrl }: { theme: CustomTheme; mode: ThemeMode; artUrl: string | null }) {
  const file = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const ERRORS = { type: 'customTheme.artType', size: 'customTheme.artSize', save: 'customTheme.artSave' } as const
  const mask = theme.art?.mask[mode] ?? DEFAULT_ART_MASK[mode]
  return (
    <div className="mt-4 border-t border-line-subtle pt-3">
      <div className="mb-1 text-meta text-fg-muted">{tr('customTheme.art')}</div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-meta text-fg-secondary">
          <input
            type="checkbox"
            disabled={!theme.art}
            checked={!!theme.art?.on}
            onChange={e => setArtOn(theme.id, e.target.checked)}
          />
          {tr('customTheme.artOn')}
        </label>
        {artUrl && (
          <span
            aria-hidden
            className="h-7 w-[72px] shrink-0 rounded border border-line bg-cover bg-center"
            style={{ backgroundImage: `url("${artUrl}")` }}
          />
        )}
        <Button onClick={() => file.current?.click()}>{tr('customTheme.artPick')}</Button>
        <input
          ref={file}
          data-theme-art-file
          type="file"
          accept={ART_ACCEPT}
          hidden
          onChange={e => {
            const picked = e.target.files?.[0]
            e.target.value = ''
            if (!picked) return
            setError(null)
            void setThemeArt(theme.id, picked).then(failure => failure && setError(tr(ERRORS[failure])))
          }}
        />
      </div>
      {theme.art && (
        <label className="mt-2 flex max-w-sm items-center gap-2 text-meta text-fg-secondary">
          <span className="shrink-0">{tr('customTheme.artMask')}</span>
          <input
            type="range"
            min={0}
            max={90}
            value={mask}
            onChange={e => setArtMask(theme.id, mode, Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <span className="w-9 shrink-0 text-right text-fg-muted">{mask}%</span>
        </label>
      )}
      {error && (
        <p role="alert" className="mt-2 text-meta text-danger">
          {error}
        </p>
      )}
      <p className="mt-1 text-meta text-fg-faint">{tr('customTheme.artLocal')}</p>
    </div>
  )
}

function ExportPanel({ theme, onClose }: { theme: CustomTheme; onClose(): void }) {
  const [copied, setCopied] = useState<boolean | 'failed'>(false)
  const text = exportTheme(theme)
  useEffect(() => setCopied(false), [text])
  return (
    <div data-theme-export className="mt-3 rounded-lg border border-line-card p-3">
      <p className="mb-2 text-meta text-fg-muted">{tr('customTheme.exportHint')}</p>
      <textarea
        readOnly
        aria-label={tr('customTheme.export')}
        spellCheck={false}
        value={text}
        className={cn(INPUT, 'selectable block h-40 w-full resize-y p-2 font-mono text-meta')}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {tr('customTheme.close')}
        </Button>
        <Button
          variant="primary"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => setCopied('failed'),
            )
          }
        >
          {copied === 'failed'
            ? tr('customTheme.copyFailed')
            : copied
              ? tr('customTheme.copied')
              : tr('customTheme.copy')}
        </Button>
      </div>
    </div>
  )
}

/** 编辑器：只在选中自建主题时出现。改的是当前显示的浅色或深色那一份 */
export function CustomThemeEditor() {
  useI18n()
  const { themes, activeId, artUrl } = useCustomThemes()
  const { resolved } = useTheme()
  const [exporting, setExporting] = useState(false)
  const [confirming, setConfirming] = useState<'delete' | 'reset' | null>(null)
  const presetAccent = useAccent() !== 'theme'
  const theme = themes.find(t => t.id === activeId)
  // 换主题时名字输入框跟着换；打字打到一半是空的也不写进去（renameTheme 不收空名字），离开时恢复
  const [name, setName] = useState(theme?.name ?? '')
  // 输入框里的就是这个名字（只差存盘时的去空格、截断）就不改写，不吃掉正在打的空格、不打断输入法
  useEffect(
    () =>
      setName(current =>
        theme && current.trim().slice(0, THEME_NAME_MAX) === theme.name ? current : (theme?.name ?? ''),
      ),
    [theme?.id, theme?.name],
  )
  useEffect(() => {
    setExporting(false)
    // 另一个窗口换了主题：弹窗不留着，也不换目标
    setConfirming(null)
  }, [theme?.id])
  if (!theme) return null
  return (
    <div data-theme-editor className="mt-4 rounded-lg border border-line-card p-4">
      <div className="flex items-center gap-3">
        <input
          aria-label={tr('customTheme.name')}
          maxLength={THEME_NAME_MAX}
          value={name}
          onChange={e => {
            setName(e.target.value)
            renameTheme(theme.id, e.target.value)
          }}
          onBlur={() => setName(theme.name)}
          className={cn(INPUT, 'selectable h-7 w-56 max-w-full px-2 text-ui')}
        />
        <span className="truncate text-meta text-fg-muted">
          {tr('customTheme.basedOn', { name: paletteName(theme.base) })}
        </span>
      </div>
      <p className="mt-2 text-meta text-fg-faint">
        {tr(resolved === 'dark' ? 'customTheme.editingDark' : 'customTheme.editingLight')}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-3 @max-[520px]:grid-cols-1">
        {GROUPS.map(group => (
          <div key={group.title}>
            <div className="mb-1 text-meta text-fg-muted">{tr(group.title)}</div>
            {group.colors.map(({ key, label }) => (
              <ColorField
                key={key}
                label={tr(label)}
                value={theme[resolved][key]}
                onChange={next => setThemeColor(theme.id, resolved, key, next)}
              />
            ))}
            {presetAccent && group.title === 'customTheme.group.accent' && (
              <p data-accent-preset-hint className="mt-1 text-meta text-fg-faint">
                {tr('customTheme.accentPreset')}
              </p>
            )}
          </div>
        ))}
      </div>
      <ContrastChecks theme={theme} mode={resolved} presetAccent={presetAccent} />
      <ThemeArtRow key={theme.id} theme={theme} mode={resolved} artUrl={artUrl} />
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line-subtle pt-3">
        <Button onClick={() => setExporting(v => !v)}>{tr('customTheme.export')}</Button>
        <Button onClick={() => setConfirming('reset')}>{tr('customTheme.reset')}</Button>
        <Button variant="ghost" className="text-danger!" onClick={() => setConfirming('delete')}>
          {tr('customTheme.delete')}
        </Button>
      </div>
      {exporting && <ExportPanel theme={theme} onClose={() => setExporting(false)} />}
      {confirming === 'reset' && (
        <ConfirmDialog
          busy={false}
          title={tr('customTheme.resetTitle', { name: paletteName(theme.base) })}
          description={tr('customTheme.resetBody')}
          confirmLabel={tr('customTheme.reset')}
          cancelLabel={tr('customTheme.cancel')}
          onConfirm={() => {
            setConfirming(null)
            resetTheme(theme.id)
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === 'delete' && (
        <ConfirmDialog
          busy={false}
          danger
          title={tr('customTheme.deleteTitle', { name: theme.name })}
          description={tr('customTheme.deleteBody')}
          confirmLabel={tr('customTheme.delete')}
          cancelLabel={tr('customTheme.cancel')}
          onConfirm={() => {
            setConfirming(null)
            removeTheme(theme.id)
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  )
}
