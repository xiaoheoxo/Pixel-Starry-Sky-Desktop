import { scrollInPane } from '@/ui/scrollInPane'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, ShoppingCart, Smartphone, X, Zap } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { allMessages, tr, type TranslationKey } from '../../../i18n/core'
import { Button, IconButton, Segmented, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useAccount } from '@/features/account'
import type { MobileAccess, MobilePairing, MobileSeats, MobileState } from '../../../../../shared/types/mobile'
import { GroupTitle, SectionTitle, SettingRow, Toggle } from '../../settings/SettingRow'
import { StorePages } from '../../account/settings/StorePages'
import { QrCode } from '@/ui/QrCode'
import { useTheme } from '../../appearance/ThemeProvider'
import { MAX_PAIRED, deviceRows, shortDesktop, type DeviceRow } from './seatsLogic'

/** 远程席位和设备在线状态多久重读一次（设置页开着时） */
const SEATS_POLL_MS = 30_000

/**
 * 设置 › 手机（docs/mobile-remote.md §5.4）：开关、中转地址、远程席位、配对二维码、账号下的网页设备。演示 / 浏览器里不显示。
 * 远程席位来自云端 GET /v1/bridge/devices（docs/cloud-admin-seats-plan.md §3–5）；云端旧版本没有这个接口时不显示席位，
 * 设备列表只列本机配对的。
 */
