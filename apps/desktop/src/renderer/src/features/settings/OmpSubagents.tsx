// 设置 › 子智能体 › oh-my-pi（docs/omp-engine.md §18，样稿 docs/ui/omp-subagent-effort-mockup.html）：
// omp 自带的各类型用什么模型、想多深；工具和提示词归 omp 自己管
import { SUBAGENT_EFFORTS, type Effort } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Segmented, Select, cn } from '@/ui'
import { effortLabel } from '@/features/engine/labels'
import { siteKey, targetProblem } from './subagents'
import type { SiteContext } from './SubagentTypeCard'
import {
  OMP_SUBAGENT_PRESETS,
  OMP_SUBAGENT_TYPES,
  ompPresetOf,
  withOmpPreset,
  type OmpSubagentEffort,
  type OmpSubagentPreset,
  type OmpSubagentRule,
  type OmpSubagentSettings,
  type OmpSubagentType,
  type SubagentTarget,
} from '../../../../shared/types/subagents'

const PRESETS = Object.keys(OMP_SUBAGENT_PRESETS) as OmpSubagentPreset[]
const typeKey = (type: OmpSubagentType) => (type === '*' ? 'other' : type)

// 带上账号：换了平台账号后，存着的旧账号那个和现在的是两项
const targetKey = (t: SubagentTarget): string => `${siteKey(t)}|${t.kind === 'platform' ? t.account : ''}|${t.model}`

/** 能选的模型：各自定义接口、各平台线路的；存着的那个不在里面时补上（显示得出来、看得到不能用） */
export function ompModelTargets(sites: SiteContext, current: SubagentTarget | null): Map<string, SubagentTarget> {
  const out = new Map<string, SubagentTarget>()
  const email = sites.platform.email
  const add = (t: SubagentTarget) => out.set(targetKey(t), t)
  if (email)
    for (const g of sites.groups)
      for (const model of g.models) add({ kind: 'platform', groupId: g.id, account: email, model })
  for (const p of sites.providers) for (const m of p.models) add({ kind: 'custom', providerId: p.id, model: m.id })
  if (current) out.set(targetKey(current), current)
  return out
}

function siteLabel(t: SubagentTarget, sites: SiteContext): string {
  return (
    (t.kind === 'custom'
      ? sites.providers.find(p => p.id === t.providerId)?.name
      : sites.platform.groups.find(g => g.id === t.groupId)?.name) ?? tr('subagentRoute.siteBroken')
  )
}

function EffortStrip({
  label,
  value,
  max,
  onChange,
}: {
  label: string
  value: OmpSubagentEffort
  /** 按任务时最高能选到的档 */
  max: Effort
  onChange: (value: OmpSubagentEffort) => void
}) {
  const item = (v: OmpSubagentEffort, text: string, title: string, className: string, soft = false) => (
    <button
      key={v}
      type="button"
      role="radio"
      aria-checked={v === value}
      title={title}
      onClick={() => onChange(v)}
      className={cn(
        'press h-7 min-w-0 px-1.5 text-meta whitespace-nowrap',
        className,
        v === value
          ? 'bg-accent font-medium text-accent-on'
          : soft
            ? 'bg-accent-soft text-accent-fg'
            : 'bg-subtle text-fg-secondary hover:bg-selected hover:text-fg',
      )}
    >
      {text}
    </button>
  )
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {item('follow', tr('ompSubagents.follow'), tr('ompSubagents.followTip'), 'rounded-md')}
      {item('pick', tr('ompSubagents.pick'), tr('ompSubagents.pickTip'), 'rounded-md')}
      <span className="flex min-w-60 flex-1 gap-px overflow-hidden rounded-md">
        {SUBAGENT_EFFORTS.map((e, i) =>
          item(e, effortLabel(e), effortLabel(e), 'flex-1', value === 'pick' && i <= SUBAGENT_EFFORTS.indexOf(max)),
        )}
      </span>
      {item('omp', tr('ompSubagents.omp'), tr('ompSubagents.ompTip'), 'rounded-md')}
    </div>
  )
}

