import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
// 授权弹窗（docs/ui/model-channels.md §3）：后台跑引擎自己的登录命令，命令会自己打开浏览器；
// Claude 等用户粘授权码，Codex 可以改用设备码；失败时退回内置终端。② ③ 共用
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, CircleCheck, ExternalLink, SquareTerminal } from 'lucide-react'
import { ENGINES } from '@pixelsky/protocol'
import { Button, CopyButton, EngineIcon, Spinner } from '@/ui'
import { translateMessage } from '../../i18n/core'
import { useSettings } from '@/features/settings/SettingsProvider'
import { useOptionalTerminalUi } from '@/features/terminal/TerminalProvider'
import { runMainAction } from '@/features/settings/windowBridge'
import { AUTH_ENGINE, type AuthChannel } from './channelModel'
import { closeAuthDialog, useAuthDialog } from './authDialogStore'
import { cancelLogin, clearLogin, sendLoginCode, startLogin, useChannelEngines, useEngineLogin } from './loginStore'
import { accountText } from './channelLabels'

/** 内置终端里跑的登录命令（兜底） */
const LOGIN_COMMAND = { claude: 'claude auth login', codex: 'codex login' } as const

const openUrl = (url: string): void => {
  if (window.pixelsky?.demo) return
  void window.pixelsky?.projectTools.openExternal(url).catch(() => undefined)
}

export function AuthDialogHost() {
  const channel = useAuthDialog()
  return channel ? <AuthDialog key={channel} channel={channel} /> : null
}

