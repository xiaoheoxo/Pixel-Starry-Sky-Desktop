// 设置 › 子智能体的「主模型调度」（docs/ui/subagent-model-dispatch.md，样式稿 subagent-model-dispatch-mockup.html）：
// 按主模型写规则，右边预览换一个主模型时它会拿到什么；预览和实际走同一份 resolveDispatch
import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Button, Segmented, Select, Switch, cn } from '@/ui'
import { formatMultiplier } from '@/features/account/platform'
import { dispatchCatalog, siteKey } from './subagents'
import type { SiteContext } from './SubagentTypeCard'
import { OUTSIDE_OFF, resolveDispatch, sameSite, siteOfTarget } from '../../../../shared/subagent-dispatch'
import {
  SUBAGENT_LIMITS,
  type SubagentDispatch,
  type SubagentDispatchCandidate,
  type SubagentDispatchRule,
  type SubagentSite,
  type SubagentTarget,
} from '../../../../shared/types/subagents'

interface SiteEntry {
  site: SubagentSite
  name: string
  /** 倍率（平台线路）或「自定义接口」 */
  rate: string
  models: readonly string[]
}

/** 选项的值：分组和模型（模型名不含空白，分组标识里没有 |） */
const optionKey = (site: SubagentSite, model: string): string => `${siteKey(site)}|${model}`

function siteEntries(sites: SiteContext): SiteEntry[] {
  return [
    ...sites.groups.map(g => ({
      site: { kind: 'platform', groupId: g.id } as const,
      name: g.name,
      rate: formatMultiplier(g.rate_multiplier),
      models: g.models,
    })),
    ...sites.providers.map(p => ({
      site: { kind: 'custom', providerId: p.id } as const,
      name: p.name,
      rate: tr('subagentRoute.dispatch.customSite'),
      models: p.models.map(m => m.id),
    })),
  ]
}

export function SubagentDispatchEditor({
  value,
  onChange,
  sites,
  openChannels,
}: {
  value: SubagentDispatch
  onChange: (next: SubagentDispatch) => void
  sites: SiteContext
  openChannels: () => void
}) {
  useI18n()
  const entries = siteEntries(sites)
  const email = sites.platform.email
  const entryOf = (site: SubagentSite): SiteEntry | undefined => entries.find(e => sameSite(e.site, site))
  const allOptions = entries.flatMap(e =>
    e.models.map(model => ({ key: optionKey(e.site, model), site: e.site, model, name: e.name })),
  )
  const [tryKey, setTryKey] = useState<string | null>(null)

  const setRule = (index: number, patch: Partial<SubagentDispatchRule>): void =>
    onChange({ ...value, rules: value.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) })
  const setCandidates = (index: number, candidates: SubagentDispatchCandidate[]): void => setRule(index, { candidates })
  const usedMains = new Set(value.rules.map(r => optionKey(r.main.site, r.main.model)))

  if (!allOptions.length && !value.rules.length)
    return (
      <div className="mt-2 text-meta text-fg-muted">
        <p>{tr('subagentRoute.empty')}</p>
        <Button className="mt-2" onClick={openChannels}>
          {tr('subagentRoute.openChannels')}
        </Button>
      </div>
    )

  const targetOf = (site: SubagentSite, model: string): SubagentTarget | null =>
    site.kind === 'custom'
      ? { kind: 'custom', providerId: site.providerId, model }
      : email
        ? { kind: 'platform', groupId: site.groupId, account: email, model }
        : null

  const addRule = (): void => {
    const free = allOptions.find(o => !usedMains.has(o.key))
    if (free)
      onChange({ ...value, rules: [...value.rules, { main: { site: free.site, model: free.model }, candidates: [] }] })
  }

  // 预览：选过的，否则第一条规则的主模型，否则第一个模型
  const firstRule = value.rules[0]
  const preview =
    allOptions.find(o => o.key === tryKey) ??
    (firstRule ? allOptions.find(o => o.key === optionKey(firstRule.main.site, firstRule.main.model)) : undefined) ??
    allOptions[0]

  return (
    <div
      data-subagent-dispatch=""
      className="mt-2 grid items-start gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,19rem),1fr))]"
    >
      <div className="min-w-0">
        {value.rules.map((rule, ri) => (
          <RuleCard
            key={optionKey(rule.main.site, rule.main.model)}
            rule={rule}
            index={ri}
            dispatch={value}
            sites={sites}
            entries={entries}
            usedMains={usedMains}
            entryOf={entryOf}
            targetOf={targetOf}
            setRule={setRule}
            setCandidates={setCandidates}
            onRemove={() => onChange({ ...value, rules: value.rules.filter((_, i) => i !== ri) })}
          />
        ))}
        <Button
          icon={Plus}
          variant="ghost"
          disabled={value.rules.length >= SUBAGENT_LIMITS.dispatchRules || allOptions.every(o => usedMains.has(o.key))}
          onClick={addRule}
        >
          {tr(value.rules.length ? 'subagentRoute.dispatch.addAnotherRule' : 'subagentRoute.dispatch.addRule')}
        </Button>
        <div className="mt-2 divide-y divide-line-subtle rounded-lg border border-line-subtle">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5">
            <div className="min-w-0 flex-1 basis-40">
              <div className="text-meta font-medium text-fg">{tr('subagentRoute.dispatch.unruled')}</div>
              <p className="mt-0.5 text-label text-fg-muted">{tr('subagentRoute.dispatch.unruledHint')}</p>
            </div>
            <Segmented<SubagentDispatch['unruled']>
              label={tr('subagentRoute.dispatch.unruled')}
              value={value.unruled}
              onChange={unruled => onChange({ ...value, unruled })}
              options={[
                { value: 'cheaper', label: tr('subagentRoute.dispatch.cheaper') },
                { value: 'self', label: tr('subagentRoute.dispatch.self') },
              ]}
            />
          </div>
          <div className="flex items-start justify-between gap-4 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-meta font-medium text-fg">{tr('subagentRoute.dispatch.outside')}</div>
              <p className="mt-0.5 text-label text-fg-muted">{tr('subagentRoute.dispatch.outsideHint')}</p>
            </div>
            <Switch
              label={tr('subagentRoute.dispatch.outside')}
              checked={value.outsideGroup}
              onChange={outsideGroup => onChange({ ...value, outsideGroup })}
            />
          </div>
        </div>
        <p className="mt-2 text-label text-fg-faint">{tr('subagentRoute.dispatch.applyHint')}</p>
      </div>
      {preview && (
        <Preview
          dispatch={value}
          sites={sites}
          current={preview}
          options={allOptions}
          onPick={setTryKey}
          entryOf={entryOf}
        />
      )}
    </div>
  )
}

