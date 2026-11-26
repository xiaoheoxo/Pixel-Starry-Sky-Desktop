// 频道设置 › 牵头成员下面的「牵头派活自动放行」（docs/ui/channels-lead-auto-approve.md §2.1、§2.2）：
// 开关、省 Token 的几项（不让活停下）、到上限转回等你的几项，下面一行写明会在什么情况转回等你；最后是所有频道的策略
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Select } from '@/ui'
import { LEAD_AUTO_LIMITS, type LeadAutoPolicy, type LeadAutoRules } from '../../../../shared/types/channels'

const NUMBER =
  'h-7 w-16 rounded-md border border-line bg-surface px-1.5 text-center text-meta text-fg tabular-nums outline-none focus:border-accent-line disabled:opacity-45'
/** 每小时 token 上限在界面上按「万」填 */
const TOKEN_UNIT = 10_000

/** 数字输入：在范围里的整数；空着或不对时按最小值 */
function clamp(text: string, [min, max]: readonly [number, number]): number {
  const n = Math.floor(Number(text))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
}

/** 会在什么情况转回等你：一句话 */
export function leadAutoSummary(rules: LeadAutoRules): string {
  const parts = [
    tr('channels.leadAuto.sumBatch', { n: rules.perBatch }),
    tr('channels.leadAuto.sumHour', { n: Math.round(rules.hourTokens / TOKEN_UNIT) }),
    tr('channels.leadAuto.sumRounds', { n: rules.rounds + 1 }),
    rules.guardFull ? tr('channels.leadAuto.sumFull') : '',
  ].filter(Boolean)
  return tr('channels.leadAuto.summary', { list: parts.join(tr('channels.relay.summarySep')) })
}

export function LeadAutoEditor({
  value,
  onChange,
  policy,
  onPolicy,
}: {
  value: LeadAutoRules
  onChange: (rules: LeadAutoRules) => void
  policy: LeadAutoPolicy
  onPolicy: (policy: LeadAutoPolicy) => void
}) {
  useI18n()
  const locked = policy === 'locked'
  const on = value.on && !locked
  const set = (patch: Partial<LeadAutoRules>) => onChange({ ...value, ...patch })
  const row = 'flex flex-wrap items-center gap-2 text-meta text-fg-secondary'
  const number = (key: keyof typeof LEAD_AUTO_LIMITS, shown: number, apply: (n: number) => void, scale = 1) => (
    <input
      type="number"
      data-lead-auto-field={key}
      min={LEAD_AUTO_LIMITS[key][0] / scale}
      max={LEAD_AUTO_LIMITS[key][1] / scale}
      className={NUMBER}
      value={shown}
      onChange={e =>
        apply(
          clamp(e.target.value, [LEAD_AUTO_LIMITS[key][0] / scale, LEAD_AUTO_LIMITS[key][1] / scale] as const) * scale,
        )
      }
    />
  )
  const check = (checked: boolean, label: string, hint: string | null, onToggle: (v: boolean) => void, key: string) => (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        data-lead-auto-check={key}
        className="mt-0.5"
        checked={checked}
        onChange={e => onToggle(e.target.checked)}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-meta text-fg-secondary">{label}</span>
        {hint && <span className="text-meta text-fg-muted">{hint}</span>}
      </span>
    </label>
  )
  const group = (label: string) => (
    <span className="mt-1 flex items-center gap-2 text-meta font-medium text-fg-muted after:h-px after:flex-1 after:bg-line">
      {label}
    </span>
  )
  return (
    <div data-lead-auto className="mt-1.5 flex flex-col gap-2 rounded-lg border border-line bg-subtle/40 p-3">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          data-channel-lead-auto
          className="mt-0.5"
          checked={on}
          disabled={locked}
          onChange={e => set({ on: e.target.checked })}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-list text-fg">{tr('channels.leadAuto.title')}</span>
          <span className="text-meta text-fg-muted">{tr('channels.leadAuto.hint')}</span>
        </span>
      </label>
      {locked && (
        <p data-lead-auto-locked className="rounded-md bg-subtle px-2.5 py-1.5 text-meta text-fg-muted">
          {tr('channels.leadAuto.locked')}
        </p>
      )}
      {on && (
        <>
          {group(tr('channels.leadAuto.groupSave'))}
          <div className={row}>
            {tr('channels.leadAuto.concurrent')}
            {number('concurrent', value.concurrent, n => set({ concurrent: n }))}
            {tr('channels.leadAuto.concurrentUnit')}
          </div>
          {check(
            value.reuseMinutes > 0,
            tr('channels.leadAuto.reuse'),
            tr('channels.leadAuto.reuseHint'),
            v => set({ reuseMinutes: v ? 30 : 0 }),
            'reuse',
          )}
          {value.reuseMinutes > 0 && (
            <div className={`${row} pl-6`}>
              {tr('channels.leadAuto.reuseWithin')}
              {number('reuseMinutes', value.reuseMinutes, n => set({ reuseMinutes: Math.max(1, n) }))}
              {tr('channels.leadAuto.reuseMid')}
              {number('reuseContext', value.reuseContext, n => set({ reuseContext: n }))}
              {tr('channels.leadAuto.reuseUnit')}
            </div>
          )}
          {check(
            value.leadSame,
            tr('channels.leadAuto.leadSame'),
            tr('channels.leadAuto.leadSameHint'),
            v => set({ leadSame: v }),
            'leadSame',
          )}
          <p className="text-meta text-fg-faint">{tr('channels.leadAuto.always')}</p>
          {group(tr('channels.leadAuto.groupLimits'))}
          <div className={row}>
            {tr('channels.leadAuto.perBatch')}
            {number('perBatch', value.perBatch, n => set({ perBatch: n }))}
            {tr('channels.leadAuto.perBatchUnit')}
          </div>
          <div className={row}>
            {tr('channels.leadAuto.hour')}
            {number('hourTokens', Math.round(value.hourTokens / TOKEN_UNIT), n => set({ hourTokens: n }), TOKEN_UNIT)}
            {tr('channels.leadAuto.hourUnit')}
          </div>
          <div className={row}>
            {tr('channels.leadAuto.rounds')}
            {number('rounds', value.rounds, n => set({ rounds: n }))}
            {tr('channels.leadAuto.roundsUnit')}
          </div>
          {check(value.guardFull, tr('channels.leadAuto.guardFull'), null, v => set({ guardFull: v }), 'guardFull')}
          <p data-lead-auto-summary className="rounded-md bg-subtle px-2.5 py-1.5 text-meta text-fg-muted">
            {leadAutoSummary(value)}
          </p>
        </>
      )}
      <div className={`${row} mt-1 border-t border-line pt-2`}>
        {tr('channels.leadAuto.policy')}
        <Select<LeadAutoPolicy>
          label={tr('channels.leadAuto.policy')}
          className="w-44!"
          value={policy}
          options={(['on', 'off', 'locked'] as const).map(p => ({
            value: p,
            label: tr(`channels.leadAuto.policy.${p}`),
          }))}
          onChange={onPolicy}
        />
      </div>
      <p className="text-meta text-fg-faint">{tr('channels.leadAuto.policyHint')}</p>
    </div>
  )
}
