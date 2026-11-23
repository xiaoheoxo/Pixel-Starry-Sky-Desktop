import { useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { ADVISOR_DIFFICULTIES, MAX_ADVISOR_EXTRA_MODELS, type SubagentAdvisor } from '@pixelsky/protocol'
import { bridge, useEngineState } from '@/features/engine'
import { useEngineCatalog } from '@/features/engine/catalog'
import { channelModelDetail, modelRoleGuide } from '@/features/model-channels/modelRoleGuide'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Segmented, Select, Switch } from '@/ui'

type DispatchChoice = 'suggest' | 'force'

const TIER_SUB_KEYS = {
  light: 'subagentRoute.advisor.lightSub',
  medium: 'subagentRoute.advisor.mediumSub',
  difficult: 'subagentRoute.advisor.difficultSub',
  expert: 'subagentRoute.advisor.expertSub',
} as const

/**
 * 设置 › 子智能体右侧栏的 Agnes 子智能体模型建议卡（docs/ui/agnes-model-guide-plan.md §2）：
 * - 方案 1 无边框色阶卡片（bg-surface + shadow-sm）；
 * - 去掉历史旧版「发消息前评估」，只留「建议 / 强制」两档 Segmented；
 * - 4 档难度模型 2×2 紧凑网格；进阶选型与额外候选池折叠收纳。
 */