export function MobileSection() {
  const { t, locale } = useI18n()
  const acc = useAccount()
  const bridge = window.pixelsky?.mobile
  const [state, setState] = useState<MobileState | null>(null)
  const [relay, setRelay] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<DeviceRow | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [seats, setSeats] = useState<MobileSeats | null>(null)
  const [seatsError, setSeatsError] = useState<string | null>(null)
  const [seatsLoading, setSeatsLoading] = useState(false)
  const [shop, setShop] = useState<'seats' | 'premium' | null>(null)

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

  const loadSeats = useCallback(() => {
    if (!bridge?.seats) return
    setSeatsLoading(true)
    void bridge.seats().then(
      s => {
        setSeats(s)
        setSeatsError(null)
        setSeatsLoading(false)
      },
      (e: Error) => {
        setSeatsError(e.message)
        setSeatsLoading(false)
      },
    )
  }, [bridge])

  // 席位和在线状态：打开时、连上中转时、本机配对的手机变了时重读，开着时每 30 秒一次
  const linkStatus = state?.status
  const pairedIds = state?.devices.map(d => `${d.id}:${d.online}`).join(',')
  useEffect(() => {
    loadSeats()
  }, [loadSeats, linkStatus, pairedIds])
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) loadSeats()
    }, SEATS_POLL_MS)
    return () => clearInterval(timer)
  }, [loadSeats])

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
  const rows = deviceRows(state.devices, seats)
  const remove = (row: DeviceRow) => {
    setError(null)
    // 本机配对的走原来的移除（本机记录 + 云端）；其它电脑配对的只在云端移除
    if (row.device) run(bridge.revoke(row.id))
    else
      void bridge.removeCloudDevice(row.id).then(
        () => undefined,
        (e: Error) => setError(e.message),
      )
    // 云端的移除是异步的：先从列表里拿掉，过一会儿再读
    setSeats(s => (s?.available ? { ...s, devices: s.devices.filter(d => d.id !== row.id) } : s))
    setTimeout(loadSeats, 1500)
  }

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
        {state.prefs.enabled && acc.status === 'signed-in' && (
          <p className="mt-1 text-meta text-fg-faint">{t('mobile.accountVisible')}</p>
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

      {shown && <p className="mb-4 text-meta text-danger">{shown}</p>}

      {seats?.available && (
        <>
          <GroupTitle>{tr('mobile.seats')}</GroupTitle>
          <SeatsCard
            seats={seats}
            loading={seatsLoading}
            onRefresh={loadSeats}
            shop={shop}
            onShop={setShop}
            onBought={loadSeats}
          />
        </>
      )}
      {!seats && seatsError && (
        <p className="mb-4 text-meta text-fg-faint">{t('mobile.seatsFailed', { p0: errorText(seatsError) ?? '' })}</p>
      )}

      <GroupTitle>{seats?.available ? tr('mobile.devicesAccount') : tr('mobile.devices')}</GroupTitle>
      {seats?.available && <p className="mt-1 text-meta text-fg-muted">{t('mobile.devicesAccountDesc')}</p>}
      {state.pairing ? (
        <Pairing
          pairing={state.pairing}
          now={now}
          onRetry={() => run(bridge.pairStart())}
          onCancel={() => run(bridge.pairCancel())}
          onDecide={accept => run(bridge.pairDecide(accept))}
        />
      ) : (
        <div className="mt-3 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            icon={Smartphone}
            disabled={!state.prefs.enabled || state.status !== 'online' || state.devices.length >= MAX_PAIRED}
            onClick={() => {
              setError(null)
              run(bridge.pairStart())
            }}
          >
            {t('mobile.add')}
          </Button>
          <span className="text-meta text-fg-faint">
            {t('mobile.pairedCount', { p0: String(state.devices.length), p1: String(MAX_PAIRED) })}
          </span>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-meta text-fg-muted">
          {t('mobile.noDevices')}
        </p>
      ) : (
        <ul className="divide-y divide-line-subtle rounded-lg border border-line bg-surface">
          {rows.map(row => (
            <li key={row.id} className="flex items-center gap-3 px-3.5 py-3">
              <span
                className={cn(
                  'relative flex size-8 shrink-0 items-center justify-center rounded-md bg-subtle',
                  row.online ? 'text-fg' : 'text-fg-muted',
                )}
              >
                <Smartphone size={16} strokeWidth={1.5} />
                <span
                  aria-hidden
                  className={cn(
                    'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface',
                    row.online ? 'bg-online' : 'bg-fg-faint',
                  )}
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-ui text-fg">{row.name}</span>
                  {seats?.available && (
                    <Tag tone={row.local ? 'accent' : 'muted'}>
                      {row.local
                        ? t('mobile.thisComputer')
                        : t('mobile.otherComputer', { p0: shortDesktop(row.cloud?.desktopId ?? '') })}
                    </Tag>
                  )}
                  {row.cloud?.pending && <Tag tone="muted">{t('mobile.pendingConfirm')}</Tag>}
                </div>
                <div className="truncate text-meta text-fg-muted">
                  {row.online ? (
                    <span className="text-success">{t('mobile.online')}</span>
                  ) : row.lastSeenAt ? (
                    t('mobile.lastSeen', { p0: time(row.lastSeenAt) })
                  ) : (
                    t('mobile.neverSeen')
                  )}
                  {row.cloud?.lastIp && (
                    <span className="text-fg-faint"> · {t('mobile.lastIp', { p0: row.cloud.lastIp })}</span>
                  )}
                  {row.device && <span className="text-fg-faint"> · {row.device.fingerprint}</span>}
                </div>
              </div>
              {row.device && (
                <Segmented<MobileAccess>
                  label={t('mobile.access.act')}
                  options={[
                    { value: 'act', label: t('mobile.access.act') },
                    { value: 'view', label: t('mobile.access.view') },
                  ]}
                  value={row.device.access}
                  onChange={access => run(bridge.setAccess(row.id, access))}
                />
              )}
              <Button variant="ghost" onClick={() => setRemoving(row)}>
                {t('mobile.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <ConfirmDialog
          title={t('mobile.revoke')}
          description={t(removing.local ? 'mobile.revokeConfirm' : 'mobile.removeOtherConfirm', {
            p0: removing.name,
          })}
          confirmLabel={t('mobile.revoke')}
          cancelLabel={t('mobile.pairCancel')}
          busy={false}
          danger
          onConfirm={() => {
            remove(removing)
            setRemoving(null)
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  )
}

function Tag({ tone, children }: { tone: 'accent' | 'muted'; children: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm px-1.5 py-px text-label font-medium',
        tone === 'accent' ? 'bg-accent-soft text-accent-fg' : 'bg-subtle text-fg-muted',
      )}
    >
      {children}
    </span>
  )
}

/** 远程席位：已用 / 上限、优质节点、购买入口（只列席位 / 优质节点分组的套餐，用账号页同一套购买流程） */
function SeatsCard({
  seats,
  loading,
  onRefresh,
  shop,
  onShop,
  onBought,
}: {
  seats: Extract<MobileSeats, { available: true }>
  loading: boolean
  onRefresh(): void
  shop: 'seats' | 'premium' | null
  onShop(kind: 'seats' | 'premium' | null): void
  onBought(): void
}) {
  const { t } = useI18n()
  const acc = useAccount()
  const full = seats.limit > 0 && seats.used >= seats.limit
  const percent = seats.limit > 0 ? Math.min(100, Math.round((seats.used / seats.limit) * 100)) : 0
  const groups = shop === 'seats' ? seats.seatGroups : shop === 'premium' ? seats.premiumGroups : []
  const account = acc.status === 'signed-in' ? acc.account : null
  return (
    <div className="mt-3 mb-5 rounded-lg border border-line bg-surface">
      <div className="flex items-start gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-title leading-none font-semibold text-fg tabular-nums">
              {seats.limit > 0
                ? t('mobile.seatsUsed', { p0: String(seats.used), p1: String(seats.limit) })
                : t('mobile.seatsUnlimited', { p0: String(seats.used) })}
            </span>
            {full && <span className="text-meta text-warn">{t('mobile.seatsFull')}</span>}
          </div>
          <div
            role="progressbar"
            aria-label={t('mobile.seats')}
            aria-valuemin={0}
            aria-valuemax={seats.limit}
            aria-valuenow={seats.used}
            className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-subtle"
          >
            <div
              className={cn('h-full rounded-full', full ? 'bg-warn' : 'bg-accent')}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2.5 text-meta text-fg-muted">{t('mobile.seatsDesc')}</p>
          <p className="mt-2 flex items-center gap-1.5 text-meta text-fg-secondary">
            <Zap size={13} strokeWidth={1.75} className={seats.premium ? 'text-accent-fg' : 'text-fg-faint'} />
            {t('mobile.premium')}
            <span className={seats.premium ? 'text-accent-fg' : 'text-fg-muted'}>
              {seats.premium ? t('mobile.premiumOn') : t('mobile.premiumOff')}
            </span>
          </p>
        </div>
        <IconButton icon={RefreshCw} label={t('mobile.seatsRefresh')} disabled={loading} onClick={onRefresh} />
      </div>
      {account && (seats.seatGroups.length > 0 || seats.premiumGroups.length > 0) && (
        <div className="flex flex-wrap gap-2 border-t border-line-subtle px-4 py-3">
          {seats.seatGroups.length > 0 && (
            <Button
              variant={shop === 'seats' ? 'subtle' : 'outline'}
              icon={ShoppingCart}
              aria-expanded={shop === 'seats'}
              onClick={() => onShop(shop === 'seats' ? null : 'seats')}
            >
              {t('mobile.buySeats')}
            </Button>
          )}
          {seats.premiumGroups.length > 0 && (
            <Button
              variant={shop === 'premium' ? 'subtle' : 'outline'}
              icon={Zap}
              aria-expanded={shop === 'premium'}
              onClick={() => onShop(shop === 'premium' ? null : 'premium')}
            >
              {t('mobile.buyPremium')}
            </Button>
          )}
        </div>
      )}
      {account && shop && groups.length > 0 && (
        <div className="border-t border-line-subtle p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-ui font-medium text-fg">
              {shop === 'seats' ? t('mobile.shopSeats') : t('mobile.shopPremium')}
            </span>
            <IconButton icon={X} label={t('mobile.shopClose')} onClick={() => onShop(null)} />
          </div>
          {/* key：换席位 / 优质节点时重置购买流程 */}
          <StorePages
            key={shop}
            tab="plans"
            account={account}
            planGroups={groups}
            onRefreshAccount={async () => {
              const result = await acc.refresh()
              onBought()
              return result
            }}
          />
        </div>
      )}
    </div>
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
