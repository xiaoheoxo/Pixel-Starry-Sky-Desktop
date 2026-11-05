import { useEffect, useState } from 'react'
import { Button, cn, Select } from '@/ui'
import { QrCode } from '@/ui/QrCode'
import { useI18n } from '@/i18n/I18nProvider'
import { translateMessage, type TranslationKey } from '@/i18n/core'
import { useTheme } from '@/features/appearance/ThemeProvider'
import { FIELD } from '@/features/settings/engines/parts'
import { SectionTitle } from '@/features/settings/SettingRow'
import { PackBadge } from '@/features/settings/extensions/PackBadge'
import type { ImChannelState, ImConnectInput, ImState, ImTarget, ImTargetChannel } from '../../../../shared/types/im'

// 设置 › 消息通道（docs/ui/one-click-connectors.md）：在 QQ、微信里指挥这台电脑上的 AI

const PAIR_MINUTES = 5
const DESTINATIONS: { value: ImTarget; title: TranslationKey; desc: TranslationKey }[] = [
  { value: 'session', title: 'im.dest.session', desc: 'im.dest.sessionDesc' },
  { value: 'channel', title: 'im.dest.channel', desc: 'im.dest.channelDesc' },
]

const errorText = (e: unknown): string => translateMessage((e as Error)?.message ?? String(e))

