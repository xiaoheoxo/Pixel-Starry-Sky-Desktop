import { useRef, useState } from 'react'
import { ChevronDown, Info, Network, X } from 'lucide-react'
import type { SubagentConfig } from '@pixelsky/protocol'
import type { ComposerController } from '@/features/engine'
import { usePlatform } from '@/features/account/platform'
import { useProviders } from '@/features/account/providers'
import { setSubagentDefault } from '@/features/engine/subagentPrefs'
import { machineOf, useMachines } from '@/features/machines/store'
import { Popover, cn, useToast } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'

export function SubagentMenu({ live }: { live?: ComposerController }) {
  useI18n()
  const platform = usePlatform('pixel')
  const providers = useProviders()
  const toast = useToast()
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [demo, setDemo] = useState<SubagentConfig | null>(null)
  const [separate, setSeparate] = useState(false)
  const [site, setSite] = useState('')
  const [model, setModel] = useState('')
  const [asDefault, setAsDefault] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const config = live ? live.subagent : demo
  const machines = useMachines()
  const remote = live?.sessionId ? machineOf(live.sessionId) !== 'local' : machines.currentId !== 'local'
  const sites = [
    ...providers.providers.map(p => ({
      key: `custom:${p.id}`,
      name: p.name,
      models: p.models.map(m => m.id),
      unavailable: !p.keyHint,
      source: 'custom' as const,
      id: p.id,
    })),
    ...platform.groups.map(g => ({
      key: `platform:${g.id}`,
      name: `${tr('modelChannels.short.platform')} · ${g.name}`,
      models: g.models,
      unavailable: !platform.email || !!g.modelsError,
      source: 'platform' as const,
      id: g.id,
    })),
  ]
  const configSite = config
    ? sites.find(s => s.key === `${config.source}:${config.source === 'custom' ? config.providerId : config.groupId}`)
    : null
  const label = config
    ? `${configSite?.name ?? tr('subagentSettings.unavailable')} · ${config.model}`
    : tr('subagentSettings.follow')
  const selectedSite = sites.find(s => s.key === (site || sites[0]?.key))
  const selectedModel = model || selectedSite?.models[0] || ''
  const pixel = live?.engines.find(e => e.id === 'pixel')
  const issue = !separate
    ? null
    : remote
      ? tr('subagentSettings.remote')
      : !sites.length
        ? tr('subagentSettings.noSites')
        : !selectedSite || selectedSite.unavailable
          ? tr('subagentSettings.siteUnavailable')
          : !selectedModel || !selectedSite.models.includes(selectedModel)
            ? tr('subagentSettings.modelUnavailable')
            : pixel && pixel.status !== 'ready' && pixel.status !== 'unauthenticated'
              ? tr('subagentSettings.engineUnavailable')
              : null
  const close = () => {
    if (!saving) setOpen(false)
  }
  const toggle = () => {
    if (open) {
      close()
      return
    }
    setSeparate(!!config)
    setSite(
      config
        ? `${config.source}:${config.source === 'custom' ? config.providerId : config.groupId}`
        : (sites[0]?.key ?? ''),
    )
    setModel(config?.model ?? '')
    setAsDefault(false)
    setError(null)
    setOpen(true)
  }
  const save = async () => {
    if (saving || issue) return
    let next: SubagentConfig | null = null
    if (separate && selectedSite)
      next =
        selectedSite.source === 'custom'
          ? { source: 'custom', providerId: selectedSite.id, model: selectedModel }
          : { source: 'platform', groupId: selectedSite.id, account: platform.email!, model: selectedModel }
    setSaving(true)
    setError(null)
    try {
      if (live) await live.setSubagent(next)
      else setDemo(next)
      if (asDefault) setSubagentDefault(next)
      setOpen(false)
      toast(tr('subagentSettings.saved'))
    } catch (e) {
      setError(translateMessage(e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }
  const selectClass =
    'h-9 w-full rounded-md border border-line bg-surface px-2.5 text-meta text-fg outline-none focus:border-accent'
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-composer-subagent
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${tr('subagentSettings.title')} · ${label}`}
        title={`${tr('subagentSettings.title')} · ${label}`}
        onClick={toggle}
        className={cn(
          'press no-drag inline-flex h-8 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-meta hover:bg-hover',
          config ? 'bg-accent/8 text-accent-fg' : 'text-fg-secondary',
        )}
      >
        <Network size={14} className="shrink-0" />
        <span data-subagent-label className="max-w-52 truncate">
          {tr('subagentSettings.trigger', { value: label })}
        </span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      <Popover
        open={open}
        onClose={close}
        anchor={anchor}
        side="top"
        offset={8}
        bare
        role="dialog"
        aria-label={tr('subagentSettings.title')}
        className="w-96 max-w-[calc(100vw-24px)]"
      >
        <div className="flex items-start gap-3 px-4 pt-4 pb-3">
          <span className="rounded-lg bg-accent/10 p-2 text-accent-fg">
            <Network size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-list font-medium text-fg">{tr('subagentSettings.title')}</h3>
            <p className="mt-0.5 text-label text-fg-muted">{tr('subagentSettings.subtitle')}</p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={close}
            aria-label={tr('subagentSettings.close')}
            className="rounded p-1 text-fg-muted hover:bg-hover"
          >
            <X size={14} />
          </button>
        </div>
        <div className="max-h-[65vh] space-y-3 overflow-y-auto px-4 pb-4">
          <div
            role="radiogroup"
            aria-label={tr('subagentSettings.mode')}
            className="flex rounded-lg border border-line-subtle bg-app p-1"
          >
            {[false, true].map(value => (
              <button
                key={String(value)}
                type="button"
                role="radio"
                disabled={saving}
                aria-checked={separate === value}
                onClick={() => {
                  setSeparate(value)
                  setError(null)
                }}
                className={cn(
                  'h-8 flex-1 rounded-md text-meta',
                  separate === value ? 'bg-surface font-medium text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
                )}
              >
                {tr(value ? 'subagentSettings.independent' : 'subagentSettings.follow')}
              </button>
            ))}
          </div>
          {separate ? (
            <>
              <label className="block text-meta text-fg">
                {tr('subagentSettings.site')}
                <select
                  aria-label={tr('subagentSettings.site')}
                  disabled={saving}
                  value={site || selectedSite?.key || ''}
                  onChange={e => {
                    setSite(e.target.value)
                    setModel('')
                    setError(null)
                  }}
                  className={cn(selectClass, 'mt-1.5')}
                >
                  {!selectedSite && (
                    <option value={site}>
                      {site ? tr('subagentSettings.unavailable') : tr('subagentSettings.chooseSite')}
                    </option>
                  )}
                  {sites.map(s => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                      {s.unavailable ? ` · ${tr('subagentSettings.unavailable')}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-meta text-fg">
                {tr('subagentSettings.model')}
                <select
                  aria-label={tr('subagentSettings.model')}
                  disabled={saving || !selectedSite}
                  value={selectedModel}
                  onChange={e => {
                    setModel(e.target.value)
                    setError(null)
                  }}
                  className={cn(selectClass, 'mt-1.5')}
                >
                  {(!selectedModel || !selectedSite?.models.includes(selectedModel)) && (
                    <option value={selectedModel}>{selectedModel || tr('subagentSettings.chooseModel')}</option>
                  )}
                  {selectedSite?.models.map(m => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <div className="rounded-lg border border-line-subtle bg-app px-3 py-3">
              <p className="text-label text-fg-muted">{tr('subagentSettings.inherit')}</p>
              <p className="mt-1 text-meta text-fg">{live?.model ?? tr('subagentSettings.engineDefault')}</p>
            </div>
          )}
          <div
            role={error || issue ? 'alert' : undefined}
            className={cn(
              'flex items-start gap-2 rounded-md px-3 py-2.5 text-label leading-relaxed',
              error || issue ? 'bg-warn/10 text-warn' : 'bg-app text-fg-muted',
            )}
          >
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>{error || issue || tr(separate ? 'subagentSettings.nextOnly' : 'subagentSettings.followHint')}</span>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-label text-fg-muted">
            <input
              type="checkbox"
              disabled={saving}
              checked={asDefault}
              onChange={e => setAsDefault(e.target.checked)}
              className="accent-accent"
            />
            {tr('subagentSettings.asDefault')}
          </label>
        </div>
        <footer className="flex items-center gap-2 border-t border-line-subtle px-4 py-3">
          <span className="mr-auto text-label text-fg-muted">{tr('subagentSettings.scope')}</span>
          <button
            type="button"
            disabled={saving}
            onClick={close}
            className="rounded-md border border-line px-3 py-1.5 text-meta hover:bg-hover"
          >
            {tr('subagentSettings.cancel')}
          </button>
          <button
            type="button"
            disabled={saving || !!issue}
            onClick={() => void save()}
            className="rounded-md bg-accent px-3 py-1.5 text-meta text-accent-on disabled:opacity-40"
          >
            {tr(saving ? 'subagentSettings.saving' : 'subagentSettings.save')}
          </button>
        </footer>
      </Popover>
    </>
  )
}
