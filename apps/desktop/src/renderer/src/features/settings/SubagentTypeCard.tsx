// 设置 › 子智能体的一个类型（样式稿 docs/ui/subagent-types-mockup.html）：摘要卡片（图标、名称、说明、站点 / 权限 / 时长），
// 点开在原地编辑；改的是草稿，点保存才写进设置
import { useState, type ReactNode } from 'react'
import { Bot, ChevronDown, Clock, Globe, Lock, Search, TriangleAlert, Wrench, type LucideIcon } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Button, Segmented, Select, Switch, cn } from '@/ui'
import { formatMultiplier, type PlatformGroup } from '@/features/account/platform'
import { siteKey, targetProblem, type SiteKey } from './subagents'
import {
  BUILTIN_SUBAGENT_TYPES,
  EXPLORE_TYPE,
  GENERAL_TYPE,
  SUBAGENT_LIMITS,
  SUBAGENT_MAX_MINUTES,
  SUBAGENT_TYPE_ID,
  isBuiltinSubagentType,
  type SubagentMaxMinutes,
  type SubagentTarget,
  type SubagentTools,
  type SubagentType,
} from '../../../../shared/types/subagents'
import type { ProviderProtocol, ProviderView } from '../../../../shared/types/providers'

const PROTOCOL: Record<ProviderProtocol, string> = {
  anthropic: 'Anthropic',
  responses: 'Responses',
  chat: 'Chat Completions',
}

/** 图标底色：内置的固定，自己加的按顺序轮换 */
const TILES = [
  'bg-accent-soft text-accent-fg',
  'bg-[color-mix(in_srgb,var(--status-seen)_14%,transparent)] text-[var(--status-seen)]',
  'bg-[color-mix(in_srgb,var(--ultracode)_14%,transparent)] text-[var(--ultracode)]',
  'bg-[color-mix(in_srgb,var(--warn)_16%,transparent)] text-warn',
]
const ICONS: Record<string, LucideIcon> = { [GENERAL_TYPE]: Bot, [EXPLORE_TYPE]: Search }

export interface SiteContext {
  providers: readonly ProviderView[]
  /** 已登录时有线路的分组 */
  groups: readonly PlatformGroup[]
  platform: { email: string | null; loaded: boolean; groups: readonly PlatformGroup[] }
}

export const typeName = (t: SubagentType): string =>
  t.id === GENERAL_TYPE || t.id === EXPLORE_TYPE
    ? tr(`subagentRoute.name.${t.id}`)
    : t.name || tr('subagentRoute.untitled')

export const minutesLabel = (n: number): string =>
  n === 60 ? tr('subagentRoute.hour') : tr('subagentRoute.minutes', { n })

/** 站点名：自定义接口名 / 线路名；找不到时 null */
function siteName(target: SubagentTarget, sites: SiteContext): string | null {
  return target.kind === 'custom'
    ? (sites.providers.find(p => p.id === target.providerId)?.name ?? null)
    : (sites.platform.groups.find(g => g.id === target.groupId)?.name ?? null)
}

function Chip({ icon: Icon, tone, children }: { icon: LucideIcon; tone?: 'route' | 'bad'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-md px-2 text-meta whitespace-nowrap',
        tone === 'route'
          ? 'bg-accent-soft text-accent-fg'
          : tone === 'bad'
            ? 'bg-danger/10 text-danger'
            : 'bg-subtle text-fg-secondary',
      )}
    >
      <Icon size={12} strokeWidth={1.75} className={tone ? undefined : 'text-fg-muted'} />
      {children}
    </span>
  )
}

