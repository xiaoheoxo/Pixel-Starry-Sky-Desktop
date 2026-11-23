import { useEffect, useMemo, useState } from 'react'
import {
  MODEL_DETAIL_MAX_TEXT,
  MODEL_PRICE_CURRENCIES,
  currentCloudModelPrice,
  modelDetailKey,
  openAiApiReference,
  publicApiPriceReference,
  type CloudModelReference,
  type ModelDetail,
  type ModelDetailChannel,
  type ModelDetailTarget,
  type ModelTokenPrice,
} from '@pixelsky/protocol'
import { Button, Switch, cn } from '@/ui'
import { useProviders } from '@/features/account/providers'
import { platformModels, usePlatform } from '@/features/account/platform'
import { bridge, useEngineState } from '@/features/engine'
import { useEngineCatalog } from '@/features/engine/catalog'
import { channelModelDetail, modelPositionLabel, modelRoleGuide } from '@/features/model-channels/modelRoleGuide'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { GroupTitle, SettingGroup, SettingRow } from '../SettingRow'

interface ModelOption {
  target: ModelDetailTarget
  label: string
  reference?: CloudModelReference
  priceRef?: string | null
}

interface ChannelGroup {
  id: string
  label: string
  models: ModelOption[]
}

const INPUT =
  'w-full min-w-0 rounded-lg border border-line bg-app px-2.5 py-1.5 text-meta text-fg outline-none focus:border-accent-line'

function parsePrice(
  currency: ModelTokenPrice['currency'],
  inputText: string,
  outputText: string,
): ModelTokenPrice | null | 'invalid' {
  const a = inputText.trim()
  const b = outputText.trim()
  if (!a && !b) return null
  if (!a || !b) return 'invalid'
  const input = Number(a)
  const output = Number(b)
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return 'invalid'
  return { currency, input, output }
}

/**
 * 设置 › 模型通道底部的「模型明细与参考价格」与联网目录开关（docs/ui/agnes-model-guide-plan.md §4）。
 * 采用方案 1 无边框色阶卡片，顶层独立存储 modelDetails，不挂在单引擎名下。
 */
