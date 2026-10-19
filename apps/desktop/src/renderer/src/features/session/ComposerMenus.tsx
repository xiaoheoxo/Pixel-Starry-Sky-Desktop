import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
// 输入框里的弹出菜单：推理强度（滑块 + Ultracode）、权限模式（docs/engines.md §6、§11）。都从下往上弹出。
// 引擎 / 额度来源 / 模型菜单在 ModelSourceMenu.tsx（docs/ui/source-switch.md）。
import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  ListChecks,
  RotateCcw,
  Shield,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { PermissionMode } from '@pixelsky/protocol'
import { IconButton, Popover, Switch, cn, useToast } from '@/ui'
import { PERMISSION_HINTS, PERMISSION_INFO, effortLabel, type ComposerController } from '@/features/engine'
import { EffortSlider } from './EffortSlider'
import { effortDiff } from '@/features/engine/effortDefaults'
import { needsFullConfirm, saferMode } from './fullAccess'
import { FullAccessConfirm } from './FullAccessConfirm'

export const PERMISSION_ICON: Record<PermissionMode, LucideIcon> = {
  ask: Shield,
  edits: ShieldCheck,
  plan: ListChecks,
  full: ShieldOff,
}

export function MenuTitle({ children }: { children: ReactNode }) {
  useI18n()
  return <div className="px-2 pt-1.5 pb-1 text-label font-medium text-fg-faint">{children}</div>
}

export function MenuRow({
  selected,
  disabled,
  onClick,
  icon,
  title,
  hint,
}: {
  selected?: boolean
  disabled?: boolean
  onClick?: () => void
  icon?: ReactNode
  title: ReactNode
  hint?: ReactNode
}) {
  useI18n()
  return (
    <button
      type="button"
      data-menu-item
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent',
        selected && 'bg-selected hover:bg-selected',
      )}
    >
      {icon && <span className="mt-0.5 flex shrink-0">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-ui text-fg">{title}</span>
        {hint && <span className="block text-meta text-fg-muted">{hint}</span>}
      </span>
      {selected && <Check size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-fg-secondary" />}
    </button>
  )
}

export const TRIGGER =
  'press no-drag inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-list text-fg-secondary hover:bg-hover hover:text-fg'

/** 开关一行：名字 + 说明 + 开关 */
function SwitchRow({
  icon,
  label,
  desc,
  checked,
  disabled,
  tone,
  onChange,
}: {
  icon?: ReactNode
  label: string
  desc: string
  checked: boolean
  disabled?: boolean
  tone?: 'ultracode'
  onChange: (on: boolean) => void
}) {
  useI18n()
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-ui text-fg">
          {icon}
          <span className={cn(tone === 'ultracode' && checked && 'effort-max ultracode-glow')}>{label}</span>
        </span>
        <span className="mt-0.5 block text-meta text-fg-muted">{desc}</span>
      </span>
      <Switch checked={checked} disabled={disabled} label={label} size="sm" tone={tone} onChange={onChange} />
    </div>
  )
}

/**
 * 推理强度：滑块 + 下面的会话开关（Ultracode、Fast 模式、显示思考摘要，引擎支持时才出现）。
 * 配色和 JuCode 同步：强度名、滑块用引擎品牌色，最高档时流动（docs/engines.md §15）。
 */
