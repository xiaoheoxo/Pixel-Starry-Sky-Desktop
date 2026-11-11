import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useEffect, useState } from 'react'
import { Button, cn } from '@/ui'
import { GroupTitle, SectionTitle, SettingRow, Toggle } from './SettingRow'
import { setNotificationPrefs, useNotificationPrefs } from './notifications'
import { inSchedule, nextMorning, type NotificationPrefs } from '../notifications/policy'

const TIME =
  'h-8 rounded-md border border-line bg-surface px-2 text-list text-fg tabular-nums outline-none focus-visible:border-accent'

/** 设置 › 通知（docs/ui/notifications.md §2） */
export function NotificationsSection() {
  const { t, locale } = useI18n()
  const prefs = useNotificationPrefs()
  const [supported, setSupported] = useState<boolean | null>(null)
  const [sent, setSent] = useState(false)
  // 勿扰到期后刷新显示
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    void window.pixelsky?.notifications.supported().then(setSupported, () => setSupported(false))
  }, [])

  const dndActive = prefs.dndUntil !== null && prefs.dndUntil > now
  const time = (at: number) =>
    new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      ...(new Date(at).toDateString() === new Date(now).toDateString() ? {} : { month: 'numeric', day: 'numeric' }),
    }).format(at)
  const row = (key: 'completed' | 'failed' | 'waiting') => (
    <SettingRow
      title={tr(`notifications.${key}.title`)}
      description={tr(`notifications.${key}.desc`)}
      control={
        <Toggle
          label={tr(`notifications.${key}.title`)}
          checked={prefs[key]}
          onChange={value => setNotificationPrefs({ [key]: value } as Partial<NotificationPrefs>)}
        />
      }
    />
  )
  const test = async () => {
    setSent(false)
    await window.pixelsky?.notifications.show({
      id: `test-${Date.now()}`,
      title: t('notifications.title'),
      body: t('notifications.test.body'),
      sessionId: null,
      sound: prefs.sound,
      attention: false,
    })
    setSent(true)
  }

  return (
    <section>
      <SectionTitle>{t('notifications.title')}</SectionTitle>
      <p className="mb-4 text-meta text-fg-muted">{t('notifications.intro')}</p>
      {supported === false && (
        <p className="mb-4 rounded-md bg-subtle px-3 py-2 text-meta text-danger">{t('notifications.unsupported')}</p>
      )}
      <GroupTitle>{tr('notifications.events')}</GroupTitle>
      {row('completed')}
      {row('failed')}
      {row('waiting')}
      <GroupTitle>{tr('notifications.when')}</GroupTitle>
      <SettingRow
        title={tr('notifications.unfocused.title')}
        description={tr('notifications.unfocused.desc')}
        control={
          <Toggle
            label={tr('notifications.unfocused.title')}
            checked={prefs.unfocusedOnly}
            onChange={value => setNotificationPrefs({ unfocusedOnly: value })}
          />
        }
      />
      <SettingRow
        title={tr('notifications.sound.title')}
        description={tr('notifications.sound.desc')}
        control={
          <Toggle
            label={tr('notifications.sound.title')}
            checked={prefs.sound}
            onChange={value => setNotificationPrefs({ sound: value })}
          />
        }
      />
      <SettingRow title={tr('notifications.dnd.title')} description={tr('notifications.dnd.desc')}>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn('mr-1 text-meta', dndActive ? 'font-medium text-warn' : 'text-fg-faint')}
            aria-live="polite"
          >
            {dndActive ? t('notifications.dnd.until', { time: time(prefs.dndUntil!) }) : t('notifications.dnd.off')}
          </span>
          <Button onClick={() => setNotificationPrefs({ dndUntil: Date.now() + 3600_000 })}>
            {t('notifications.dnd.hour')}
          </Button>
          <Button onClick={() => setNotificationPrefs({ dndUntil: nextMorning(new Date()) })}>
            {t('notifications.dnd.morning')}
          </Button>
          {dndActive && (
            <Button variant="ghost" onClick={() => setNotificationPrefs({ dndUntil: null })}>
              {t('notifications.dnd.end')}
            </Button>
          )}
        </div>
      </SettingRow>
      <SettingRow
        title={tr('notifications.schedule.title')}
        description={tr('notifications.schedule.desc')}
        hint={inSchedule(prefs.schedule, new Date(now)) ? tr('notifications.schedule.active') : undefined}
        control={
          <Toggle
            label={tr('notifications.schedule.title')}
            checked={prefs.schedule.enabled}
            onChange={value => setNotificationPrefs({ schedule: { ...prefs.schedule, enabled: value } })}
          />
        }
      >
        <div className={cn('flex flex-wrap items-center gap-3', !prefs.schedule.enabled && 'opacity-55')}>
          <label className="flex items-center gap-2 text-meta text-fg-muted">
            {t('notifications.schedule.from')}
            <input
              type="time"
              value={prefs.schedule.from}
              disabled={!prefs.schedule.enabled}
              className={TIME}
              onChange={e =>
                e.target.value && setNotificationPrefs({ schedule: { ...prefs.schedule, from: e.target.value } })
              }
            />
          </label>
          <label className="flex items-center gap-2 text-meta text-fg-muted">
            {t('notifications.schedule.to')}
            <input
              type="time"
              value={prefs.schedule.to}
              disabled={!prefs.schedule.enabled}
              className={TIME}
              onChange={e =>
                e.target.value && setNotificationPrefs({ schedule: { ...prefs.schedule, to: e.target.value } })
              }
            />
          </label>
        </div>
      </SettingRow>
      <SettingRow
        title={tr('notifications.test.title')}
        description={tr('notifications.test.desc')}
        hint={sent ? tr('notifications.test.sent') : tr('notifications.focusAssist')}
        control={
          <Button disabled={supported === false || !window.pixelsky} onClick={() => void test()}>
            {t('notifications.test.button')}
          </Button>
        }
      />
    </section>
  )
}