function ChannelCard({
  channel,
  onAction,
}: {
  channel: ImChannelState
  onAction: (action: () => Promise<ImState> | undefined) => Promise<void>
}) {
  const { t } = useI18n()
  const { resolved } = useTheme()
  const bridge = window.pixelsky?.im
  const { platform } = channel
  const [appId, setAppId] = useState(channel.appId ?? '')
  const [appSecret, setAppSecret] = useState('')
  const [accepted, setAccepted] = useState(false)
  const retrying = channel.error === 'network' || channel.error === 'qqIp' || channel.error === 'qqClosed'
  const connected = channel.status !== 'off' && (channel.status !== 'error' || retrying)
  const wechat = platform === 'wechat'
  const canConnect =
    (channel.accepted || accepted) && (wechat || (!!appId.trim() && (channel.configured || !!appSecret.trim())))

  const connect = (): void => {
    const input: ImConnectInput = wechat ? { accepted } : { accepted, appId, appSecret }
    void onAction(() => bridge?.connect(platform, input)).then(() => setAppSecret(''))
  }

  const tone = channel.status === 'error' ? 'danger' : channel.status === 'online' ? 'info' : 'neutral'
  const statusKey: TranslationKey =
    channel.status === 'online' && channel.bound ? 'im.status.bound' : (`im.status.${channel.status}` as TranslationKey)

  return (
    <div data-im-channel={platform} className="rounded-md border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui font-medium text-fg">{t(wechat ? 'im.wechat.name' : 'im.qq.name')}</span>
        <PackBadge tone={tone}>{t(statusKey)}</PackBadge>
        {wechat && <PackBadge tone="warn">{t('im.experimental')}</PackBadge>}
      </div>
      <p className="mt-1 text-meta text-fg-muted">{t(wechat ? 'im.wechat.desc' : 'im.qq.desc')}</p>

      {channel.error && (
        <p role="alert" className="mt-2 text-meta text-danger">
          {t(`im.error.${channel.error}` as TranslationKey, { code: channel.errorDetail ?? '' })}
          {channel.error === 'qqIp' && channel.errorDetail && (
            <>
              {' '}
              <span className="selectable">{t('im.error.qqIpValue', { ip: channel.errorDetail })}</span>
            </>
          )}
        </p>
      )}

      {!connected && (
        <div className="mt-3 space-y-3">
          {!wechat && (
            <>
              <p className="text-meta text-fg-muted">{t('im.qq.help')}</p>
              <label className="block">
                <span className="block text-meta text-fg-muted">{t('im.qq.appId')}</span>
                <input
                  className={`${FIELD} mt-1 font-mono`}
                  autoComplete="off"
                  spellCheck={false}
                  value={appId}
                  onChange={e => setAppId(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="block text-meta text-fg-muted">{t('im.qq.appSecret')}</span>
                <input
                  className={`${FIELD} mt-1 font-mono`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={appSecret}
                  placeholder={channel.configured ? t('im.qq.keep') : ''}
                  onChange={e => setAppSecret(e.target.value)}
                />
              </label>
            </>
          )}
          {!channel.accepted && (
            <div className="rounded-md bg-subtle p-3">
              <p className="text-meta text-fg-secondary">{t('im.privacy')}</p>
              {wechat && <p className="mt-2 text-meta text-danger">{t('im.wechat.risk')}</p>}
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-meta text-fg">
                <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />
                {t('im.accept')}
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" className="h-7 px-2.5 text-meta" disabled={!canConnect} onClick={connect}>
              {t('im.connect')}
            </Button>
            {(channel.configured || channel.accepted) && (
              <Button
                variant="ghost"
                className="h-7 px-2.5 text-meta"
                onClick={() => {
                  // 清除后要重新确认，勾选不能留着
                  setAccepted(false)
                  void onAction(() => bridge?.forget(platform))
                }}
              >
                {t('im.forget')}
              </Button>
            )}
          </div>
        </div>
      )}

      {channel.qr && (
        <div className="mt-3">
          <QrCode text={channel.qr} label={t('im.wechat.scan')} ecc="M" dark={resolved === 'dark'} />
          <p className="mt-2 text-meta text-fg-muted">{t('im.wechat.scan')}</p>
        </div>
      )}

      {channel.pairing && (
        <div className="mt-3">
          <p className="text-meta text-fg-muted">{t('im.pairHint', { minutes: PAIR_MINUTES })}</p>
          <p className="selectable mt-1 font-mono text-section font-semibold text-fg">{channel.pairing.code}</p>
        </div>
      )}

      {connected && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {channel.status === 'online' &&
            !channel.bound &&
            (channel.pairing ? (
              <Button
                variant="ghost"
                className="h-7 px-2.5 text-meta"
                onClick={() => void onAction(() => bridge?.pairCancel(platform))}
              >
                {t('im.pairCancel')}
              </Button>
            ) : (
              <Button
                variant="primary"
                className="h-7 px-2.5 text-meta"
                onClick={() => void onAction(() => bridge?.pairStart(platform))}
              >
                {t('im.pair')}
              </Button>
            ))}
          {channel.bound && (
            <Button
              variant="ghost"
              className="h-7 px-2.5 text-meta"
              onClick={() => void onAction(() => bridge?.unbind(platform))}
            >
              {t('im.unbind')}
            </Button>
          )}
          <Button
            variant="ghost"
            className="h-7 px-2.5 text-meta"
            onClick={() => void onAction(() => bridge?.disconnect(platform))}
          >
            {t('im.disconnect')}
          </Button>
        </div>
      )}

      {channel.ignored > 0 && <p className="mt-2 text-meta text-fg-faint">{t('im.ignored', { n: channel.ignored })}</p>}
    </div>
  )
}

/** 频道里每个成员在聊天里能不能派活 */
function MemberList({ channel }: { channel: ImTargetChannel }) {
  const { t } = useI18n()
  return (
    <div className="mt-3">
      <div className="text-ui font-medium text-fg">{t('im.members')}</div>
      <p className="mt-1 mb-2 text-meta text-fg-muted">{t('im.membersHint')}</p>
      {channel.members.length === 0 && <p className="text-meta text-fg-faint">{t('im.membersNone')}</p>}
      <ul className="grid gap-1.5">
        {channel.members.map(m => (
          <li key={m.id} data-im-member={m.id} className="flex flex-wrap items-center gap-2 text-meta text-fg">
            <span>{m.name}</span>
            {!m.allowed ? (
              <PackBadge tone="warn">{t('im.member.blocked')}</PackBadge>
            ) : m.local ? (
              <PackBadge tone="info">{t('im.member.ok')}</PackBadge>
            ) : (
              <PackBadge tone="warn">{t('im.member.remote')}</PackBadge>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ImSection() {
  const { t } = useI18n()
  const bridge = window.pixelsky?.im
  const [state, setState] = useState<ImState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge
      .state()
      .then(s => {
        if (alive) setState(s)
      })
      .catch(() => undefined)
    const off = bridge.onChange(setState)
    return () => {
      alive = false
      off()
    }
  }, [bridge])

  const act = async (action: () => Promise<ImState> | undefined): Promise<void> => {
    setError(null)
    try {
      const next = await action()
      if (next) setState(next)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const selected = state?.targets.find(c => c.id === state.channelId)

  return (
    <section data-im-section>
      <SectionTitle>{t('im.title')}</SectionTitle>
      <p className="mb-4 text-meta text-fg-muted">{t('im.intro')}</p>
      {state && !state.cipher && <p className="mb-4 text-meta text-danger">{t('errors.im.noCipher')}</p>}

      {state && (
        <>
          <div className="mb-4">
            <div className="text-ui font-medium text-fg">{t('im.dest')}</div>
            <div role="radiogroup" aria-label={t('im.dest')} className="mt-2 grid gap-2 sm:grid-cols-2">
              {DESTINATIONS.map(d => (
                <button
                  key={d.value}
                  type="button"
                  role="radio"
                  aria-checked={state.target === d.value}
                  data-im-dest={d.value}
                  className={cn(
                    'rounded-md border p-3 text-left hover:bg-hover',
                    state.target === d.value ? 'border-accent-line bg-subtle' : 'border-line',
                  )}
                  onClick={() => void act(() => bridge?.setTarget(d.value, null))}
                >
                  <span className="block text-ui font-medium text-fg">{t(d.title)}</span>
                  <span className="mt-0.5 block text-meta text-fg-muted">{t(d.desc)}</span>
                </button>
              ))}
            </div>
          </div>
          {state.target === 'session' ? (
            <div className="mb-4">
              <div className="text-ui font-medium text-fg">{t('im.project')}</div>
              <p className="mt-1 mb-2 text-meta text-fg-muted">{t('im.projectHint')}</p>
              <Select
                label={t('im.project')}
                value={state.projectId ?? ''}
                placeholder={t('im.projectNone')}
                options={state.projects.map(p => ({ value: p.id, label: p.name }))}
                onChange={id => void act(() => bridge?.setProject(id))}
              />
            </div>
          ) : (
            <div className="mb-4">
              <div className="text-ui font-medium text-fg">{t('im.channel')}</div>
              <p className="mt-1 mb-2 text-meta text-fg-muted">{t('im.channelHint')}</p>
              <Select
                label={t('im.channel')}
                value={state.channelId ?? ''}
                placeholder={t('im.channelNone')}
                options={state.targets.map(c => ({ value: c.id, label: `# ${c.name}` }))}
                onChange={id => void act(() => bridge?.setTarget('channel', id))}
              />
              {selected && <MemberList channel={selected} />}
            </div>
          )}
          <p className="mb-4 text-meta text-fg-muted">
            {t(state.target === 'channel' ? 'im.rulesChannel' : 'im.rules')}
          </p>
          {error && (
            <p role="alert" className="mb-4 text-meta text-danger">
              {error}
            </p>
          )}
          <div className="grid gap-3">
            {state.channels.map(channel => (
              <ChannelCard key={channel.platform} channel={channel} onAction={act} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}