export function EffortMenu({ live }: { live: ComposerController }) {
  useI18n()
  const [open, setOpen] = useState(false)
  const { effort, efforts, ultracode, ultracodeSupported, ultracodeAvailable, accent } = live
  const top = !!effort && efforts.length > 1 && efforts.indexOf(effort) === efforts.length - 1
  const ultraUnavailable = ultracodeAvailable === false
  const fastUnavailable = live.fastAvailable === false
  const accentStyle = { '--effort-accent': accent || 'var(--text)' } as CSSProperties
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  // 和这个引擎新会话的默认值比：只比引擎支持的那几项
  const d = live.effortDefaults
  const diff = effortDiff({ effort, ultracode, fast: live.fast, thinkingSummaries: live.thinkingSummaries }, d, {
    effort: efforts.length > 0,
    ultracode: ultracodeSupported,
    fast: live.fastSupported,
    thinkingSummaries: live.thinkingSupported,
  })
  const differs = diff.length > 0
  const resetToDefaults = (): void => {
    if (diff.includes('effort') && d.effort) live.setEffort(d.effort)
    if (diff.includes('ultracode')) live.setUltracode(d.ultracode)
    if (diff.includes('fast')) live.setFast(d.fast)
    if (diff.includes('thinkingSummaries')) live.setThinkingSummaries(d.thinkingSummaries)
  }
  const hasSwitches = ultracodeSupported || live.fastSupported || live.thinkingSupported
  // 开启的会话开关同步显示在按钮上，都用图标：Ultracode 紫色 ✦，Fast / 思考摘要强调色；名字在悬停提示里。
  const fastOn = live.fastSupported && live.fast
  const thinkingOn = live.thinkingSupported && live.thinkingSummaries
  const modes = [
    ultracode && 'Ultracode',
    fastOn && tr('session.ComposerMenus.fastMode'),
    thinkingOn && tr('session.ComposerMenus.showThinkingSummaries'),
  ]
    .filter(Boolean)
    .join(' · ')
  const title = [
    tr('session.ComposerMenus.reasoningEffort', { p0: effortLabel(effort) }),
    modes && tr('session.ComposerMenus.modesOn', { p0: modes }),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={cn(TRIGGER, 'gap-1')}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span key={effort ?? ''} className={cn(top && 'effort-max')} style={accentStyle}>
          {effortLabel(effort)}
        </span>
        {(ultracode || fastOn || thinkingOn) && (
          <span className="flex items-center gap-0.5 text-accent" aria-hidden>
            {ultracode && <Sparkles size={13} strokeWidth={1.75} className="text-ultracode" />}
            {fastOn && <Zap size={13} strokeWidth={1.75} />}
            {thinkingOn && <Brain size={13} strokeWidth={1.75} />}
          </span>
        )}
        <ChevronDown size={14} strokeWidth={1.5} className="text-fg-muted" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} side="top" align="end" offset={8} className="w-80 p-3">
        <div className="mb-3 flex h-6 min-w-0 items-center gap-2">
          <span className="shrink-0 text-ui whitespace-nowrap text-fg-secondary">
            {tr('session.Composer.reasoningEffort')}
          </span>
          <span
            key={effort ?? ''}
            className={cn('shrink-0 text-ui font-semibold whitespace-nowrap text-fg', top && 'effort-max')}
            style={accentStyle}
          >
            {effortLabel(effort)}
          </span>
          {differs && (
            <span
              data-effort-temporary
              title={tr('effortDefaults.temporaryHint')}
              className="min-w-0 truncate rounded-sm bg-subtle px-1.5 text-label leading-5 text-fg-muted"
            >
              {tr('effortDefaults.temporary')}
            </span>
          )}
          <span className="flex-1" />
          <IconButton
            icon={RotateCcw}
            label={d.effort ? tr('effortDefaults.resetTo', { p0: effortLabel(d.effort) }) : tr('effortDefaults.reset')}
            size={24}
            iconSize={14}
            disabled={!differs}
            className="-mr-1 disabled:opacity-40"
            onClick={resetToDefaults}
          />
        </div>
        {/* 引擎目录说这个模型没有强度档位（例如 Haiku 4.5）：不画空滑块，只给一句说明 */}
        {efforts.length > 0 ? (
          <EffortSlider
            efforts={efforts}
            effort={effort}
            onChange={live.setEffort}
            accent={accent}
            defaultEffort={d.effort}
          />
        ) : (
          <p className="text-meta text-fg-muted">{tr('session.ComposerMenus.modelHasNoEffortLevels')}</p>
        )}
        {hasSwitches && (
          <div className="mt-3 flex flex-col border-t border-line-subtle pt-1">
            {ultracodeSupported && (
              <SwitchRow
                icon={
                  <Sparkles size={14} strokeWidth={1.75} className={ultracode ? 'text-ultracode' : 'text-fg-muted'} />
                }
                label="Ultracode"
                tone="ultracode"
                desc={
                  ultraUnavailable
                    ? tr('session.ComposerMenus.notSupportedByThis')
                    : tr('session.ComposerMenus.orchestrateMultipleSubagentsFor')
                }
                checked={ultracode}
                disabled={ultraUnavailable && !ultracode}
                onChange={live.setUltracode}
              />
            )}
            {live.fastSupported && (
              <SwitchRow
                icon={<Zap size={14} strokeWidth={1.75} className={live.fast ? 'text-accent' : 'text-fg-muted'} />}
                label={tr('session.ComposerMenus.fastMode')}
                desc={
                  fastUnavailable
                    ? tr('session.ComposerMenus.temporarilyUnavailable', { p0: live.fastBlocked ?? '原因未知' })
                    : (live.fastHint ?? tr('session.ComposerMenus.fasterOutputAtHigher'))
                }
                checked={live.fast}
                disabled={fastUnavailable && !live.fast}
                onChange={live.setFast}
              />
            )}
            {live.thinkingSupported && (
              <SwitchRow
                icon={
                  <Brain
                    size={14}
                    strokeWidth={1.75}
                    className={live.thinkingSummaries ? 'text-accent' : 'text-fg-muted'}
                  />
                }
                label={tr('session.ComposerMenus.showThinkingSummaries')}
                desc={tr('session.ComposerMenus.showSummaryOfModel')}
                checked={live.thinkingSummaries}
                onChange={live.setThinkingSummaries}
              />
            )}
          </div>
        )}
        {/* 会话里调整只影响这个会话；要改新会话的默认值点这里（GitHub #6） */}
        <div className="mt-2 flex items-center justify-end border-t border-line-subtle pt-2">
          <button
            type="button"
            data-effort-save-default
            disabled={!differs || saving}
            title={tr('effortDefaults.saveHint', { p0: live.engine?.name ?? '' })}
            onClick={() => {
              setSaving(true)
              live
                .saveEffortDefaults()
                .catch((e: unknown) =>
                  toast(tr('effortDefaults.saveFailed', { p0: translateMessage((e as Error).message) })),
                )
                .finally(() => setSaving(false))
            }}
            className="rounded-md px-2 py-1 text-meta text-fg-secondary hover:bg-hover hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent"
          >
            {tr(differs ? 'effortDefaults.save' : 'effortDefaults.isDefault')}
          </button>
        </div>
      </Popover>
    </div>
  )
}

