import { useId, useState, type FormEvent } from 'react'
import {
  MODEL_DETAIL_MAX_TEXT,
  MODEL_PRICE_CURRENCIES,
  modelDetailKey,
  currentCloudModelPrice,
  parseModelDetailPatch,
  type CloudModelReference,
  type ModelDetail,
  type ModelDetailTarget,
} from '@pixelsky/protocol'
import type { PlatformGroupInfo } from '../../../../../shared/types/platform-catalog'
import { useProviders } from '@/features/account/providers'
import { bridge, useEngineState } from '@/features/engine'
import { useEngineCatalog } from '@/features/engine/catalog'
import { channelLabel } from '@/features/model-channels/channelLabels'
import { menuModelPrice, modelPositionLabel, modelRoleGuide } from '@/features/model-channels/modelRoleGuide'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { Button, Select } from '@/ui'

type Source = {
  channel: ModelDetailTarget['channel']
  id: string | null
  label: string
  models: { value: string; label: string; priceRef?: string | null; cloudReference?: CloudModelReference }[]
}
const sourceKey = (source: Source) => JSON.stringify([source.channel, source.id])
const field = 'w-full rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg'
const toOptions = (models: readonly string[]) => [...new Set(models)].map(model => ({ value: model, label: model }))

export function ModelDetailsSection({ platformGroups }: { platformGroups: readonly PlatformGroupInfo[] }) {
  useI18n()
  const claude = useEngineCatalog('claude')
  const chatgpt = useEngineCatalog('codex')
  const google = useEngineCatalog('antigravity')
  const providers = useProviders()
  const details = useEngineState(s => s.config?.codex.modelDetails)
  const [sourceId, setSourceId] = useState('')
  const [modelId, setModelId] = useState('')
  const sources: Source[] = [
    ...[...new Map(platformGroups.map(group => [group.id, group])).values()].map(group => ({
      channel: 'platform' as const,
      id: group.id,
      label: `${channelLabel('platform')} · ${group.name}`,
      models: toOptions(group.models),
    })),
    ...(
      [
        { channel: 'claude', catalog: claude },
        { channel: 'chatgpt', catalog: chatgpt },
        { channel: 'google', catalog: google },
      ] as const
    ).map(({ channel, catalog }) => ({
      channel,
      id: null,
      label: channelLabel(channel),
      models: (catalog?.models ?? []).map(model => ({
        value: model.id,
        label: model.label || model.id,
        cloudReference: model.cloudReference,
      })),
    })),
    ...providers.providers.map(provider => ({
      channel: 'custom' as const,
      id: provider.id,
      label: `${channelLabel('custom')} · ${provider.name}`,
      models: provider.models.map(model => ({ value: model.id, label: model.id, priceRef: model.priceRef })),
    })),
  ].filter(source => source.models.length)
  const source = sources.find(item => sourceKey(item) === sourceId) ?? sources[0]
  const model = source?.models.find(item => item.value === modelId) ?? source?.models[0]
  const target = source && model ? { channel: source.channel, sourceId: source.id, model: model.value } : null
  const key = target ? modelDetailKey(target) : ''

  return (
    <details data-setting-title={tr('modelDetails.title')} className="mt-5 rounded-lg border border-line px-4 py-3">
      <summary className="cursor-pointer text-ui font-medium text-fg">{tr('modelDetails.title')}</summary>
      <p className="mt-2 text-meta text-fg-muted">{tr('modelDetails.hint')}</p>
      {!target || !source || !model ? (
        <p className="mt-3 text-label text-fg-muted">{tr('modelDetails.noModels')}</p>
      ) : (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Select
              label={tr('modelDetails.channel')}
              value={sourceKey(source)}
              options={sources.map(item => ({ value: sourceKey(item), label: item.label }))}
              onChange={id => {
                setSourceId(id)
                setModelId('')
              }}
            />
            <Select
              label={tr('modelDetails.model')}
              value={model.value}
              options={source.models}
              onChange={setModelId}
            />
          </div>
          <DetailEditor
            key={key}
            target={target}
            saved={details?.[key]}
            priceRef={model.priceRef}
            cloudReference={model.cloudReference}
          />
        </>
      )}
    </details>
  )
}

