import { translateMessage } from '../../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { useEffect, useState } from 'react'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { Button, IconButton, Segmented, cn } from '@/ui'
import { SettingRow } from '../SettingRow'
import { saveRequestRetry, useRequestRetry } from '../requestRetry'

export function RequestRetrySettings() {
  useI18n()
  const state = useRequestRetry()
  const [draft, setDraft] = useState('3')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (state.maxRetries !== null) setDraft(String(state.maxRetries))
  }, [state.maxRetries])
  const busy = state.loading || state.saving
  const parse = (): number | null => (/^\d+$/.test(draft) && Number(draft) <= 15 ? Number(draft) : null)
  const save = (value: number | null): void => {
    setError(null)
    if (value !== null) setDraft(String(value))
    void saveRequestRetry(value)
  }
  return (
    <SettingRow
      title={tr('settings.models.ModelsSection.requestRetries')}
      description={tr('settings.models.RequestRetrySettings.maximumAutomaticRetriesFor')}
      hint={tr('settings.models.RequestRetrySettings.appliesToClaudeCode')}
      control={
        <Segmented
          label={tr('settings.models.RequestRetrySettings.requestRetryMode')}
          value={state.maxRetries === null ? 'engine' : 'custom'}
          options={[
            {
              value: 'engine',
              get label() {
                return tr('settings.models.RequestRetrySettings.engineDefault')
              },
            },
            {
              value: 'custom',
              get label() {
                return tr('settings.account.TopUp.custom')
              },
            },
          ]}
          onChange={v => {
            if (!busy) save(v === 'engine' ? null : (parse() ?? 3))
          }}
        />
      }
    >
      {state.maxRetries !== null && (
        <form
          className="space-y-3"
          onSubmit={e => {
            e.preventDefault()
            const value = parse()
            if (value === null) setError(tr('settings.models.RequestRetrySettings.enterIntegerFrom0'))
            else save(value)
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="request-retry-count" className="text-ui text-fg-secondary">
              {tr('settings.models.RequestRetrySettings.retryCount')}
            </label>
            <div className="flex items-center gap-1 rounded-md border border-line bg-surface p-1">
              <IconButton
                icon={Minus}
                label={tr('settings.models.RequestRetrySettings.decreaseRetryCount')}
                size={28}
                iconSize={14}
                disabled={busy || (parse() ?? 0) <= 0}
                onClick={() => save(Math.max(0, (parse() ?? 3) - 1))}
              />
              <input
                id="request-retry-count"
                aria-label={tr('settings.models.RequestRetrySettings.retryCount')}
                type="number"
                inputMode="numeric"
                min="0"
                max="15"
                step="1"
                value={draft}
                disabled={busy}
                onChange={e => {
                  setDraft(e.target.value)
                  setError(null)
                }}
                className="h-7 w-16 rounded-sm bg-transparent px-1 text-center text-ui text-fg tabular-nums outline-none disabled:opacity-50"
              />
              <IconButton
                icon={Plus}
                label={tr('settings.models.RequestRetrySettings.increaseRetryCount')}
                size={28}
                iconSize={14}
                disabled={busy || (parse() ?? 15) >= 15}
                onClick={() => save(Math.min(15, (parse() ?? 3) + 1))}
              />
            </div>
            <Button type="submit" variant="outline" disabled={busy || draft === String(state.maxRetries)}>
              {state.saving ? tr('editor.FileEditor.saving') : tr('files.FileConfirm.save')}
            </Button>
            <span className="text-meta text-fg-muted">{tr('settings.models.RequestRetrySettings.n015Retries')}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-meta text-fg-muted">{tr('settings.models.RequestRetrySettings.presets')}</span>
            {[0, 1, 3, 5, 10].map(value => (
              <button
                key={value}
                type="button"
                aria-label={tr('settings.models.RequestRetrySettings.setRetries', { p0: value })}
                disabled={busy}
                onClick={() => save(value)}
                className={cn(
                  'press h-7 min-w-8 rounded-full px-2.5 text-meta tabular-nums hover:bg-hover disabled:opacity-50',
                  state.maxRetries === value ? 'bg-selected text-fg' : 'bg-subtle text-fg-secondary',
                )}
              >
                {value}
              </button>
            ))}
          </div>
          <p className="text-meta text-fg-muted">
            {state.maxRetries === 0
              ? tr('settings.models.RequestRetrySettings.doNotRetryAfter')
              : tr('settings.models.RequestRetrySettings.upToRetriesAfter', {
                  p0: state.maxRetries,
                  p1: state.maxRetries + 1,
                })}
          </p>
        </form>
      )}
      {state.maxRetries === null && (
        <p className="text-meta text-fg-muted">{tr('settings.models.RequestRetrySettings.useEnginesCurrentRetry')}</p>
      )}
      {(error || state.error) && (
        <p role="alert" className="mt-2 text-meta text-danger">
          {translateMessage(error ?? state.error ?? '')}
        </p>
      )}
      {state.maxRetries !== null && (
        <Button variant="ghost" icon={RotateCcw} className="mt-2 -ml-3" disabled={busy} onClick={() => save(null)}>
          {tr('settings.models.RequestRetrySettings.resetToDefault')}
        </Button>
      )}
    </SettingRow>
  )
}