export function SubagentTypeCard({
  type,
  index,
  open,
  isNew = false,
  sites,
  takenIds,
  onToggle,
  onEnable,
  onSave,
  onCancel,
  onDelete,
  onCopy,
  openChannels,
}: {
  type: SubagentType
  index: number
  open: boolean
  isNew?: boolean
  sites: SiteContext
  /** 其他类型已用的标识 */
  takenIds: readonly string[]
  onToggle: () => void
  onEnable: (enabled: boolean) => void
  onSave: (next: SubagentType) => void
  onCancel: () => void
  onDelete: () => void
  onCopy: () => void
  openChannels: () => void
}) {
  useI18n()
  const Icon = ICONS[type.id] ?? Wrench
  const tile = type.id === GENERAL_TYPE ? TILES[0] : type.id === EXPLORE_TYPE ? TILES[1] : TILES[2 + (index % 2)]
  const problem = type.target ? targetProblem(type.target, sites.providers, sites.platform) : null
  const site = type.target ? siteName(type.target, sites) : null
  return (
    <div
      data-subagent-type={type.id}
      className={cn(
        'rounded-xl border bg-surface transition-[border-color,box-shadow]',
        open
          ? 'border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-line-card))] shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
          : 'border-line-card',
      )}
    >
      <div className="flex items-center gap-3.5 px-4 py-3.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={tr('subagentRoute.expand')}
          className={cn('flex min-w-0 flex-1 items-center gap-3.5 text-left', !type.enabled && 'opacity-50')}
        >
          <span className={cn('grid size-9 shrink-0 place-items-center rounded-[9px]', tile)}>
            <Icon size={18} strokeWidth={1.6} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 font-semibold text-fg">
              {typeName(type)}
              {!isNew && <span className="font-mono text-meta font-normal text-fg-faint">{type.id}</span>}
              {isBuiltinSubagentType(type.id) && (
                <span className="rounded bg-subtle px-1.5 text-label font-normal text-fg-muted">
                  {tr('subagentRoute.builtin')}
                </span>
              )}
            </span>
            <span className="mt-px block truncate text-meta text-fg-muted">
              {type.description || tr('subagentRoute.noDescription')}
            </span>
            <span className="mt-2 flex flex-wrap gap-1.5">
              {!type.target ? (
                <Chip icon={Globe}>{tr('subagentRoute.follow')}</Chip>
              ) : problem ? (
                <Chip icon={TriangleAlert} tone="bad">
                  {tr('subagentRoute.siteBroken')}
                </Chip>
              ) : (
                <Chip icon={Globe} tone="route">
                  {site ?? type.target.model} · <span className="font-mono">{type.target.model}</span>
                </Chip>
              )}
              <Chip icon={type.tools === 'read' ? Lock : Wrench}>
                {tr(type.tools === 'read' ? 'subagentRoute.toolsRead' : 'subagentRoute.toolsAll')}
              </Chip>
              <Chip icon={Clock}>{tr('subagentRoute.maxShort', { time: minutesLabel(type.maxMinutes) })}</Chip>
            </span>
          </span>
        </button>
        <span title={type.id === GENERAL_TYPE ? tr('subagentRoute.generalLocked') : undefined}>
          <Switch
            label={tr('subagentRoute.enable')}
            checked={type.enabled}
            disabled={type.id === GENERAL_TYPE || isNew}
            onChange={onEnable}
          />
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-label={tr('subagentRoute.expand')}
          className="grid size-7 place-items-center rounded-md text-fg-faint hover:bg-hover"
        >
          <ChevronDown size={16} className={cn('transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <TypeEditor
          type={type}
          isNew={isNew}
          sites={sites}
          takenIds={takenIds}
          onSave={onSave}
          onCancel={onCancel}
          onDelete={onDelete}
          onCopy={onCopy}
          openChannels={openChannels}
        />
      )}
    </div>
  )
}

const inputClass =
  'block w-full rounded-md border border-line bg-app px-2.5 text-list text-fg outline-none placeholder:text-fg-faint focus-visible:border-accent disabled:bg-subtle disabled:text-fg-muted'