export function AgnesAdvisorCard() {
  useI18n()
  const config = useEngineState(s => s.config?.codex ?? null)
  const modelDetails = useEngineState(s => s.modelDetails)
  const models = useEngineCatalog('codex')?.models ?? []
  const advisor = config?.subagentAdvisor ?? null
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const guide = (model: string) =>
    modelRoleGuide(model, channelModelDetail(modelDetails, { channel: 'chatgpt', sourceId: null, model }))

  const save = (patch: { subagentAdvisor: SubagentAdvisor | null }): void => {
    setError(null)
    void bridge
      ?.setConfig('codex', patch)
      .catch((e: Error) => setError(tr('subagentRoute.saveFailed', { error: e.message })))
  }

  const dispatchMode: DispatchChoice = advisor?.dispatchMode === 'force' ? 'force' : 'suggest'
  const extraModels = advisor?.extraModels ?? []
  const configuredTierModels = new Set((advisor?.models ?? []).filter((id): id is string => !!id))
  const extraCandidates = models.filter(m => !configuredTierModels.has(m.id) && !extraModels.includes(m.id))

  return (
    <section className="rounded-xl bg-surface shadow-sm" data-setting-title={tr('subagentRoute.advisor.title')}>
      <div className="divide-y divide-line-subtle/60">
        {/* 总开关 */}
        <div className="flex items-start justify-between gap-4 px-4 py-3.5">
          <div className="min-w-0">
            <h4 className="text-ui font-semibold text-fg">{tr('subagentRoute.advisor.title')}</h4>
            <p className="mt-0.5 text-label text-fg-muted">{tr('subagentRoute.advisor.hint')}</p>
          </div>
          <Switch
            label={tr('subagentRoute.advisor.title')}
            checked={!!advisor}
            onChange={on =>
              save({
                subagentAdvisor: on
                  ? { evaluator: null, dispatchMode: 'suggest', models: [null, null, null, null] }
                  : null,
              })
            }
          />
        </div>

        {advisor && (
          <>
            {/* 派遣执行方式：建议 / 强制 两档 */}
            <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-meta font-medium text-fg">{tr('subagentRoute.advisor.dispatchMode')}</div>
                <p className="mt-0.5 text-label text-fg-muted">
                  {tr(
                    dispatchMode === 'force'
                      ? 'subagentRoute.advisor.dispatchForceHint'
                      : 'subagentRoute.advisor.dispatchSuggestHint',
                  )}
                </p>
              </div>
              <Segmented<DispatchChoice>
                label={tr('subagentRoute.advisor.dispatchMode')}
                value={dispatchMode}
                onChange={next =>
                  save({
                    subagentAdvisor: { ...advisor, dispatchMode: next },
                  })
                }
                options={[
                  { value: 'suggest', label: tr('subagentRoute.advisor.dispatchSuggestShort') },
                  { value: 'force', label: tr('subagentRoute.advisor.dispatchForceShort') },
                ]}
              />
            </div>

            {/* 难度评估方式 */}
            <div className="space-y-2 px-4 py-3">
              <div className="text-meta font-medium text-fg">{tr('subagentRoute.advisor.evaluator')}</div>
              <Select
                label={tr('subagentRoute.advisor.evaluator')}
                value={advisor.evaluator ?? ''}
                onChange={id =>
                  save({
                    subagentAdvisor: {
                      ...advisor,
                      dispatchMode,
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
              <p className="text-label text-fg-muted">
                {tr(advisor.evaluator ? 'subagentRoute.advisor.remoteHint' : 'subagentRoute.advisor.localHint')}
              </p>
            </div>

            {/* 2×2 四档难度模型网格 */}
            <div className="px-4 py-3">
              <div className="grid grid-cols-1 gap-2 @md:grid-cols-2">
                {ADVISOR_DIFFICULTIES.map((tier, index) => {
                  const value = advisor.models[index] ?? ''
                  return (
                    <div key={tier} className="rounded-lg bg-app p-2.5">
                      <div className="mb-1.5 flex items-baseline justify-between gap-2">
                        <span className="text-label font-medium text-fg">{tr(`subagentRoute.advisor.${tier}`)}</span>
                        <span className="truncate text-label text-fg-faint">{tr(TIER_SUB_KEYS[tier])}</span>
                      </div>
                      <Select
                        label={tr(`subagentRoute.advisor.${tier}`)}
                        mono
                        value={value}
                        placeholder={value}
                        onChange={id => {
                          const nextModels: [string | null, string | null, string | null, string | null] = [
                            advisor.models[0] ?? null,
                            advisor.models[1] ?? null,
                            advisor.models[2] ?? null,
                            advisor.models[3] ?? null,
                          ]
                          nextModels[index] = id || null
                          save({ subagentAdvisor: { ...advisor, dispatchMode, models: nextModels } })
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

              {/* 进阶折叠区：仅选独立评估模型时显示 */}
              {advisor.evaluator && (
                <div className="mt-3 rounded-lg bg-app px-3 py-2.5">
                  <button
                    type="button"
                    aria-expanded={advancedOpen}
                    onClick={() => setAdvancedOpen(v => !v)}
                    className="flex w-full items-center justify-between gap-2 text-left text-meta font-medium text-fg-secondary hover:text-fg"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{tr('subagentRoute.advisor.advanced')}</span>
                      {extraModels.length > 0 && (
                        <span className="shrink-0 rounded bg-subtle px-1.5 py-px text-label text-fg-muted tabular-nums">
                          {tr('subagentRoute.advisor.advancedCount', { n: extraModels.length })}
                        </span>
                      )}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-label text-fg-muted">
                      {tr(advancedOpen ? 'subagentRoute.advisor.collapse' : 'subagentRoute.advisor.expand')}
                      {advancedOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </span>
                  </button>

                  {advancedOpen && (
                    <div className="mt-3 space-y-3 border-t border-line-subtle/60 pt-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-meta font-medium text-fg">
                            {tr('subagentRoute.advisor.evaluatorPicksModel')}
                          </div>
                          <p className="mt-0.5 text-label text-fg-muted">
                            {tr('subagentRoute.advisor.evaluatorPicksHint')}
                          </p>
                        </div>
                        <Switch
                          label={tr('subagentRoute.advisor.evaluatorPicksModel')}
                          checked={advisor.evaluatorPicksModel === true}
                          onChange={on =>
                            save({
                              subagentAdvisor: {
                                ...advisor,
                                dispatchMode,
                                evaluatorPicksModel: on ? true : undefined,
                              },
                            })
                          }
                        />
                      </div>

                      {advisor.evaluatorPicksModel === true && (
                        <div className="space-y-2">
                          <div>
                            <div className="text-label font-medium text-fg-secondary">
                              {tr('subagentRoute.advisor.extraModels')}
                            </div>
                            <p className="mt-0.5 text-label text-fg-faint">
                              {tr('subagentRoute.advisor.extraHint', { max: MAX_ADVISOR_EXTRA_MODELS })}
                            </p>
                          </div>

                          {extraModels.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {extraModels.map(id => (
                                <span
                                  key={id}
                                  className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 font-mono text-label text-fg-secondary shadow-xs"
                                >
                                  {id}
                                  <button
                                    type="button"
                                    aria-label={tr('subagentRoute.advisor.removeModel', { id })}
                                    onClick={() =>
                                      save({
                                        subagentAdvisor: {
                                          ...advisor,
                                          dispatchMode,
                                          extraModels: extraModels.filter(item => item !== id),
                                        },
                                      })
                                    }
                                    className="text-fg-faint hover:text-danger"
                                  >
                                    <X size={11} />
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}

                          {extraModels.length < MAX_ADVISOR_EXTRA_MODELS && extraCandidates.length > 0 && (
                            <Select
                              label={tr('subagentRoute.advisor.addModel')}
                              mono
                              value=""
                              placeholder={tr('subagentRoute.advisor.addModel')}
                              onChange={id => {
                                if (!id) return
                                save({
                                  subagentAdvisor: {
                                    ...advisor,
                                    dispatchMode,
                                    extraModels: [...extraModels, id],
                                  },
                                })
                              }}
                              options={[
                                { value: '', label: tr('subagentRoute.advisor.addModel') },
                                ...extraCandidates.map(m => ({
                                  value: m.id,
                                  label: m.label || m.id,
                                  description: guide(m.id)?.main,
                                })),
                              ]}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {error && (
          <p role="alert" className="px-4 py-2.5 text-meta text-danger">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}
