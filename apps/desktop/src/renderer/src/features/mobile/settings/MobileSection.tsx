import { scrollInPane } from '@/ui/scrollInPane'
import { useEffect, useRef, useState } from 'react'
import { Smartphone } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { allMessages, tr, type TranslationKey } from '../../../i18n/core'
import { Button, Segmented, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import type { MobileAccess, MobileDevice, MobilePairing, MobileState } from '../../../../../shared/types/mobile'
import { GroupTitle, SectionTitle, SettingRow, Toggle } from '../../settings/SettingRow'
import { QrCode } from '@/ui/QrCode'
import { useTheme } from '../../appearance/ThemeProvider'

/** 设置 › 手机（docs/mobile-remote.md §5.4）：开关、中转地址、配对二维码、已配对的手机。演示 / 浏览器里不显示 */
export function MobileSection() {
  const { t, locale } = useI18n()
  const bridge = window.pixelsky?.mobile
  const [state, setState] = useState<MobileState | null>(null)
  const [relay, setRelay] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<MobileDevice | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge
      .state()
      .then(s => {
        if (!alive) return
        setState(s)
        setRelay(s.prefs.relay)
      })
      .catch(() => undefined)
    const off = bridge.onChange(s => setState(s))
    return () => {
      alive = false
      off()
    }
  }, [bridge])

  // 二维码倒计时
  const waiting = state?.pairing?.status === 'waiting'
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [waiting])

  if (!bridge || !state) return null

  const run = (task: Promise<MobileState>) =>
    void task.then(setState, (e: Error) => setError(e.message)).then(() => undefined)
  const errorText = (code: string | null) => {
    if (!code) return null
    const key = `mobile.error.${code}`
    return Object.hasOwn(allMessages, key) ? t(key as TranslationKey) : code
  }
  const shown = errorText(error) ?? (state.prefs.enabled ? errorText(state.error) : null)
  const time = (at: number) =>
    new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at)

  return (
    <section>
      <SectionTitle>{tr('mobile.title')}</SectionTitle>
      <p className="mb-5 text-meta text-fg-muted">{t('mobile.intro')}</p>

      <SettingRow
        title={tr('mobile.enable')}
        description={tr('mobile.enableDesc')}
        control={
          <Toggle
            label={t('mobile.enable')}
            checked={state.prefs.enabled}
            onChange={enabled => {
              setError(null)
              run(bridge.setPrefs({ enabled }))
            }}
          />
        }
      >
        {state.prefs.enabled && (
          <p className="flex items-center gap-2 text-meta text-fg-muted">
            <span
              aria-hidden
              className={cn(
                'size-2 rounded-full',
                state.status === 'online' ? 'bg-online' : state.status === 'error' ? 'bg-danger' : 'bg-fg-faint',
              )}
            />
            {t(`mobile.status.${state.status}`)}
            {state.fingerprint && (
              <span className="text-fg-faint">· {t('mobile.fingerprint', { p0: state.fingerprint })}</span>
            )}
          </p>
        )}
      </SettingRow>

      <SettingRow title={tr('mobile.relay')} description={tr('mobile.relayDesc')}>
        <form
          className="flex gap-2"
          onSubmit={e => {
            e.preventDefault()
            setError(null)
            run(bridge.setPrefs({ relay }))
          }}
        >
          <input
            value={relay}
            onChange={e => setRelay(e.target.value)}
            spellCheck={false}
            placeholder={state.relayDefault}
            aria-label={t('mobile.relay')}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-2 font-mono text-ui text-fg outline-none focus:border-accent"
          />
          <Button type="submit" disabled={relay.trim() === state.prefs.relay}>
            {t('mobile.relaySave')}
          </Button>
        </form>
      </SettingRow>

      <SettingRow
        title={tr('mobile.keepAwake')}
        description={tr('mobile.keepAwakeDesc')}
        control={
          <Toggle
            label={t('mobile.keepAwake')}
            checked={state.prefs.keepAwake}
            onChange={keepAwake => run(bridge.setPrefs({ keepAwake }))}
          />
        }
      />
      {shown && <p className="mb-4 text-meta text-danger">{shown}</p>}

      <GroupTitle>{tr('mobile.devices')}</GroupTitle>
      {state.pairing ? (
        <Pairing
          pairing={state.pairing}
          now={now}
          onRetry={() => run(bridge.pairStart())}
          onCancel={() => run(bridge.pairCancel())}
          onDecide={accept => run(bridge.pairDecide(accept))}
        />
      ) : (
        <div className="mt-3 mb-4">
          <Button
            icon={Smartphone}
            disabled={!state.prefs.enabled || state.status !== 'online' || state.devices.length >= 5}
            onClick={() => {
              setError(null)
              run(bridge.pairStart())
            }}
          >
            {t('mobile.add')}
          </Button>
        </div>
      )}
      {state.devices.length === 0 ? (
        <p className="text-meta text-fg-muted">{t('mobile.noDevices')}</p>
      ) : (
        <ul className="divide-y divide-line-subtle">
          {state.devices.map(device => (
            <li key={device.id} className="flex items-center gap-3 py-3">
              <Smartphone size={18} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-ui text-fg">{device.name || device.id}</div>
                <div className="truncate text-meta text-fg-muted">
                  {device.online ? (
                    <span className="text-success">{t('mobile.online')}</span>
                  ) : device.lastSeenAt ? (
                    t('mobile.lastSeen', { p0: time(device.lastSeenAt) })
                  ) : (
                    t('mobile.neverSeen')
                  )}
                  <span className="text-fg-faint"> · {device.fingerprint}</span>
                </div>
              </div>
              <Segmented<MobileAccess>
                label={t('mobile.access.act')}
                options={[
                  { value: 'act', label: t('mobile.access.act') },
                  { value: 'view', label: t('mobile.access.view') },
                ]}
                value={device.access}
                onChange={access => run(bridge.setAccess(device.id, access))}
              />
              <Button variant="ghost" onClick={() => setRemoving(device)}>
                {t('mobile.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <ConfirmDialog
          title={t('mobile.revoke')}
          description={t('mobile.revokeConfirm', { p0: removing.name || removing.id })}
          confirmLabel={t('mobile.revoke')}
          cancelLabel={t('mobile.pairCancel')}
          busy={false}
          danger
          onConfirm={() => {
            run(bridge.revoke(removing.id))
            setRemoving(null)
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  )
}

function Pairing({
  pairing,
  now,
  onRetry,
  onCancel,
  onDecide,
}: {
  pairing: MobilePairing
  now: number
  onRetry(): void
  onCancel(): void
  onDecide(accept: boolean): void
}) {
  const { t } = useI18n()
  const { resolved } = useTheme()
  const box = useRef<HTMLDivElement>(null)
  // 二维码 / 确认框在页面下方：出现时滚到能看见
  useEffect(() => {
    scrollInPane(box.current, 'nearest', { behavior: 'smooth' })
  }, [pairing.status])
  const left = Math.max(0, Math.ceil((pairing.expires - now) / 1000))
  const expired = pairing.status === 'expired' || (pairing.status === 'waiting' && left === 0)
  return (
    <div ref={box} className="mt-3 mb-5 rounded-lg border border-line bg-panel p-4">
      {pairing.status === 'confirm' && pairing.request ? (
        <div>
          <div className="text-ui font-medium text-fg">{t('mobile.pairConfirm', { p0: pairing.request.name })}</div>
          <p className="mt-1 mb-4 text-meta text-fg-muted">
            {t('mobile.pairConfirmHint', { p0: pairing.request.fingerprint })}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => onDecide(true)}>
              {t('mobile.pairAllow')}
            </Button>
            <Button onClick={() => onDecide(false)}>{t('mobile.pairDeny')}</Button>
          </div>
        </div>
      ) : pairing.status === 'accepted' || pairing.status === 'rejected' ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-ui text-fg">
            {t(pairing.status === 'accepted' ? 'mobile.pairDone' : 'mobile.pairRejected')}
          </span>
          <Button onClick={onCancel}>{t('mobile.pairCancel')}</Button>
        </div>
      ) : expired ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-ui text-fg-muted">{t('mobile.pairExpired')}</span>
          <div className="flex gap-2">
            <Button onClick={onRetry}>{t('mobile.pairRetry')}</Button>
            <Button variant="ghost" onClick={onCancel}>
              {t('mobile.pairCancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-5">
          <QrCode text={pairing.offer} label={t('mobile.pairTitle')} dark={resolved === 'dark'} />
          <div className="min-w-0">
            <div className="text-ui font-medium text-fg">{t('mobile.pairTitle')}</div>
            <p className="mt-1 mb-4 text-meta text-fg-muted">
              {t('mobile.pairHint', { p0: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}
            </p>
            <div className="flex flex-wrap gap-2">
              <CopyLinkButton text={pairing.offer} />
              <Button variant="ghost" onClick={onCancel}>
                {t('mobile.pairCancel')}
              </Button>
            </div>
            <p className="mt-2 text-meta text-fg-muted">{t('mobile.pairCopyHint')}</p>
          </div>
        </div>
      )}
    </div>
  )
}

/** 复制配对链接（和二维码同一段文字）；走主进程剪贴板，和终端 / 编辑器一致 */
function CopyLinkButton({ text }: { text: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])
  const copy = () => {
    const write = window.pixelsky?.terminal
      ? window.pixelsky.terminal.clipboardWrite(text)
      : navigator.clipboard.writeText(text)
    void Promise.resolve(write).then(
      () => setState('copied'),
      () => setState('failed'),
    )
  }
  return (
    <>
      <Button onClick={copy}>
        {state === 'copied'
          ? t('mobile.pairCopied')
          : state === 'failed'
            ? t('mobile.pairCopyFailed')
            : t('mobile.pairCopy')}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied' ? t('mobile.pairCopied') : state === 'failed' ? t('mobile.pairCopyFailed') : ''}
      </span>
    </>
  )
}
