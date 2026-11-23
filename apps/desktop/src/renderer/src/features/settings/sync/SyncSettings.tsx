import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../../i18n/core'
import { Button, Switch, cn } from '@/ui'
import { SYNC_CATEGORIES, type SyncCategory } from './registry'
import { setSyncPrefs, syncNow, useSyncPrefs, useSyncStatus } from './engine'

const CATEGORY_LABEL: Record<SyncCategory, () => string> = {
  appearance: () => tr('settings.sync.appearance'),
  display: () => tr('settings.sync.display'),
  notifications: () => tr('settings.sync.notifications'),
  keybindings: () => tr('settings.sync.keybindings'),
  platform: () => tr('settings.sync.platform'),
  engine: () => tr('settings.sync.engine'),
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return tr('settings.sync.justNow')
  const m = Math.round(s / 60)
  return m < 60 ? tr('settings.sync.minutesAgo', { p0: m }) : tr('settings.sync.hoursAgo', { p0: Math.round(m / 60) })
}

/** 设置 › 账号里的「设置云同步」（docs/ui/settings-sync.md §5.3），登录后显示 */
export function SyncSettings() {
  useI18n()
  const prefs = useSyncPrefs()
  const status = useSyncStatus()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  // 演示模式也显示（同步本身不跑，见 engine.ts）
  if (!window.pixelsky?.settingsSync) return null
  return (
    <div data-setting-title="设置云同步" className="mt-4 rounded-xl bg-surface p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-ui font-medium text-fg">{tr('settings.sync.title')}</div>
          <p className="mt-1 text-meta text-fg-muted">{tr('settings.sync.description')}</p>
        </div>
        <Switch
          checked={prefs.enabled}
          label={tr('settings.sync.title')}
          onChange={enabled => setSyncPrefs({ enabled })}
        />
      </div>
      {prefs.enabled && (
        <>
          <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2 @max-[560px]:grid-cols-2">
            {SYNC_CATEGORIES.map(c => (
              <label key={c} className="flex items-center justify-between gap-2 text-meta text-fg-secondary">
                {CATEGORY_LABEL[c]()}
                <Switch
                  checked={!prefs.off.includes(c)}
                  label={CATEGORY_LABEL[c]()}
                  onChange={on => setSyncPrefs({ off: on ? prefs.off.filter(x => x !== c) : [...prefs.off, c] })}
                />
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle/55 pt-3.5">
            <span className={cn('text-meta', status.error ? 'text-danger' : 'text-fg-muted')} role="status">
              {status.syncing
                ? tr('settings.sync.syncing')
                : status.error
                  ? translateMessage(status.error)
                  : status.lastSyncAt
                    ? tr('settings.sync.lastSync', { p0: ago(status.lastSyncAt, now) })
                    : tr('settings.sync.notYet')}
            </span>
            <Button
              variant="outline"
              icon={RefreshCw}
              className="h-7 px-2.5 text-meta"
              disabled={status.syncing}
              onClick={() => void syncNow()}
            >
              {tr('settings.sync.now')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