function RuleCard({
  rule,
  index,
  dispatch,
  sites,
  entries,
  usedMains,
  entryOf,
  targetOf,
  setRule,
  setCandidates,
  onRemove,
}: {
  rule: SubagentDispatchRule
  index: number
  dispatch: SubagentDispatch
  sites: SiteContext
  entries: readonly SiteEntry[]
  usedMains: ReadonlySet<string>
  entryOf: (site: SubagentSite) => SiteEntry | undefined
  targetOf: (site: SubagentSite, model: string) => SubagentTarget | null
  setRule: (index: number, patch: Partial<SubagentDispatchRule>) => void
  setCandidates: (index: number, candidates: SubagentDispatchCandidate[]) => void
  onRemove: () => void
}) {
  const site = rule.main.site
  const entry = entryOf(site)
  const mainKey = optionKey(site, rule.main.model)
  const known = entries.some(e => sameSite(e.site, site) && e.models.includes(rule.main.model))
  const mainOptions = [
    // 线路、接口没了也要能看到这条规则写的是谁
    ...(known ? [] : [{ value: mainKey, label: rule.main.model, hint: tr('subagentRoute.dispatch.unavailableShort') }]),
    ...entries.flatMap(e =>
      e.models.map(model => {
        const key = optionKey(e.site, model)
        return { value: key, label: model, hint: e.name, disabled: key !== mainKey && usedMains.has(key) }
      }),
    ),
  ]
  const taken = new Set(rule.candidates.map(c => c.target.model))
  const addOptions = [...entries]
    // 主模型所在的分组排最前
    .sort((a, b) => Number(sameSite(b.site, site)) - Number(sameSite(a.site, site)))
    .flatMap(e => {
      const inside = sameSite(e.site, site)
      return e.models
        .filter(model => !taken.has(model) && targetOf(e.site, model))
        .map(model => ({
          value: optionKey(e.site, model),
          label: model,
          hint: inside
            ? model === rule.main.model
              ? tr('subagentRoute.dispatch.mainItself')
              : tr('subagentRoute.dispatch.sameGroup')
            : `${e.name} ${e.rate}`,
          disabled: !inside && !dispatch.outsideGroup,
          ...(!inside && !dispatch.outsideGroup ? { description: tr('subagentRoute.dispatch.turnOnOutside') } : {}),
        }))
    })
  const catalog = dispatchCatalog(site, sites)
  return (
    <div data-dispatch-rule={rule.main.model} className="mb-2 rounded-lg border border-line bg-app">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-2 text-meta text-fg-muted">
        {tr('subagentRoute.dispatch.mainIs')}
        <Select
          label={tr('subagentRoute.dispatch.mainModel')}
          className="min-w-44 flex-1"
          mono
          value={mainKey}
          options={mainOptions}
          onChange={key => {
            const hit = entries.flatMap(e => e.models.map(m => ({ e, m }))).find(x => optionKey(x.e.site, x.m) === key)
            if (hit) setRule(index, { main: { site: hit.e.site, model: hit.m } })
          }}
        />
        {entry && (
          <span className="whitespace-nowrap text-label text-fg-faint">
            {entry.name} · {entry.rate}
          </span>
        )}
        <button
          type="button"
          aria-label={tr('subagentRoute.dispatch.removeRule')}
          onClick={onRemove}
          className="grid size-6 place-items-center rounded-md text-fg-faint hover:bg-hover"
        >
          <X size={14} />
        </button>
      </div>
      <div className="px-3 py-2">
        <div className="mb-1.5 text-label text-fg-muted">{tr('subagentRoute.dispatch.canPick')}</div>
        {rule.candidates.length === 0 && (
          <p className="mb-1.5 text-label text-fg-faint">{tr('subagentRoute.dispatch.noCandidates')}</p>
        )}
        {rule.candidates.map((c, ci) => {
          const outside = !sameSite(siteOfTarget(c.target), site)
          const off = outside && !dispatch.outsideGroup
          const broken = catalog.problem(c.target)
          const other = outside ? entryOf(siteOfTarget(c.target)) : undefined
          const patch = (p: Partial<SubagentDispatchCandidate>): void =>
            setCandidates(
              index,
              rule.candidates.map((x, i) => (i === ci ? { ...x, ...p } : x)),
            )
          return (
            <div
              key={c.target.model}
              data-dispatch-candidate={c.target.model}
              className="mb-1.5 flex flex-wrap items-center gap-1.5"
            >
              <div className={cn('min-w-36 flex-1 basis-36', (off || broken) && 'opacity-60')}>
                <div className="truncate font-mono text-meta text-fg" title={c.target.model}>
                  {c.target.model}
                </div>
                {(outside || broken) && (
                  <div className={cn('truncate text-label', off || broken ? 'text-warn' : 'text-fg-muted')}>
                    {broken
                      ? tr('subagentRoute.dispatch.unavailable')
                      : off
                        ? tr('subagentRoute.dispatch.outsideOffTag')
                        : tr('subagentRoute.dispatch.outsideTag', { site: other ? `${other.name} ${other.rate}` : '' })}
                  </div>
                )}
              </div>
              <input
                className="h-7 min-w-32 flex-[2] basis-40 rounded-md border border-line bg-surface px-2 text-meta text-fg outline-none placeholder:text-fg-faint focus-visible:border-accent disabled:bg-subtle disabled:text-fg-muted"
                aria-label={tr('subagentRoute.dispatch.noteLabel', { model: c.target.model })}
                placeholder={tr('subagentRoute.dispatch.notePlaceholder')}
                value={c.note}
                maxLength={SUBAGENT_LIMITS.dispatchNote}
                disabled={off}
                onChange={e => patch({ note: e.target.value })}
              />
              <button
                type="button"
                aria-pressed={!!c.isDefault}
                disabled={off}
                title={tr('subagentRoute.dispatch.defaultHint')}
                onClick={() =>
                  setCandidates(
                    index,
                    rule.candidates.map((x, i) => {
                      const { isDefault: _, ...rest } = x
                      return i === ci && !c.isDefault ? { ...rest, isDefault: true } : rest
                    }),
                  )
                }
                className={cn(
                  'h-7 rounded-md border px-2 text-label disabled:opacity-50',
                  c.isDefault
                    ? 'border-accent bg-accent-soft text-accent-fg'
                    : 'border-line text-fg-muted hover:bg-hover',
                )}
              >
                {tr('subagentRoute.dispatch.default')}
              </button>
              <button
                type="button"
                aria-label={tr('subagentRoute.dispatch.removeCandidate', { model: c.target.model })}
                onClick={() =>
                  setCandidates(
                    index,
                    rule.candidates.filter((_, i) => i !== ci),
                  )
                }
                className="grid size-6 place-items-center rounded-md text-fg-faint hover:bg-hover"
              >
                <X size={14} />
              </button>
            </div>
          )
        })}
        {rule.candidates.length < SUBAGENT_LIMITS.dispatchCandidates && addOptions.length > 0 && (
          <Select
            label={tr('subagentRoute.dispatch.addModel')}
            className="mt-1 max-w-64"
            mono
            value=""
            placeholder={tr('subagentRoute.dispatch.addModel')}
            options={addOptions}
            onChange={key => {
              const hit = entries
                .flatMap(e => e.models.map(m => ({ e, m })))
                .find(x => optionKey(x.e.site, x.m) === key)
              const target = hit ? targetOf(hit.e.site, hit.m) : null
              if (target) setCandidates(index, [...rule.candidates, { target, note: '' }])
            }}
          />
        )}
      </div>
    </div>
  )
}