export function OmpSubagents({
  settings,
  sites,
  onChange,
}: {
  settings: OmpSubagentSettings
  sites: SiteContext
  onChange: (next: OmpSubagentSettings) => void
}) {
  useI18n()
  const preset = ompPresetOf(settings)
  const setRule = (type: OmpSubagentType, patch: Partial<OmpSubagentRule>) =>
    onChange({ ...settings, types: { ...settings.types, [type]: { ...settings.types[type], ...patch } } })
  return (
    <div data-omp-subagents="" className="mt-6">
      <h4 data-setting-title={tr('ompSubagents.title')} className="text-ui font-semibold text-fg">
        {tr('ompSubagents.title')}
      </h4>
      <p className="mt-0.5 text-meta text-fg-muted">{tr('ompSubagents.hint')}</p>

      <div
        role="radiogroup"
        aria-label={tr('ompSubagents.presets')}
        className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2"
      >
        {PRESETS.map(p => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={p === preset}
            data-omp-preset={p}
            onClick={() => onChange(withOmpPreset(settings, p))}
            className={cn(
              'rounded-lg border px-3 py-2 text-left',
              p === preset ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-hover',
            )}
          >
            <span className="block font-medium text-fg">{tr(`ompSubagents.preset.${p}`)}</span>
            <span className="block text-meta text-fg-muted">{tr(`ompSubagents.preset.${p}Hint`)}</span>
          </button>
        ))}
      </div>

      <div className="mt-3 divide-y divide-line-subtle rounded-xl bg-surface shadow-sm">
        {OMP_SUBAGENT_TYPES.map(type => {
          const rule = settings.types[type]
          const name = tr(`ompSubagents.type.${typeKey(type)}`)
          const targets = ompModelTargets(sites, rule.target)
          const problem = rule.target ? targetProblem(rule.target, sites.providers, sites.platform) : null
          return (
            <div
              key={type}
              data-omp-subagent={type}
              className="grid items-center gap-x-4 gap-y-2 px-4 py-3 @3xl:grid-cols-[minmax(7rem,1fr)_9rem_26rem]"
            >
              <div className="min-w-0">
                <span className="font-semibold text-fg">{name}</span>
                {type !== '*' && <span className="ml-1.5 font-mono text-label text-fg-faint">{type}</span>}
                <p className="text-meta text-fg-muted">{tr(`ompSubagents.type.${typeKey(type)}Hint`)}</p>
              </div>
              <Select
                label={tr('ompSubagents.modelOf', { name })}
                className="w-full"
                fitContent
                value={rule.target ? targetKey(rule.target) : ''}
                onChange={key => setRule(type, { target: targets.get(key) ?? null })}
                options={[
                  { value: '', label: tr('ompSubagents.followModel') },
                  ...[...targets].map(([value, t]) => ({ value, label: t.model, hint: siteLabel(t, sites) })),
                ]}
              />
              <EffortStrip
                label={tr('ompSubagents.effortOf', { name })}
                value={rule.effort}
                max={settings.maxEffort}
                onChange={effort => setRule(type, { effort })}
              />
              {problem && (
                <p className="col-span-full text-meta text-danger">
                  {tr('ompSubagents.broken', { model: rule.target!.model })}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {OMP_SUBAGENT_TYPES.some(t => settings.types[t].effort === 'pick') && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-meta text-fg-secondary">{tr('ompSubagents.max')}</span>
          <Segmented<Effort>
            label={tr('ompSubagents.max')}
            value={settings.maxEffort}
            onChange={maxEffort => onChange({ ...settings, maxEffort })}
            options={SUBAGENT_EFFORTS.map(e => ({ value: e, label: effortLabel(e) }))}
          />
        </div>
      )}
      <p className="mt-3 text-meta text-fg-muted">{tr('ompSubagents.applyHint')}</p>
      <p className="mt-1 text-meta text-fg-faint">{tr('ompSubagents.modelHint')}</p>
    </div>
  )
}
