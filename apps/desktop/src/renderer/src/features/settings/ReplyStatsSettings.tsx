import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { Check, RotateCcw } from 'lucide-react'
import { Button } from '@/ui'
import { TurnStats } from '@/features/session/TurnStats'
import { replyStatsPreview } from '@/data/replyStats'
import {
  REPLY_STAT_GROUPS,
  REPLY_STAT_LABELS,
  isDefaultReplyStats,
  resetReplyStats,
  setReplyStat,
  useReplyStats,
} from './replyStats'
import { SettingRow } from './SettingRow'

/** 设置 → 外观 → 对话；预览和真实回复共用 TurnStats。 */
export function ReplyStatsSettings() {
  useI18n()
  const selected = useReplyStats()
  return (
    <SettingRow
      title={tr('settings.ReplyStatsSettings.statisticsBelowReplies')}
      description={tr('settings.ReplyStatsSettings.chooseWhichStatisticsAppear')}
    >
      <div
        className="mb-3 rounded-lg bg-subtle/75 px-3.5 py-3"
        aria-label={tr('settings.ReplyStatsSettings.replyStatisticsPreview')}
      >
        <div className="mb-2 text-label text-fg-muted">{tr('settings.ReplyStatsSettings.previewSampleData')}</div>
        {selected.length > 0 ? (
          <TurnStats usage={replyStatsPreview} />
        ) : (
          <div className="text-meta text-fg-muted">{tr('settings.ReplyStatsSettings.hideStatistics')}</div>
        )}
      </div>
      <div className="space-y-4">
        {REPLY_STAT_GROUPS.map(group => (
          <fieldset key={group.label}>
            <legend className="mb-2 text-label font-medium text-fg-muted">{group.label}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-3">
              {group.keys.map(key => (
                <label
                  key={key}
                  className="group inline-flex cursor-pointer items-center gap-2 text-ui text-fg-secondary"
                >
                  <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
                    <input
                      type="checkbox"
                      checked={selected.includes(key)}
                      onChange={event => setReplyStat(key, event.target.checked)}
                      className="peer size-4 cursor-pointer appearance-none rounded-sm border border-line-strong bg-surface checked:border-accent checked:bg-accent group-hover:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                    />
                    <Check
                      size={12}
                      strokeWidth={2.25}
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 m-auto text-accent-on opacity-0 peer-checked:opacity-100"
                    />
                  </span>
                  {REPLY_STAT_LABELS[key]}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <p className="mt-3 text-meta text-fg-faint">{tr('settings.ReplyStatsSettings.uncachedInputExcludesCache')}</p>
      <Button
        variant="ghost"
        icon={RotateCcw}
        className="mt-3 -ml-3"
        disabled={isDefaultReplyStats(selected)}
        onClick={resetReplyStats}
      >
        {tr('settings.ReplyStatsSettings.resetStatistics')}{' '}
      </Button>
    </SettingRow>
  )
}