function Preview({
  dispatch,
  sites,
  current,
  options,
  onPick,
  entryOf,
}: {
  dispatch: SubagentDispatch
  sites: SiteContext
  current: { key: string; site: SubagentSite; model: string; name: string }
  options: ReadonlyArray<{ key: string; model: string; name: string }>
  onPick: (key: string) => void
  entryOf: (site: SubagentSite) => SiteEntry | undefined
}) {
  const catalog = dispatchCatalog(current.site, sites)
  const r = resolveDispatch(
    dispatch,
    { site: current.site, account: sites.platform.email, model: current.model },
    catalog,
  )
  const given = new Set(r.options.map(o => o.model))
  // 没写规则时哪些同分组的模型因为更贵、查不到价格没给
  const skipped =
    !r.ruled && dispatch.unruled === 'cheaper'
      ? (entryOf(current.site)?.models ?? []).filter(m => m !== current.model && !given.has(m))
      : []
  const outsideOff = r.off.filter(o => o.reason === OUTSIDE_OFF).map(o => o.model)
  const broken = r.off.filter(o => o.reason !== OUTSIDE_OFF).map(o => o.model)
  return (
    <aside
      data-dispatch-preview=""
      aria-label={tr('subagentRoute.dispatch.previewLabel')}
      className="min-w-0 rounded-lg border border-line-subtle bg-subtle p-3"
    >
      <div className="mb-1.5 text-label text-fg-muted">{tr('subagentRoute.dispatch.previewTry')}</div>
      <Select
        label={tr('subagentRoute.dispatch.previewTry')}
        mono
        value={current.key}
        onChange={onPick}
        options={options.map(o => ({ value: o.key, label: o.model, hint: o.name }))}
      />
      <div className="mt-2 rounded-md border border-line-subtle bg-app px-2.5 py-2 font-mono text-label leading-relaxed break-words whitespace-pre-wrap text-fg-secondary">
        {r.options.length ? (
          <>
            <span className="block text-fg-faint">{tr('subagentRoute.dispatch.previewCanPick')}</span>
            {r.options.map(o => (
              <span key={o.model} className="block">
                <span className="text-accent-fg">{o.model}</span>
                {o.outside ? ` [${tr('subagentRoute.dispatch.outsideShort')}]` : ''}
                {o.note ? `  ${o.note}` : ''}
              </span>
            ))}
            <span className="mt-1 block text-fg-faint">
              {tr('subagentRoute.dispatch.previewDefault', { model: r.defaultModel ?? current.model })}
            </span>
          </>
        ) : (
          <span className="text-fg-muted">{tr('subagentRoute.dispatch.previewSelf', { model: current.model })}</span>
        )}
      </div>
      <p className="mt-2 text-label text-fg-muted">
        {r.ruled
          ? tr('subagentRoute.dispatch.footRule')
          : dispatch.unruled === 'self'
            ? tr('subagentRoute.dispatch.footSelf')
            : tr('subagentRoute.dispatch.footCheaper', { site: current.name })}
        {skipped.length > 0 &&
          ` ${tr('subagentRoute.dispatch.footSkipped', { models: skipped.join(tr('subagentRoute.dispatch.listSep')) })}`}
        {r.options.length > 0 && ` ${tr('subagentRoute.dispatch.footReject')}`}
      </p>
      {outsideOff.length > 0 && (
        <p className="mt-1 text-label text-warn">
          {tr('subagentRoute.dispatch.footOutsideOff', {
            models: outsideOff.join(tr('subagentRoute.dispatch.listSep')),
          })}
        </p>
      )}
      {broken.length > 0 && (
        <p className="mt-1 text-label text-warn">
          {tr('subagentRoute.dispatch.footBroken', { models: broken.join(tr('subagentRoute.dispatch.listSep')) })}
        </p>
      )}
    </aside>
  )
}
