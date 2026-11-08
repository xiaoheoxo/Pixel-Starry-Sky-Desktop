import { useState } from 'react'
import type { SessionSnapshot, SubagentOverride } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Select, Switch } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { bridge, getEngineState } from '@/features/engine/store'
import { useEngineCatalog } from '@/features/engine/catalog'
import { useProviders } from '@/features/account/providers'
import { usePlatform } from '@/features/account/platform'
import { useSubagentSettings } from '@/features/settings/subagents'
import { typeName } from '@/features/settings/SubagentTypeCard'
import { SubagentEffortSelect } from '@/features/settings/SubagentEffortSelect'

export function SubagentSettingsDialog({ snapshot, onClose }: { snapshot: SessionSnapshot; onClose: () => void }) {
  useI18n()
  const { settings, loaded } = useSubagentSettings()
  const types = settings.types.filter(t => t.enabled)
  const [type, setType] = useState(types[0]?.id ?? 'general')
  const [drafts, setDrafts] = useState<Record<string, SubagentOverride>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const catalog = useEngineCatalog('pixel')
  const { providers } = useProviders()
  const platform = usePlatform('pixel')
  const record = snapshot.record
  const source = snapshot.execution ?? record
  const config = types.find(t => t.id === type)
  const draft = (Object.hasOwn(drafts, type) ? drafts[type] : undefined) ??
    record.subagentOverrides?.find(o => o.type === type) ?? { type }
  const set = (patch: Partial<SubagentOverride>) => setDrafts(all => ({ ...all, [type]: { ...draft, ...patch } }))
  const models = source.provider
    ? (providers.find(p => p.id === source.provider?.id)?.models.map(m => m.id) ?? [])
    : source.platform
      ? (platform.groups.find(g => g.id === source.platform?.groupId)?.models ?? [])
      : (catalog?.models?.map(m => m.id) ?? [])
  const modelValue = draft.model === undefined ? '__type__' : (draft.model ?? '')
  const effortModel =
    draft.model === undefined
      ? config?.dispatch
        ? null
        : (config?.target?.model ?? source.model)
      : (draft.model ?? source.model)
  const effortUsesPixelCatalog =
    draft.model === undefined && config?.target ? false : !source.provider && !source.platform
  const invalidModel = !!draft.model && !models.includes(draft.model)
  const invalidDraft = Object.values(drafts).some(d => d.model && !models.includes(d.model))
  const save = async () => {
    if (!bridge) return
    setBusy(true)
    setError(null)
    try {
      // 保存时合并最新快照，保留弹窗打开期间其他入口改的类型；不用 await 前保存的旧记录。
      const latest = getEngineState().snapshots[record.id]
      if (!latest) return onClose()
      const currentSource = latest.execution ?? latest.record
      if (
        JSON.stringify([currentSource.provider, currentSource.platform]) !==
        JSON.stringify([source.provider, source.platform])
      )
        throw new Error(tr('subagentRoute.session.sourceChanged'))
      const overrides = [
        ...(latest.record.subagentOverrides ?? []).filter(o => !Object.hasOwn(drafts, o.type)),
        ...Object.values(drafts),
      ]
      await bridge.updateSession(record.id, { subagentOverrides: overrides })
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog
      title={tr('subagentRoute.session.title')}
      busy={busy}
      error={error}
      confirmLabel={tr('subagentRoute.session.apply')}
      cancelLabel={tr('subagentRoute.cancel')}
      confirmDisabled={!loaded || !types.length || !Object.keys(drafts).length || !!invalidDraft || !bridge}
      dirty={Object.keys(drafts).length > 0}
      onConfirm={() => void save()}
      onCancel={onClose}
      description={
        <div className="space-y-4 text-ui text-fg">
          <p className="text-meta text-fg-muted">{tr('subagentRoute.session.hint')}</p>
          <div>
            <p className="mb-1.5 text-meta text-fg-muted">{tr('subagentRoute.types')}</p>
            <Select
              label={tr('subagentRoute.types')}
              value={type}
              options={types.map(t => ({ value: t.id, label: typeName(t) }))}
              onChange={setType}
            />
          </div>
          <div>
            <p className="mb-1.5 text-meta text-fg-muted">{tr('subagentRoute.model')}</p>
            <Select
              label={tr('subagentRoute.model')}
              value={modelValue}
              mono
              options={[
                { value: '__type__', label: tr('subagentRoute.session.typeDefault') },
                { value: '', label: tr('subagentRoute.follow') },
                ...models.map(m => ({ value: m, label: m })),
                ...(draft.model && !models.includes(draft.model)
                  ? [{ value: draft.model, label: draft.model, disabled: true }]
                  : []),
              ]}
              onChange={m => set({ model: m === '__type__' ? undefined : m || null })}
            />
            {invalidModel && <p className="mt-1.5 text-meta text-danger">{tr('subagentRoute.session.modelMissing')}</p>}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>{tr('subagentRoute.session.overrideEffort')}</span>
            <Switch
              label={tr('subagentRoute.session.overrideEffort')}
              checked={draft.effort !== undefined}
              onChange={enabled => set({ effort: enabled ? null : undefined })}
            />
          </div>
          {draft.effort !== undefined && (
            <SubagentEffortSelect
              model={effortModel}
              value={draft.effort}
              usePixelCatalog={effortUsesPixelCatalog}
              onChange={effort => set({ effort })}
            />
          )}
          <p className="text-meta text-fg-muted">{tr('subagentRoute.session.source')}</p>
          <p className="text-meta text-fg-faint">{tr('subagentRoute.session.reconnect')}</p>
        </div>
      }
    />
  )
}
