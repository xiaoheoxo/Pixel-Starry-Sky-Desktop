import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Select, Switch } from '@/ui'
import { ALERT_RULES, STALLED_CHOICES, type ChannelAlertRules } from '../../../../shared/channels/alerts'

const HOURS = Array.from({ length: 24 }, (_, h) => h)

/** 频道设置里的「提醒」（docs/ui/channels-collab-v2.md §6）：每条规则单独开关，每日简报选几点 */
export function AlertRulesEditor({
  value,
  digestHour,
  stalledMinutes,
  onChange,
  onDigestHour,
  onStalledMinutes,
}: {
  value: ChannelAlertRules
  digestHour: number
  stalledMinutes: number
  onChange: (next: ChannelAlertRules) => void
  onDigestHour: (hour: number) => void
  onStalledMinutes: (minutes: number) => void
}) {
  useI18n()
  return (
    <fieldset data-alert-rules="" className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-meta font-medium text-fg-muted">{tr('alerts.settings')}</legend>
      {ALERT_RULES.map(rule => (
        <div key={rule} className="flex min-h-8 items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-list text-fg">{tr(`alerts.rule.${rule}`)}</span>
            {rule === 'conflict' && (
              <span className="block text-meta text-fg-faint">{tr('alerts.rule.conflictHint')}</span>
            )}
          </span>
          {rule === 'digest' && value.digest && (
            <Select
              label={tr('alerts.rule.digest')}
              value={String(digestHour)}
              options={HOURS.map(h => ({ value: String(h), label: tr('alerts.digestAt', { hour: h }) }))}
              onChange={v => onDigestHour(Number(v))}
              className="h-7 w-auto"
              fitContent
            />
          )}
          {rule === 'stalled' && value.stalled && (
            <Select
              label={tr('alerts.rule.stalled')}
              value={String(stalledMinutes)}
              options={STALLED_CHOICES.map(n => ({ value: String(n), label: tr('alerts.stalledAfter', { n }) }))}
              onChange={v => onStalledMinutes(Number(v))}
              className="h-7 w-auto"
              fitContent
            />
          )}
          <Switch
            checked={value[rule]}
            label={tr(`alerts.rule.${rule}`)}
            size="sm"
            onChange={on => onChange({ ...value, [rule]: on })}
          />
        </div>
      ))}
    </fieldset>
  )
}
