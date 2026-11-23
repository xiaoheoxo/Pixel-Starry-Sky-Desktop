import { useState } from 'react'
import { MAX_ADVISOR_EXTRA_MODELS, type SubagentAdvisor } from '@pixelsky/protocol'
import { bridge, useEngineState } from '@/features/engine'
import { useEngineCatalog } from '@/features/engine/catalog'
import { channelModelDetail, modelRoleGuide } from '@/features/model-channels/modelRoleGuide'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Select, Switch } from '@/ui'

export function AgnesAdvisorCard() {
  useI18n()
  const config = useEngineState(s => s.config?.codex ?? null)
  const models = useEngineCatalog('codex')?.models ?? []
  const advisor = config?.subagentAdvisor ?? null
  const [error, setError] = useState<string | null>(null)
  const guide = (model: string) =>
    modelRoleGuide(model, channelModelDetail(config?.modelDetails, { channel: 'chatgpt', sourceId: null, model }))
  const save = (patch: { subagentAdvisor: SubagentAdvisor | null }): void => {
    setError(null)
    void bridge
      ?.setConfig('codex', patch)
      .catch((e: Error) => setError(tr('subagentRoute.saveFailed', { error: e.message })))
  }

  return (
    <section className="rounded-xl border border-line-card bg-surface">
      <div className="@container space-y-2 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 data-setting-title={tr('subagentRoute.advisor.title')} className="text-ui font-semibold text-fg">
              {tr('subagentRoute.advisor.title')}
            </h4>
            <p className="mt-1 text-label text-fg-muted">{tr('subagentRoute.advisor.hint')}</p>
          </div>
          <Switch
            label={tr('subagentRoute.advisor.title')}
            checked={!!advisor}
            onChange={on => save({ subagentAdvisor: on ? { evaluator: null, models: [null, null, null] } : null })}
          />
        </div>
        {advisor && (
          <>
            <div className="text-label text-fg-muted">{tr('subagentRoute.advisor.evaluator')}</div>
            <p className="text-label text-fg-faint">{tr('subagentRoute.advisor.catalogHint')}</p>
            <Select
              label={tr('subagentRoute.advisor.evaluator')}
              value={advisor.evaluator ?? ''}
              onChange={id =>
                save({
                  subagentAdvisor: {
                    ...advisor,
                    evaluator: id || null,
                    evaluatorPicksModel: id && id === advisor.evaluator ? advisor.evaluatorPicksModel : undefined,
                  },
                })
              }
              options={[
                { value: '', label: tr('subagentRoute.advisor.local') },
                ...models.map(m => ({
                  value: m.id,
                  label: m.label || m.id,
                  description: guide(m.id)?.evaluator,
                })),
              ]}
            />
            {advisor.evaluator && (
              <>
                <p className="text-label text-fg-muted">{tr('subagentRoute.advisor.remoteHint')}</p>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-ui font-medium">{tr('subagentRoute.advisor.evaluatorPicksModel')}</div>
                    <p className="mt-1 text-label text-fg-muted">{tr('subagentRoute.advisor.evaluatorPicksHint')}</p>
                  </div>
                  <Switch
                    label={tr('subagentRoute.advisor.evaluatorPicksModel')}
                    checked={advisor.evaluatorPicksModel === true}
                    onChange={on =>
                      save({ subagentAdvisor: { ...advisor, evaluatorPicksModel: on ? true : undefined } })
                    }
                  />
                </div>
              </>
            )}
            <div className="grid grid-cols-1 gap-2 @[550px]:grid-cols-3">
              {([0, 1, 2] as const).map(i => {
                const key = (['light', 'medium', 'difficult'] as const)[i]
                const label = tr(`subagentRoute.advisor.${key}`)
                return (
                  <div key={key} className="min-w-0">
                    <div className="mb-1 text-label text-fg-muted">{label}</div>
                    <Select
                      label={label}
                      value={advisor.models[i] ?? ''}
                      onChange={id => {
                        const next: SubagentAdvisor['models'] = [...advisor.models]
                        next[i] = id || null
                        save({ subagentAdvisor: { ...advisor, models: next } })
                      }}
                      options={[
                        { value: '', label: tr('subagentRoute.advisor.noAdvice') },
                        ...models.map(m => ({
                          value: m.id,
                          label: m.label || m.id,
                          description: guide(m.id)?.main,
                        })),
                      ]}
                    />
                  </div>
                )
              })}
            </div>
            {advisor.evaluator && advisor.evaluatorPicksModel && (
              <div className="space-y-1.5">
                <div className="text-label text-fg-muted">{tr('subagentRoute.advisor.extraModels')}</div>
                <p className="text-label text-fg-faint">
                  {tr('subagentRoute.advisor.extraHint', { max: MAX_ADVISOR_EXTRA_MODELS })}
                </p>
                {!!advisor.extraModels?.length && (
                  <ul className="flex flex-wrap gap-1.5">
                    {advisor.extraModels.map(id => (
                      <li
                        key={id}
                        className="flex min-w-0 items-center gap-1 rounded-md border border-line-card px-2 py-1 text-label"
                      >
                        <span className="truncate">{models.find(model => model.id === id)?.label ?? id}</span>
                        <button
                          type="button"
                          className="shrink-0 px-1 text-fg-muted hover:text-fg"
                          aria-label={tr('subagentRoute.advisor.removeModel', { id })}
                          onClick={() =>
                            save({
                              subagentAdvisor: {
                                ...advisor,
                                extraModels: advisor.extraModels?.filter(model => model !== id),
                              },
                            })
                          }
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {(advisor.extraModels?.length ?? 0) < MAX_ADVISOR_EXTRA_MODELS && (
                  <Select
                    label={tr('subagentRoute.advisor.addModel')}
                    value=""
                    onChange={id => {
                      if (id)
                        save({ subagentAdvisor: { ...advisor, extraModels: [...(advisor.extraModels ?? []), id] } })
                    }}
                    options={[
                      { value: '', label: tr('subagentRoute.advisor.addModel') },
                      ...models
                        .filter(m => !advisor.models.includes(m.id) && !advisor.extraModels?.includes(m.id))
                        .map(m => ({
                          value: m.id,
                          label: m.label || m.id,
                          description: guide(m.id)?.main,
                        })),
                    ]}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
      {advisor && !models.length && (
        <p className="px-4 pb-3 text-label text-fg-faint">{tr('subagentRoute.codex.noCatalog')}</p>
      )}
      {error && (
        <p role="alert" className="px-4 pb-3 text-meta text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
