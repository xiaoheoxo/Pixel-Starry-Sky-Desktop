// 设置 › 本机引擎 › Codex › Codex 子智能体（docs/ui/codex-subagent-model.md）：Codex 派出的子智能体统一用哪个模型 / 强度，
// 主会话不变。存在引擎级设置（engine:setConfig 的 subagentModel / subagentEffort），启动 Codex 时经 agents.default_subagent_* 传给它
import type { Effort, SubagentAdvisor } from '@pixelsky/protocol'
import { bridge, useEngineState } from '@/features/engine'
import { useEngineCatalog } from '@/features/engine/catalog'
import { effortLabel } from '@/features/engine/labels'
import { modelRoleGuide } from '@/features/model-channels/modelRoleGuide'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Select, Switch } from '@/ui'

export function CodexSubagentCard({ onError }: { onError: (message: string | null) => void }) {
  useI18n()
  const config = useEngineState(s => s.config?.codex ?? null)
  const catalog = useEngineCatalog('codex')
  const models = catalog?.models ?? []
  const model = config?.subagentModel ?? ''
  const advisor = config?.subagentAdvisor ?? null
  const efforts = models.find(m => m.id === model)?.efforts ?? []
  const save = (patch: {
    subagentModel?: string | null
    subagentEffort?: Effort | null
    subagentAdvisor?: SubagentAdvisor | null
  }): void => {
    onError(null)
    void bridge
      ?.setConfig('codex', patch)
      .catch((e: Error) => onError(tr('subagentRoute.saveFailed', { error: e.message })))
  }
  return (
    <div className="rounded-xl border border-line-card bg-surface">
      <h4 data-setting-title={tr('subagentRoute.codex.title')} className="px-4 pt-3 text-ui font-semibold text-fg">
        {tr('subagentRoute.codex.title')}
      </h4>
      <p className="px-4 pt-1 text-label text-fg-muted">{tr('subagentRoute.codex.hint')}</p>
      <div className="flex flex-wrap gap-2 px-4 py-3">
        <Select
          label={tr('subagentRoute.codex.model')}
          className="min-w-0 flex-1"
          mono
          value={model}
          placeholder={model}
          onChange={id => save({ subagentModel: id || null, ...(id ? {} : { subagentEffort: null }) })}
          options={[
            { value: '', label: tr('subagentRoute.codex.follow') },
            ...models.map(m => ({ value: m.id, label: m.label || m.id })),
          ]}
        />
        {model && (
          <Select<Effort | ''>
            label={tr('subagentRoute.effort.title')}
            className="min-w-0 flex-1"
            value={config?.subagentEffort ?? ''}
            disabled={!efforts.length}
            onChange={e => save({ subagentEffort: e || null })}
            options={[
              { value: '', label: tr('subagentRoute.codex.follow') },
              ...efforts.map(e => ({ value: e, label: effortLabel(e) })),
            ]}
          />
        )}
      </div>
      <div className="@container space-y-2 border-t border-line-card px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h5 className="text-ui font-medium">{tr('subagentRoute.advisor.title')}</h5>
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
                  description: modelRoleGuide(m.id)?.evaluator,
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
                          description: modelRoleGuide(m.id)?.main,
                        })),
                      ]}
                    />
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
      {!models.length && <p className="px-4 pb-3 text-label text-fg-faint">{tr('subagentRoute.codex.noCatalog')}</p>}
    </div>
  )
}