function DetailEditor({
  target,
  saved,
  priceRef,
  cloudReference,
}: {
  target: ModelDetailTarget
  saved?: ModelDetail
  priceRef?: string | null
  cloudReference?: CloudModelReference
}) {
  const id = useId()
  const baseline = modelRoleGuide(target.model)
  const [main, setMain] = useState(saved?.main ?? baseline?.main ?? '')
  const [evaluator, setEvaluator] = useState(saved?.evaluator ?? baseline?.evaluator ?? '')
  const priceFields = (price: ModelDetail['price']) => ({
    currency: price?.currency ?? ('USD' as const),
    input: price ? String(price.input) : '',
    output: price ? String(price.output) : '',
  })
  const [draftPrice, setDraftPrice] = useState<ReturnType<typeof priceFields> | null>(null)
  const price = menuModelPrice(target, saved?.price, currentCloudModelPrice(cloudReference), undefined, priceRef)
  const currentPrice = draftPrice ?? priceFields(price?.price)
  const { currency, input, output } = currentPrice
  const setCurrency = (next: typeof currency) => setDraftPrice({ ...currentPrice, currency: next })
  const setInput = (next: string) => setDraftPrice({ ...currentPrice, input: next })
  const setOutput = (next: string) => setDraftPrice({ ...currentPrice, output: next })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ error: boolean; text: string }>()
  const save = async (detail: ModelDetail | null) => {
    if (!bridge) return
    setBusy(true)
    setResult(undefined)
    try {
      await bridge.setConfig('codex', { modelDetail: { target, detail } })
      setResult({ error: false, text: tr('modelDetails.saved') })
    } catch {
      setResult({ error: true, text: tr('modelDetails.error') })
    } finally {
      setBusy(false)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const a = input.trim()
    const b = output.trim()
    const detail = {
      ...(main !== (baseline?.main ?? '') ? { main } : {}),
      ...(evaluator !== (baseline?.evaluator ?? '') ? { evaluator } : {}),
      ...((draftPrice || saved?.price) && (a || b)
        ? { price: { currency, input: a ? Number(a) : NaN, output: b ? Number(b) : NaN } }
        : {}),
    }
    const patch = parseModelDetailPatch({ target, detail })
    if (!patch) return setResult({ error: true, text: tr('modelDetails.invalidPrice') })
    void save(patch.detail)
  }
  const reset = async () => {
    if (!bridge) return
    setBusy(true)
    setResult(undefined)
    try {
      await bridge.setConfig('codex', { modelDetail: { target, detail: null } })
      setMain(baseline?.main ?? '')
      setEvaluator(baseline?.evaluator ?? '')
      setDraftPrice(null)
      setResult({ error: false, text: tr('modelDetails.restored') })
    } catch {
      setResult({ error: true, text: tr('modelDetails.error') })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="mt-3 space-y-3" onSubmit={submit}>
      {modelPositionLabel(target.model) && (
        <span className="inline-flex rounded-md bg-subtle px-2 py-1 text-label font-medium text-fg-secondary">
          {modelPositionLabel(target.model)}
        </span>
      )}
      <fieldset disabled={busy} className="space-y-3">
        <label className="block text-label" htmlFor={`${id}-main`}>
          {tr('modelDetails.main')}
          <textarea
            id={`${id}-main`}
            className={`${field} mt-1 resize-y`}
            rows={2}
            maxLength={MODEL_DETAIL_MAX_TEXT}
            value={main}
            onChange={e => setMain(e.target.value)}
          />
        </label>
        <label className="block text-label" htmlFor={`${id}-evaluator`}>
          {tr('modelDetails.evaluator')}
          <textarea
            id={`${id}-evaluator`}
            className={`${field} mt-1 resize-y`}
            rows={2}
            maxLength={MODEL_DETAIL_MAX_TEXT}
            value={evaluator}
            onChange={e => setEvaluator(e.target.value)}
          />
        </label>
        {cloudReference?.description && (
          <p className="text-label text-fg-muted">
            {tr('modelDetails.cloudDescription', { description: cloudReference.description })}
          </p>
        )}
        <div className="space-y-1">
          <div className="text-label font-medium">{tr('modelDetails.price')}</div>
          <div className="grid items-end gap-2 sm:grid-cols-3">
            <Select
              disabled={busy}
              label={tr('modelDetails.currency')}
              value={currency}
              options={MODEL_PRICE_CURRENCIES.map(value => ({ value, label: value }))}
              onChange={setCurrency}
            />
            <label htmlFor={`${id}-input`} className="text-label">
              {tr('modelDetails.input')}
              <input
                id={`${id}-input`}
                className={field}
                type="number"
                min="0"
                max="1000000"
                step="any"
                value={input}
                onChange={e => setInput(e.target.value)}
              />
            </label>
            <label htmlFor={`${id}-output`} className="text-label">
              {tr('modelDetails.output')}
              <input
                id={`${id}-output`}
                className={field}
                type="number"
                min="0"
                max="1000000"
                step="any"
                value={output}
                onChange={e => setOutput(e.target.value)}
              />
            </label>
          </div>
          {price && !draftPrice && (
            <p className="text-label text-fg-faint">{tr(`modelChannels.menu.priceBasis.${price.basis}`)}</p>
          )}
          <p className="text-label text-fg-muted">{tr('modelDetails.priceHint')}</p>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {tr('modelDetails.save')}
        </Button>
        <Button onClick={() => void reset()} disabled={busy}>
          {tr('modelDetails.restore')}
        </Button>
        {result && (
          <span
            className={result.error ? 'text-label text-danger' : 'text-label text-fg-muted'}
            role={result.error ? 'alert' : 'status'}
          >
            {result.text}
          </span>
        )}
      </div>
    </form>
  )
}