export function ModelDetailsSection() {
  useI18n()
  const modelDetails = useEngineState(s => s.modelDetails)
  const cloudCatalog = useEngineState(s => s.cloudModelCatalog)
  const { providers } = useProviders()
  const codexCatalog = useEngineCatalog('codex')
  const claudeCatalog = useEngineCatalog('claude')
  const agyCatalog = useEngineCatalog('antigravity')
  const platform = usePlatform()
  const codexPlatform = usePlatform('codex')
  const pixelPlatform = usePlatform('pixel')
  const agyPlatform = usePlatform('antigravity')

  const groups = useMemo<ChannelGroup[]>(() => {
    const codex = codexCatalog?.models ?? []
    const claude = claudeCatalog?.models ?? []
    const agy = agyCatalog?.models ?? []
    const out: ChannelGroup[] = []
    for (const p of providers) {
      if (!p.models.length) continue
      out.push({
        id: `custom:${p.id}`,
        label: p.name || tr('modelChannels.tab.custom'),
        models: p.models.map(m => ({
          target: { channel: 'custom', sourceId: p.id, model: m.id },
          label: m.id,
          priceRef: m.priceRef ?? null,
        })),
      })
    }
    if (codex.length) {
      out.push({
        id: 'chatgpt',
        label: tr('modelChannels.tab.chatgpt'),
        models: codex.map(m => ({
          target: { channel: 'chatgpt', sourceId: null, model: m.id },
          label: m.label || m.id,
          reference: m.cloudReference,
        })),
      })
    }
    if (claude.length) {
      out.push({
        id: 'claude',
        label: tr('modelChannels.tab.claude'),
        models: claude.map(m => ({
          target: { channel: 'claude', sourceId: null, model: m.id },
          label: m.label || m.id,
          reference: m.cloudReference,
        })),
      })
    }
    if (agy.length) {
      out.push({
        id: 'google',
        label: tr('modelChannels.tab.google'),
        models: agy.map(m => ({
          target: { channel: 'google', sourceId: null, model: m.id },
          label: m.label || m.id,
          reference: m.cloudReference,
        })),
      })
    }
    const allPlatformGroups = [
      ...platform.groups,
      ...codexPlatform.groups,
      ...pixelPlatform.groups,
      ...agyPlatform.groups,
    ]
    const seenGroups = new Set<string>()
    for (const g of allPlatformGroups) {
      const key = String(g.id)
      if (seenGroups.has(key)) continue
      seenGroups.add(key)
      const list = platformModels([g])
      if (!list.length) continue
      out.push({
        id: `platform:${key}`,
        label: `${tr('modelChannels.tab.platform')} · ${g.name}`,
        models: list.map(id => ({
          target: { channel: 'platform', sourceId: key, model: id },
          label: id,
        })),
      })
    }
    return out
  }, [
    providers,
    codexCatalog,
    claudeCatalog,
    agyCatalog,
    platform.groups,
    codexPlatform.groups,
    pixelPlatform.groups,
    agyPlatform.groups,
  ])

  const [selectedGroupId, setSelectedGroupId] = useState<string>('')
  const activeGroup = groups.find(g => g.id === selectedGroupId) ?? groups[0] ?? null
  const [selectedModelKey, setSelectedModelKey] = useState<string>('')
  const activeOption =
    activeGroup?.models.find(m => modelDetailKey(m.target) === selectedModelKey) ?? activeGroup?.models[0] ?? null
  const activeKey = activeOption ? modelDetailKey(activeOption.target) : ''

  // 为当前选中的自定义/平台模型拉一次公开参考信息（受 cloudCatalog 开关控制）
  const [displayRefs, setDisplayRefs] = useState<Record<string, CloudModelReference>>({})
  const lookupIds = useMemo(() => {
    if (!activeOption || activeOption.reference) return []
    return [activeOption.target.model, activeOption.priceRef?.trim()].filter((v): v is string => !!v)
  }, [activeOption])
  const lookupKey = lookupIds.join('|')

  useEffect(() => {
    if (!cloudCatalog || !lookupKey || !bridge?.modelDisplayReferences) return
    let cancelled = false
    void bridge
      .modelDisplayReferences(lookupKey.split('|'))
      .then(refs => {
        if (!cancelled && refs && Object.keys(refs).length) setDisplayRefs(prev => ({ ...prev, ...refs }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [cloudCatalog, lookupKey])

  const activeReference = useMemo(() => {
    if (!cloudCatalog || !activeOption) return undefined
    return (
      activeOption.reference ??
      displayRefs[activeOption.target.model] ??
      (activeOption.priceRef ? displayRefs[activeOption.priceRef.trim()] : undefined)
    )
  }, [cloudCatalog, activeOption, displayRefs])

  const savedDetail = activeOption ? channelModelDetail(modelDetails, activeOption.target) : undefined
  const baselineGuide = activeOption
    ? modelRoleGuide(activeOption.target.model, undefined, activeReference?.description)
    : undefined
  const fallbackPrice = useMemo(() => {
    if (!activeOption) return undefined
    const cloudPrice = currentCloudModelPrice(activeReference)
    if (cloudPrice) return cloudPrice
    const id = activeOption.priceRef?.trim() || activeOption.target.model
    const isRelay = activeOption.target.channel === 'custom' || activeOption.target.channel === 'platform'
    return isRelay ? publicApiPriceReference(id) : openAiApiReference(id)
  }, [activeOption, activeReference])

  const [mainText, setMainText] = useState('')
  const [evalText, setEvalText] = useState('')
  const [currency, setCurrency] = useState<ModelTokenPrice['currency']>('USD')
  const [inputPrice, setInputPrice] = useState('')
  const [outputPrice, setOutputPrice] = useState('')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const syncSeed = JSON.stringify([activeKey, savedDetail ?? null, baselineGuide ?? null])
  useEffect(() => {
    setMainText(savedDetail?.main ?? baselineGuide?.main ?? '')
    setEvalText(savedDetail?.evaluator ?? baselineGuide?.evaluator ?? '')
    setCurrency(savedDetail?.price?.currency ?? 'USD')
    setInputPrice(savedDetail?.price ? String(savedDetail.price.input) : '')
    setOutputPrice(savedDetail?.price ? String(savedDetail.price.output) : '')
    setFeedback(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncSeed])

  const editedCount = Object.keys(modelDetails).length

  const toggleCloudCatalog = (enabled: boolean): void => {
    setFeedback(null)
    void bridge?.setCloudModelCatalog(enabled).catch(() => {
      setFeedback({ kind: 'err', text: tr('modelDetails.error') })
    })
  }

  const handleSave = async (): Promise<void> => {
    if (!activeOption || !bridge?.setModelDetail) return
    const parsedPrice = parsePrice(currency, inputPrice, outputPrice)
    if (parsedPrice === 'invalid') {
      setFeedback({ kind: 'err', text: tr('modelDetails.invalidPrice') })
      return
    }
    const detail: ModelDetail = {}
    const trimmedMain = mainText.trim()
    const trimmedEval = evalText.trim()
    if (trimmedMain && trimmedMain !== (baselineGuide?.main ?? '')) detail.main = trimmedMain
    if (trimmedEval && trimmedEval !== (baselineGuide?.evaluator ?? '')) detail.evaluator = trimmedEval
    if (parsedPrice) detail.price = parsedPrice
    setSaving(true)
    setFeedback(null)
    try {
      await bridge.setModelDetail({
        target: activeOption.target,
        detail: Object.keys(detail).length ? detail : null,
      })
      setFeedback({ kind: 'ok', text: tr('modelDetails.saved') })
    } catch {
      setFeedback({ kind: 'err', text: tr('modelDetails.error') })
    } finally {
      setSaving(false)
    }
  }

  const handleRestore = async (): Promise<void> => {
    if (!activeOption || !bridge?.setModelDetail) return
    setSaving(true)
    setFeedback(null)
    try {
      await bridge.setModelDetail({ target: activeOption.target, detail: null })
      setMainText(baselineGuide?.main ?? '')
      setEvalText(baselineGuide?.evaluator ?? '')
      setCurrency('USD')
      setInputPrice('')
      setOutputPrice('')
      setFeedback({ kind: 'ok', text: tr('modelDetails.restored') })
    } catch {
      setFeedback({ kind: 'err', text: tr('modelDetails.error') })
    } finally {
      setSaving(false)
    }
  }

  const fillReferencePrice = (): void => {
    if (!fallbackPrice) return
    setCurrency(fallbackPrice.currency)
    setInputPrice(String(fallbackPrice.input))
    setOutputPrice(String(fallbackPrice.output))
    setFeedback(null)
  }

  const channelLabelOf = (channel: ModelDetailChannel): string => tr(`modelChannels.tab.${channel}`)

  return (
    <div className="mt-6" data-setting-title={tr('modelDetails.title')}>
      <GroupTitle>{tr('modelDetails.title')}</GroupTitle>

      {/* 卡片 1：联网公开目录开关（方案 1 无边框卡片） */}
      <SettingGroup className="mt-3">
        <SettingRow
          title={tr('modelDetails.cloudToggleTitle')}
          description={tr('modelDetails.cloudToggleHint')}
          control={
            <Switch label={tr('modelDetails.cloudToggleTitle')} checked={cloudCatalog} onChange={toggleCloudCatalog} />
          }
        />
      </SettingGroup>

      {/* 卡片 2：按通道模型明细编辑器（方案 1 无边框卡片） */}
      <section className="mt-3 overflow-hidden rounded-xl bg-surface shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <h4 className="text-ui font-medium text-fg">{tr('modelDetails.title')}</h4>
            <p className="mt-0.5 text-meta text-fg-muted">{tr('modelDetails.hint')}</p>
          </div>
          {editedCount > 0 && (
            <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-label font-medium text-accent-fg tabular-nums">
              {tr('modelDetails.editedCount', { n: editedCount })}
            </span>
          )}
        </div>

        {!groups.length ? (
          <p className="px-5 pb-4 text-meta text-fg-faint">{tr('modelDetails.noModels')}</p>
        ) : (
          <div className="grid gap-4 px-5 pb-5 @2xl:grid-cols-[minmax(200px,0.72fr)_minmax(0,1.28fr)]">
            {/* 左列：通道标签 + 模型直选列表 */}
            <div className="flex min-w-0 flex-col gap-2.5">
              <div
                className="flex flex-wrap gap-1 rounded-lg bg-app p-1"
                role="tablist"
                aria-label={tr('modelDetails.channel')}
              >
                {groups.map(g => {
                  const active = g.id === activeGroup?.id
                  return (
                    <button
                      key={g.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        setSelectedGroupId(g.id)
                        setSelectedModelKey(g.models[0] ? modelDetailKey(g.models[0].target) : '')
                      }}
                      className={cn(
                        'min-w-0 flex-1 truncate rounded-md px-2 py-1 text-label transition-colors',
                        active ? 'bg-surface font-medium text-fg shadow-xs' : 'text-fg-muted hover:text-fg',
                      )}
                    >
                      {g.label}
                    </button>
                  )
                })}
              </div>

              <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-lg bg-app p-1">
                {activeGroup?.models.map(option => {
                  const key = modelDetailKey(option.target)
                  const selected = key === activeKey
                  const hasCustom = !!modelDetails[key]
                  const position = modelPositionLabel(option.target.model)
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedModelKey(key)}
                      className={cn(
                        'flex min-w-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-meta transition-colors',
                        selected ? 'bg-accent-soft font-medium text-accent-fg' : 'text-fg-secondary hover:bg-hover',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-label">{option.target.model}</span>
                        {hasCustom && (
                          <span
                            aria-label={tr('modelDetails.editedBadge')}
                            className="size-1.5 shrink-0 rounded-full bg-accent-fg"
                          />
                        )}
                      </span>
                      {position && (
                        <span className="shrink-0 rounded bg-subtle px-1.5 py-px text-label text-fg-muted">
                          {position}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 右列：当前模型参考信息与编辑表单 */}
            {activeOption && (
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-col gap-1 rounded-lg bg-app px-3 py-2.5 text-label text-fg-secondary">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono font-medium text-fg">
                      {channelLabelOf(activeOption.target.channel)} · {activeOption.target.model}
                    </span>
                    {fallbackPrice && (
                      <button
                        type="button"
                        onClick={fillReferencePrice}
                        className="rounded-md bg-accent-soft px-2 py-0.5 text-label font-medium text-accent-fg hover:opacity-90"
                      >
                        {tr('modelDetails.fillReference')}
                      </button>
                    )}
                  </div>
                  {!cloudCatalog ? (
                    <p className="text-fg-muted">{tr('modelDetails.cloudDisabled')}</p>
                  ) : (
                    <>
                      {activeReference?.description && (
                        <p className="text-fg-muted">
                          {tr('modelDetails.cloudDescription', { description: activeReference.description })}
                        </p>
                      )}
                      {fallbackPrice && (
                        <p className="text-fg-muted tabular-nums">
                          {tr('modelDetails.reference', {
                            model: activeOption.priceRef?.trim() || activeOption.target.model,
                            input: String(fallbackPrice.input),
                            output: String(fallbackPrice.output),
                          })}
                        </p>
                      )}
                    </>
                  )}
                </div>

                <div>
                  <label htmlFor="model-detail-main" className="mb-1 block text-label text-fg-muted">
                    {tr('modelDetails.main')}
                  </label>
                  <textarea
                    id="model-detail-main"
                    rows={2}
                    maxLength={MODEL_DETAIL_MAX_TEXT}
                    value={mainText}
                    onChange={e => setMainText(e.target.value)}
                    className={cn(INPUT, 'resize-y')}
                  />
                </div>

                <div>
                  <label htmlFor="model-detail-eval" className="mb-1 block text-label text-fg-muted">
                    {tr('modelDetails.evaluator')}
                  </label>
                  <textarea
                    id="model-detail-eval"
                    rows={2}
                    maxLength={MODEL_DETAIL_MAX_TEXT}
                    value={evalText}
                    onChange={e => setEvalText(e.target.value)}
                    className={cn(INPUT, 'resize-y')}
                  />
                </div>

                <div>
                  <div className="mb-1 text-label text-fg-muted">{tr('modelDetails.price')}</div>
                  <div className="grid grid-cols-[88px_1fr_1fr] gap-2">
                    <select
                      aria-label={tr('modelDetails.currency')}
                      value={currency}
                      onChange={e => setCurrency(e.target.value as ModelTokenPrice['currency'])}
                      className={INPUT}
                    >
                      {MODEL_PRICE_CURRENCIES.map(c => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={tr('modelDetails.input')}
                      placeholder={tr('modelDetails.input')}
                      inputMode="decimal"
                      value={inputPrice}
                      onChange={e => setInputPrice(e.target.value)}
                      className={cn(INPUT, 'tabular-nums')}
                    />
                    <input
                      aria-label={tr('modelDetails.output')}
                      placeholder={tr('modelDetails.output')}
                      inputMode="decimal"
                      value={outputPrice}
                      onChange={e => setOutputPrice(e.target.value)}
                      className={cn(INPUT, 'tabular-nums')}
                    />
                  </div>
                  <p className="mt-1 text-label text-fg-faint">{tr('modelDetails.priceHint')}</p>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button variant="primary" disabled={saving} onClick={() => void handleSave()}>
                    {tr('modelDetails.save')}
                  </Button>
                  <Button disabled={saving} onClick={() => void handleRestore()}>
                    {tr('modelDetails.restore')}
                  </Button>
                  {feedback && (
                    <span
                      role={feedback.kind === 'err' ? 'alert' : 'status'}
                      className={cn('text-meta', feedback.kind === 'err' ? 'text-danger' : 'text-accent-fg')}
                    >
                      {feedback.text}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