export function PermissionMenu({
  mode,
  modes,
  onSelect,
  engine,
  defaultMode,
  started = true,
}: {
  mode: PermissionMode
  modes: PermissionMode[]
  onSelect: (m: PermissionMode) => void
  engine?: 'claude' | 'codex' | 'pixel'
  /** 这个引擎新会话的默认权限：确认里写「新任务还是……」 */
  defaultMode?: PermissionMode
  /** 已经开始的对话（确认标题写「这个对话」，新任务写「这个任务」） */
  started?: boolean
}) {
  useI18n()
  const [open, setOpen] = useState(false)
  // 从别的模式切进完全放行：每次都先在菜单里就地确认
  const [confirming, setConfirming] = useState(false)
  const Icon = PERMISSION_ICON[mode]
  const close = (): void => {
    setOpen(false)
    setConfirming(false)
  }
  const later = saferMode(defaultMode, modes)
  return (
    <div className="relative">
      <button
        type="button"
        title={tr('session.ComposerMenus.permissions', { p0: PERMISSION_INFO[mode].label })}
        aria-label={tr('session.ComposerMenus.permissions', { p0: PERMISSION_INFO[mode].label })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className={cn(
          'press no-drag inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-list hover:bg-hover',
          mode === 'full' ? 'text-warn' : 'text-fg-secondary hover:text-fg',
        )}
      >
        <Icon size={16} strokeWidth={1.5} />
        <span>{PERMISSION_INFO[mode].label}</span>
      </button>
      <Popover open={open} onClose={close} side="top" offset={8} className="w-80">
        <MenuTitle>{tr('session.Composer.permissionMode')}</MenuTitle>
        {(['ask', 'edits', 'plan', 'full'] as const).map(m => {
          const MIcon = PERMISSION_ICON[m]
          const supported = modes.includes(m)
          if (m === 'full' && confirming)
            return (
              <FullAccessConfirm
                key={m}
                title={tr(started ? 'fullAccess.confirm.title' : 'fullAccess.confirm.newTitle')}
                items={[
                  tr('fullAccess.confirm.noAsk'),
                  tr(`fullAccess.confirm.${engine ?? 'claude'}`),
                  tr(started ? 'fullAccess.confirm.scope' : 'fullAccess.confirm.scopeNew', {
                    p0: PERMISSION_INFO[later].label,
                  }),
                ]}
                cancelLabel={tr('fullAccess.confirm.cancel')}
                confirmLabel={tr('fullAccess.confirm.ok')}
                onCancel={() => setConfirming(false)}
                onConfirm={() => {
                  onSelect('full')
                  close()
                }}
                className="mx-0.5 mt-1 mb-0.5 rounded-lg border border-line bg-hover px-3 pt-2.5 pb-2"
              />
            )
          return (
            <MenuRow
              key={m}
              selected={m === mode}
              disabled={!supported}
              icon={<MIcon size={16} strokeWidth={1.5} className={m === 'full' ? 'text-warn' : 'text-fg-muted'} />}
              title={PERMISSION_INFO[m].label}
              hint={
                supported
                  ? ((engine ? PERMISSION_HINTS[engine]?.[m]?.() : undefined) ?? PERMISSION_INFO[m].hint)
                  : tr('session.ComposerMenus.notSupportedByThis2')
              }
              onClick={() => {
                if (needsFullConfirm(mode, m)) {
                  setConfirming(true)
                  return
                }
                onSelect(m)
                close()
              }}
            />
          )
        })}
      </Popover>
    </div>
  )
}