function AuthDialog({ channel }: { channel: AuthChannel }) {
  useI18n()
  const engine = AUTH_ENGINE[channel]
  const name = channel === 'claude' ? 'Claude' : 'ChatGPT'
  const login = useEngineLogin(engine)
  const info = useChannelEngines().find(e => e.id === engine)
  const settings = useSettings()
  // 设置独立窗口里没有终端界面：「在终端里授权」交给主窗口去跑
  const terminal = useOptionalTerminalUi()
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const needsInstall = !info || info.status === 'missing' || info.status === 'outdated' || info.status === 'unsupported'
  const running = !!login && (login.phase === 'starting' || login.phase === 'waiting' || login.phase === 'verify')

  // 打开就开始授权（引擎没装时先让用户去装）
  useEffect(() => {
    if (!needsInstall) void startLogin(engine)
    // 只在打开时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = (): void => {
    if (running) void cancelLogin(engine)
    clearLogin(engine)
    closeAuthDialog()
  }
  const closeRef = useRef(close)
  closeRef.current = close
  // Esc 和点背景一样：正在登录（等授权码、验证中）时不关，免得取消登录、丢掉粘贴的授权码；要退出点「取消」
  const runningRef = useRef(running)
  runningRef.current = running
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.focus({ preventScroll: true })
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      if (!runningRef.current) closeRef.current()
    }
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('keydown', key, true)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const inTerminal = (): void => {
    void cancelLogin(engine)
    clearLogin(engine)
    closeAuthDialog()
    settings.closeSettings()
    const title = tr('modelChannels.auth.terminalTitle', { p0: name })
    if (terminal) void terminal.runScript(title, LOGIN_COMMAND[engine]).then(() => terminal.reveal(true))
    else runMainAction({ kind: 'terminalScript', name: title, command: LOGIN_COMMAND[engine] })
  }
  const submitCode = (): void => {
    const text = code.trim()
    if (!text) return
    setCode('')
    setCodeError(null)
    // 命令已经结束时写不进去：把码放回输入框，写原因
    sendLoginCode(engine, text).catch((e: unknown) => {
      setCode(text)
      setCodeError((e as Error).message)
    })
  }

  const device = login?.method === 'device'
  const title = device
    ? tr('modelChannels.auth.deviceTitle', { p0: name })
    : tr('modelChannels.auth.title', { p0: name })

  let body: React.ReactNode
  if (needsInstall) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p>{tr('modelChannels.auth.needInstall', { p0: ENGINES[engine].name })}</p>
        <Button
          onClick={() => {
            closeAuthDialog()
            settings.openSettings('engines')
          }}
        >
          {tr('modelChannels.action.install')}
        </Button>
      </div>
    )
  } else if (!login || login.phase === 'starting') {
    body = (
      <p className="flex items-center gap-2">
        <Spinner />
        {tr('modelChannels.auth.starting', { p0: ENGINES[engine].name })}
      </p>
    )
  } else if (login.phase === 'done') {
    const account = accountText(info?.account)
    body = (
      <p className="flex items-center gap-2 text-fg">
        <CircleCheck size={16} className="shrink-0 text-success" />
        <span>
          {tr('modelChannels.auth.done')}
          {account && <span className="text-fg-secondary"> · {account}</span>}
        </span>
      </p>
    )
  } else if (login.phase === 'failed' || login.phase === 'cancelled') {
    body = (
      <div className="flex flex-col gap-2">
        <p className="flex items-start gap-2 text-danger">
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          <span className="selectable break-words">
            {login.phase === 'cancelled'
              ? tr('modelChannels.auth.cancelled')
              : login.error
                ? translateMessage(login.error)
                : tr('modelChannels.auth.failed')}
          </span>
        </p>
        <p className="text-meta text-fg-muted">
          {tr('modelChannels.auth.terminalHint', { p0: LOGIN_COMMAND[engine] })}
        </p>
      </div>
    )
  } else if (login.phase === 'verify') {
    body = (
      <p className="flex items-center gap-2">
        <Spinner />
        {tr('modelChannels.auth.verify')}
      </p>
    )
  } else if (device) {
    body = (
      <div className="flex flex-col gap-3">
        <p>{tr('modelChannels.auth.deviceStep')}</p>
        {login.url && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
            <span className="selectable min-w-0 flex-1 truncate font-mono text-meta text-fg">{login.url}</span>
            <CopyButton text={login.url} label={tr('modelChannels.auth.copyLink')} />
            <button
              type="button"
              onClick={() => openUrl(login.url!)}
              className="press flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-meta text-fg-muted hover:bg-hover hover:text-fg"
            >
              <ExternalLink size={13} />
              {tr('modelChannels.auth.openPage')}
            </button>
          </div>
        )}
        {login.userCode ? (
          <div className="flex items-center gap-3">
            <span
              data-auth-user-code
              className="selectable font-mono text-[22px] font-semibold tracking-widest text-fg"
            >
              {login.userCode}
            </span>
            <CopyButton text={login.userCode} label={tr('modelChannels.auth.copyCode')} />
          </div>
        ) : (
          <p className="flex items-center gap-2 text-fg-muted">
            <Spinner />
            {tr('modelChannels.auth.waitingCode')}
          </p>
        )}
        <button
          type="button"
          onClick={() => void startLogin(engine, 'browser')}
          className="self-start text-meta text-accent-fg hover:underline"
        >
          {tr('modelChannels.auth.backToBrowser')}
        </button>
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <p>{tr('modelChannels.auth.browserHint')}</p>
        <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
          <Spinner />
          <span className="shrink-0 text-fg">{tr('modelChannels.auth.waiting')}</span>
          {login.url ? (
            <>
              <span className="min-w-0 flex-1 truncate font-mono text-meta text-fg-muted" title={login.url}>
                {login.url.replace(/^https:\/\//, '')}
              </span>
              <CopyButton text={login.url} label={tr('modelChannels.auth.copyLink')} />
              <button
                type="button"
                onClick={() => openUrl(login.url!)}
                className="press flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-meta text-fg-muted hover:bg-hover hover:text-fg"
              >
                <ExternalLink size={13} />
                {tr('modelChannels.auth.reopen')}
              </button>
            </>
          ) : (
            <span className="flex-1" />
          )}
        </div>
        {engine === 'claude' && (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={e => {
              e.preventDefault()
              submitCode()
            }}
          >
            <label htmlFor={`${titleId}-code`} className="text-meta text-fg-muted">
              {tr('modelChannels.auth.codeLabel')}
            </label>
            <div className="flex gap-2">
              <input
                id={`${titleId}-code`}
                value={code}
                onChange={e => setCode(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                placeholder={tr('modelChannels.auth.codePlaceholder')}
                className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 font-mono text-meta text-fg outline-none placeholder:font-sans placeholder:text-fg-faint focus:border-line-strong"
              />
              <Button type="submit" disabled={!code.trim()}>
                {tr('modelChannels.auth.submitCode')}
              </Button>
            </div>
            {codeError && (
              <p role="alert" className="text-meta text-danger">
                {translateMessage(codeError)}
              </p>
            )}
          </form>
        )}
        {engine === 'codex' && (
          <p className="text-meta text-fg-muted">
            {tr('modelChannels.auth.noBrowser')}{' '}
            <button
              type="button"
              onClick={() => void startLogin(engine, 'device')}
              className="text-accent-fg hover:underline"
            >
              {tr('modelChannels.auth.useDevice')}
            </button>
          </p>
        )}
      </div>
    )
  }

  const finished = !!login && (login.phase === 'failed' || login.phase === 'cancelled')
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-scrim p-4"
      onMouseDown={e => {
        if (e.target === e.currentTarget && !running) close()
      }}
    >
      <div
        ref={ref}
        data-auth-dialog={channel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="pop-in w-full max-w-lg rounded-xl border border-line-card bg-popover p-5 text-fg shadow-popover outline-none"
      >
        <h3 id={titleId} className="flex items-center gap-2 text-section font-semibold">
          <EngineIcon engine={engine} size={18} />
          {title}
        </h3>
        <div className="mt-3 text-list leading-relaxed text-fg-secondary">{body}</div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {finished && (
            <Button variant="ghost" icon={SquareTerminal} onClick={inTerminal}>
              {tr('modelChannels.auth.terminal')}
            </Button>
          )}
          {finished && <Button onClick={() => void startLogin(engine)}>{tr('modelChannels.action.retry')}</Button>}
          {login?.phase === 'done' ? (
            <Button variant="primary" onClick={close}>
              {tr('modelChannels.auth.finish')}
            </Button>
          ) : (
            <Button onClick={close}>
              {running ? tr('modelChannels.auth.cancel') : tr('modelChannels.auth.close')}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