function Field({ label, hint, full, children }: { label: string; hint?: string; full?: boolean; children: ReactNode }) {
  return (
    <div className={full ? 'col-span-2' : undefined}>
      <div className="mb-1.5 flex justify-between gap-3 text-meta">
        <span className="font-medium text-fg-secondary">{label}</span>
        {hint && <span className="text-fg-faint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function TypeEditor({
  type,
  isNew,
  sites,
  takenIds,
  onSave,
  onCancel,
  onDelete,
  onCopy,
  openChannels,
}: {
  type: SubagentType
  isNew: boolean
  sites: SiteContext
  takenIds: readonly string[]
  onSave: (next: SubagentType) => void
  onCancel: () => void
  onDelete: () => void
  onCopy: () => void
  openChannels: () => void
}) {
  const builtin = isBuiltinSubagentType(type.id)
  const [draft, setDraft] = useState<SubagentType>(type)
  // 选了「指定」但还没选站点（草稿里 target 仍是 null）
  const [routing, setRouting] = useState(!!type.target)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<SubagentType>) => setDraft(d => ({ ...d, ...patch }))
  const { providers, groups } = sites
  const target = draft.target

  const targetFor = (key: SiteKey): SubagentTarget | null => {
    if (key.startsWith('custom:')) {
      const p = providers.find(x => `custom:${x.id}` === key)
      return p ? { kind: 'custom', providerId: p.id, model: p.models[0]!.id } : null
    }
    const g = groups.find(x => `platform:${x.id}` === key)
    const email = sites.platform.email
    return g && email ? { kind: 'platform', groupId: g.id, account: email, model: g.models[0]! } : null
  }
  const siteOptions = [
    ...providers.map(p => ({
      value: `custom:${p.id}` as SiteKey,
      label: p.name,
      hint: tr('subagentRoute.customHint', { protocol: PROTOCOL[p.protocol] }),
    })),
    ...groups.map(g => ({
      value: `platform:${g.id}` as SiteKey,
      label: g.name,
      hint: tr('subagentRoute.platformHint', { rate: formatMultiplier(g.rate_multiplier) }),
    })),
  ]
  const modelOptions = !target
    ? []
    : target.kind === 'custom'
      ? (providers.find(p => p.id === target.providerId)?.models.map(m => m.id) ?? [])
      : (groups.find(g => g.id === target.groupId)?.models ?? [])
  const models = target && !modelOptions.includes(target.model) ? [target.model, ...modelOptions] : modelOptions
  const problem = target ? targetProblem(target, providers, sites.platform) : null

  const save = () => {
    const next: SubagentType = {
      ...draft,
      name: draft.name.trim(),
      id: draft.id.trim(),
      description: draft.description.trim(),
      instructions: draft.instructions.trim(),
      target: routing ? draft.target : null,
    }
    if (!builtin && !next.name) return setError(tr('subagentRoute.error.name'))
    if (!SUBAGENT_TYPE_ID.test(next.id)) return setError(tr('subagentRoute.error.id'))
    if (takenIds.includes(next.id)) return setError(tr('subagentRoute.error.idTaken'))
    if (!next.description) return setError(tr('subagentRoute.error.description'))
    if (routing && !next.target) return setError(tr('subagentRoute.error.site'))
    setError(null)
    onSave(next)
  }

  return (
    <div className="border-t border-line-subtle px-4 pt-4 pb-4 pl-[66px]">
      <div className="grid grid-cols-2 gap-x-3.5 gap-y-4">
        <Field label={tr('subagentRoute.field.name')}>
          <input
            className={cn(inputClass, 'h-8')}
            value={builtin ? typeName(draft) : draft.name}
            disabled={builtin}
            maxLength={SUBAGENT_LIMITS.name}
            placeholder={tr('subagentRoute.field.namePlaceholder')}
            onChange={e => set({ name: e.target.value })}
          />
        </Field>
        <Field label={tr('subagentRoute.field.id')} hint={tr('subagentRoute.field.idHint')}>
          <input
            className={cn(inputClass, 'h-8 font-mono text-meta')}
            value={draft.id}
            disabled={!isNew}
            maxLength={32}
            placeholder={tr('subagentRoute.field.idPlaceholder')}
            onChange={e => set({ id: e.target.value.toLowerCase() })}
          />
        </Field>
        <Field full label={tr('subagentRoute.field.description')} hint={tr('subagentRoute.field.descriptionHint')}>
          <textarea
            rows={2}
            className={cn(inputClass, 'resize-none py-2 leading-relaxed')}
            value={draft.description}
            maxLength={SUBAGENT_LIMITS.description}
            placeholder={tr('subagentRoute.field.descriptionPlaceholder')}
            onChange={e => set({ description: e.target.value })}
          />
        </Field>
        <Field full label={tr('subagentRoute.field.route')}>
          <div role="radiogroup" aria-label={tr('subagentRoute.field.route')} className="grid grid-cols-2 gap-2">
            {(
              [
                [false, 'subagentRoute.follow', 'subagentRoute.followHint'],
                [true, 'subagentRoute.route', 'subagentRoute.routeHint'],
              ] as const
            ).map(([value, title, hint]) => (
              <button
                key={title}
                type="button"
                role="radio"
                aria-checked={routing === value}
                onClick={() => setRouting(value)}
                className={cn(
                  'flex gap-2.5 rounded-lg border px-3 py-2.5 text-left',
                  routing === value
                    ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_5%,var(--color-surface))]'
                    : 'border-line bg-app hover:bg-hover',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0 rounded-full',
                    routing === value ? 'border-[4.5px] border-accent' : 'border-[1.5px] border-fg-faint',
                  )}
                />
                <span>
                  <span className="block font-medium text-fg">{tr(title)}</span>
                  <span className="text-meta text-fg-muted">{tr(hint)}</span>
                </span>
              </button>
            ))}
          </div>
          {routing &&
            (siteOptions.length === 0 && !target ? (
              <div className="mt-2 text-meta text-fg-muted">
                <p>{tr('subagentRoute.empty')}</p>
                <Button className="mt-2" onClick={openChannels}>
                  {tr('subagentRoute.openChannels')}
                </Button>
              </div>
            ) : (
              <>
                <div className="mt-2 flex gap-2">
                  <Select<SiteKey>
                    label={tr('subagentRoute.site')}
                    className="min-w-0 flex-[1.15]"
                    value={target ? siteKey(target) : ('' as SiteKey)}
                    placeholder={tr('subagentRoute.pick')}
                    onChange={key => {
                      const next = targetFor(key)
                      if (next) set({ target: next })
                    }}
                    options={siteOptions}
                  />
                  <Select
                    label={tr('subagentRoute.model')}
                    className="min-w-0 flex-1"
                    mono
                    disabled={!target}
                    value={target?.model ?? ''}
                    onChange={model => target && set({ target: { ...target, model } })}
                    options={models.map(m => ({ value: m, label: m }))}
                  />
                </div>
                {target && (
                  <p
                    data-subagent-route-status={problem ?? 'ok'}
                    className={cn('mt-1.5 text-meta', problem ? 'text-danger' : 'text-fg-faint')}
                  >
                    {problem === 'signedOut'
                      ? tr('subagentRoute.signedOut', { account: target.kind === 'platform' ? target.account : '' })
                      : problem === 'modelGone'
                        ? tr('subagentRoute.modelGone', { model: target.model })
                        : tr(problem ? `subagentRoute.${problem}` : 'subagentRoute.ok')}
                  </p>
                )}
              </>
            ))}
        </Field>
        <Field label={tr('subagentRoute.field.tools')}>
          <Segmented<SubagentTools>
            label={tr('subagentRoute.field.tools')}
            value={draft.tools}
            onChange={tools => set({ tools })}
            options={[
              { value: 'all', label: tr('subagentRoute.toolsAll') },
              { value: 'read', label: tr('subagentRoute.toolsRead') },
            ]}
          />
          <p className="mt-1.5 text-meta text-fg-faint">
            {tr(draft.tools === 'read' ? 'subagentRoute.field.toolsReadHint' : 'subagentRoute.field.toolsHint')}
          </p>
        </Field>
        <Field label={tr('subagentRoute.field.maxRun')}>
          <Segmented<`${SubagentMaxMinutes}`>
            label={tr('subagentRoute.field.maxRun')}
            value={`${draft.maxMinutes}`}
            onChange={v => set({ maxMinutes: Number(v) as SubagentMaxMinutes })}
            options={SUBAGENT_MAX_MINUTES.map(n => ({ value: `${n}` as const, label: minutesLabel(n) }))}
          />
        </Field>
        <Field full label={tr('subagentRoute.field.instructions')} hint={tr('subagentRoute.field.instructionsHint')}>
          <textarea
            rows={2}
            className={cn(inputClass, 'resize-y py-2 leading-relaxed')}
            value={draft.instructions}
            maxLength={SUBAGENT_LIMITS.instructions}
            placeholder={tr('subagentRoute.field.instructionsPlaceholder')}
            onChange={e => set({ instructions: e.target.value })}
          />
        </Field>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-meta text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex items-center gap-2 border-t border-line-subtle pt-3.5">
        {!builtin && !isNew && (
          <>
            <button
              type="button"
              onClick={onDelete}
              className="press inline-flex h-8 items-center rounded-md px-3 text-ui font-medium text-danger hover:bg-hover"
            >
              {tr('subagentRoute.delete')}
            </button>
            <Button variant="ghost" onClick={onCopy}>
              {tr('subagentRoute.copy')}
            </Button>
          </>
        )}
        {builtin && (
          <Button
            variant="ghost"
            onClick={() => {
              const d = BUILTIN_SUBAGENT_TYPES.find(t => t.id === type.id)!
              setDraft({ ...d, enabled: draft.enabled })
              setRouting(false)
            }}
          >
            {tr('subagentRoute.reset')}
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={onCancel}>
          {tr('subagentRoute.cancel')}
        </Button>
        <Button variant="primary" onClick={save}>
          {tr(isNew ? 'subagentRoute.add' : 'subagentRoute.save')}
        </Button>
      </div>
    </div>
  )
}
