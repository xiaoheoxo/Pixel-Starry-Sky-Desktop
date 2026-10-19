// 第一次打开软件的欢迎页（docs/ui/first-launch-login-mockup.html）：占满窗口，左边品牌区，右边按登录进度换内容。
// 登录走现在的浏览器授权流程（main/account/account.ts）；可以先不登录。看过一次就不再出现（firstLaunchLogic.ts）
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, Clock, ExternalLink, WifiOff, X } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { Button, Logo, Spinner, cn } from '@/ui'
import { isDemo } from '@/data'
import { useEngineState } from '@/features/engine'
import { useAccount, type UseAccountResult } from '@/features/account'
import { useSettings } from '@/features/settings/SettingsProvider'
import type { SectionId } from '@/features/settings/SettingsDialog'
import {
  decideFirstLaunch,
  finishFirstLaunch,
  firstLaunchDone,
  firstLaunchView,
  foundEngines,
  loginRemaining,
  skyPixels,
  LOGIN_WAIT_MS,
  type FirstLaunchDecision,
} from './firstLaunchLogic'
import './firstLaunch.css'

/** 登录成功后几秒自动进入 */
const AUTO_START_SECONDS = 3

export function FirstLaunch() {
  useI18n()
  const ready = useEngineState(s => s.ready)
  const projects = useEngineState(s => s.projects.length)
  const sessions = useEngineState(s => s.sessions.length)
  const acc = useAccount()
  const [decision, setDecision] = useState<FirstLaunchDecision>(() => (isDemo || firstLaunchDone() ? 'skip' : 'wait'))
  useEffect(() => {
    if (decision !== 'wait') return
    const next = decideFirstLaunch({
      demo: isDemo,
      done: firstLaunchDone(),
      engineReady: ready,
      projects,
      sessions,
      account: acc.status,
    })
    // 用过的（有项目、会话或已登录）直接记成看过，以后不再判断
    if (next === 'skip') finishFirstLaunch()
    if (next !== 'wait') setDecision(next)
  }, [decision, ready, projects, sessions, acc.status])

  if (decision !== 'show') return null
  return (
    <FirstLaunchScreen
      acc={acc}
      onDone={() => {
        finishFirstLaunch()
        setDecision('skip')
      }}
    />
  )
}

function FirstLaunchScreen({ acc, onDone }: { acc: UseAccountResult; onDone: () => void }) {
  useI18n()
  const [attempted, setAttempted] = useState(false)
  const view = firstLaunchView(acc.status, acc.failure, attempted)
  const { openSettings } = useSettings()
  const login = (): void => {
    setAttempted(true)
    void acc.login()
  }
  const leaveTo = (section: SectionId): void => {
    onDone()
    openSettings(section)
  }
  // Esc：等授权时取消登录，出错时回到第一步
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (view === 'waiting') void acc.cancelLogin()
      else if (view === 'error') setAttempted(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [view, acc])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-launch-title"
      className="fixed inset-0 z-[90] grid grid-cols-[minmax(340px,38%)_1fr] bg-app text-fg"
    >
      <Brand />
      <main className="relative flex min-w-0 flex-col overflow-y-auto px-10 py-12">
        {/* 窗口顶部可以拖动；右上角的窗口按钮在这一层上面（App 里最后渲染） */}
        <div className="drag absolute inset-x-0 top-0 h-12" />
        <div className="m-auto w-full max-w-[360px]">
          {view === 'welcome' && <Welcome onLogin={login} onSkip={onDone} onSettings={leaveTo} />}
          {view === 'waiting' && <Waiting acc={acc} onLogin={login} />}
          {view === 'success' && <Success acc={acc} onStart={onDone} />}
          {view === 'error' && <Failed acc={acc} onRetry={login} onSkip={onDone} />}
        </div>
      </main>
    </div>
  )
}

function Brand() {
  useI18n()
  const pixels = useMemo(() => skyPixels(), [])
  return (
    <aside className="first-launch-brand drag flex flex-col px-9 pb-9 pt-8">
      <div className="first-launch-sky" aria-hidden="true">
        {pixels.map((p, i) => (
          <i key={i} style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.size, height: p.size, opacity: p.opacity }} />
        ))}
        {[
          [78, 12, 16, 0.95],
          [20, 34, 9, 0.5],
          [86, 52, 10, 0.55],
        ].map(([x, y, size, opacity]) => (
          <svg key={x} viewBox="0 0 20 20" style={{ left: `${x}%`, top: `${y}%`, width: size, height: size, opacity }}>
            <path d="M10 0Q11.6 8.4 20 10Q11.6 11.6 10 20Q8.4 11.6 0 10Q8.4 8.4 10 0Z" />
          </svg>
        ))}
      </div>
      <div className="relative flex items-center gap-2.5 text-ui font-semibold">
        <Logo size={28} />
        {tr('ui.Logo.pixelStarrySky')}
      </div>
      <div className="relative mt-auto">
        <p className="m-0 text-[28px] font-semibold leading-[1.32] tracking-[-0.3px]">
          {tr('onboarding.brandLine1')}
          <br />
          {tr('onboarding.brandLine2')}
          <em>{tr('onboarding.brandEmphasis')}</em>
        </p>
        <p className="first-launch-muted mt-2.5 whitespace-pre-line text-ui">{tr('onboarding.brandSub')}</p>
      </div>
    </aside>
  )
}

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <>
      <h1 id="first-launch-title" className="m-0 text-[24px] font-semibold tracking-[-0.3px]">
        {children}
      </h1>
      {sub && <p className="mb-7 mt-1.5 text-ui text-fg-muted">{sub}</p>}
    </>
  )
}

const BIG = 'h-11 w-full justify-center rounded-[11px] text-[14px]'

function Welcome({
  onLogin,
  onSkip,
  onSettings,
}: {
  onLogin: () => void
  onSkip: () => void
  onSettings: (section: SectionId) => void
}) {
  useI18n()
  const engines = useEngineState(s => s.engines)
  const { checked, found } = foundEngines(engines)
  return (
    <>
      <Title sub={tr('onboarding.welcomeSub')}>{tr('onboarding.welcomeTitle')}</Title>
      <Button variant="primary" icon={ExternalLink} className={BIG} onClick={onLogin}>
        {tr('onboarding.signInBrowser')}
      </Button>
      <p className="mt-3 text-center text-meta text-fg-muted">
        {tr('onboarding.noAccount')}
        <LinkButton onClick={() => void window.pixelsky?.app.open('register')}>{tr('onboarding.register')}</LinkButton>
      </p>
      <div className="my-5 flex items-center gap-3 text-meta text-fg-faint before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
        {tr('onboarding.or')}
      </div>
      <Button className={BIG} onClick={onSkip}>
        {tr('onboarding.skip')}
      </Button>
      {checked && (
        <p className="mt-4 text-center text-meta text-fg-muted">
          <span
            className={cn(
              'mr-2 inline-block size-1.5 rounded-full align-[1px]',
              found.length ? 'bg-accent' : 'bg-fg-faint',
            )}
          />
          {found.length ? (
            tr('onboarding.found', { names: found.join(' / ') })
          ) : (
            <>
              {tr('onboarding.notFound')} ·{' '}
              <LinkButton onClick={() => onSettings('engines')}>{tr('onboarding.install')}</LinkButton>{' '}
              {tr('onboarding.orWord')}{' '}
              <LinkButton onClick={() => onSettings('models')}>{tr('onboarding.addKey')}</LinkButton>
            </>
          )}
        </p>
      )}
    </>
  )
}

function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="no-drag text-accent-fg hover:underline" onClick={onClick}>
      {children}
    </button>
  )
}

function Waiting({ acc, onLogin }: { acc: UseAccountResult; onLogin: () => void }) {
  useI18n()
  const code = acc.authCode ?? ''
  // 倒计时从看到这个核对码开始算（重新打开浏览器会换新的核对码，从头算）
  const started = useRef<{ code: string; at: number }>({ code, at: Date.now() })
  if (started.current.code !== code) started.current = { code, at: Date.now() }
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const left = loginRemaining(started.current.at, now)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(t)
  }, [copied])
  const copyLink = (): void => {
    if (acc.loginUrl) void navigator.clipboard.writeText(acc.loginUrl).then(() => setCopied(true))
  }
  return (
    <>
      <button
        type="button"
        className="no-drag mb-6 inline-flex items-center gap-1.5 text-meta text-fg-muted hover:text-fg"
        onClick={() => void acc.cancelLogin()}
      >
        <ArrowLeft size={14} strokeWidth={1.6} />
        {tr('onboarding.back')}
      </button>
      <Title sub={tr('onboarding.waitSub')}>{tr('onboarding.waitTitle')}</Title>
      <div
        className="first-launch-code flex items-center gap-[5px]"
        aria-label={`${tr('onboarding.codeLabel')} ${code}`}
      >
        {[...code].map((ch, i) =>
          ch === '-' ? (
            <span key={i} className="mx-[3px] h-0.5 w-2.5 shrink-0 rounded-full bg-fg-faint" />
          ) : (
            <span
              key={i}
              className="flex h-11 flex-1 items-center justify-center rounded-lg border border-line-layout bg-subtle text-[21px] font-semibold text-fg"
            >
              {ch}
            </span>
          ),
        )}
      </div>
      <div className="mt-[18px] flex items-center gap-2.5 text-ui text-fg-secondary" role="status">
        <Spinner />
        {tr('onboarding.waiting')}
        <span className="ml-auto text-meta tabular-nums text-fg-muted">{left.text}</span>
      </div>
      <div className="mt-2.5 h-[3px] overflow-hidden rounded-full bg-subtle">
        <div className="h-full rounded-full bg-accent" style={{ width: `${(left.ms / LOGIN_WAIT_MS) * 100}%` }} />
      </div>
      <p className="mt-[18px] flex gap-2 text-meta text-fg-faint">
        <LinkButton onClick={onLogin}>{tr('onboarding.reopen')}</LinkButton>
        <span>·</span>
        {acc.loginUrl ? (
          <LinkButton onClick={copyLink}>{copied ? tr('onboarding.copied') : tr('onboarding.copyLink')}</LinkButton>
        ) : (
          <span>{tr('onboarding.copyLink')}</span>
        )}
      </p>
    </>
  )
}

function Success({ acc, onStart }: { acc: UseAccountResult; onStart: () => void }) {
  useI18n()
  const [left, setLeft] = useState(AUTO_START_SECONDS)
  const start = useRef(onStart)
  start.current = onStart
  useEffect(() => {
    const timer = window.setInterval(() => setLeft(n => n - 1), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (left <= 0) start.current()
  }, [left])
  const parts = [acc.user?.email, acc.balanceText && tr('onboarding.balance', { amount: acc.balanceText })].filter(
    Boolean,
  )
  return (
    <>
      <div className="mb-5 flex size-[46px] items-center justify-center rounded-[14px] bg-accent-soft text-accent-fg">
        <Check size={22} strokeWidth={2.3} />
      </div>
      <Title sub={parts.join(' · ')}>{tr('onboarding.successTitle')}</Title>
      <Button variant="primary" className={BIG} onClick={onStart}>
        {tr('onboarding.start')}
        <ArrowRight size={15} strokeWidth={1.6} />
      </Button>
      <p className="mt-3 text-center text-meta text-fg-faint">{tr('onboarding.autoStart', { n: Math.max(0, left) })}</p>
    </>
  )
}

const FAILURE = {
  timeout: { icon: Clock, title: 'onboarding.timeoutTitle', body: 'onboarding.timeoutBody', danger: false },
  denied: { icon: X, title: 'onboarding.deniedTitle', body: 'onboarding.deniedBody', danger: false },
  network: { icon: WifiOff, title: 'onboarding.networkTitle', body: 'onboarding.networkBody', danger: true },
  failed: { icon: X, title: 'onboarding.failedTitle', body: null, danger: true },
} as const

function Failed({ acc, onRetry, onSkip }: { acc: UseAccountResult; onRetry: () => void; onSkip: () => void }) {
  useI18n()
  const kind = FAILURE[acc.failure ?? 'failed']
  const Icon = kind.icon
  const detail = acc.error ? translateMessage(acc.error) : null
  return (
    <>
      <div
        className={cn(
          'mb-5 flex size-[46px] items-center justify-center rounded-[14px]',
          kind.danger ? 'bg-danger/10 text-danger' : 'bg-subtle text-fg-muted',
        )}
      >
        <Icon size={20} strokeWidth={1.7} />
      </div>
      <Title sub={kind.body ? tr(kind.body) : detail}>{tr(kind.title)}</Title>
      {kind.body && detail && acc.failure === 'network' && (
        <p className="-mt-4 mb-6 break-words text-label text-fg-faint">{detail}</p>
      )}
      <div className="flex gap-2">
        <Button variant="primary" className="h-10 flex-1 justify-center rounded-[10px]" onClick={onRetry}>
          {tr('onboarding.retry')}
        </Button>
        <Button variant="ghost" className="h-10 flex-1 justify-center rounded-[10px]" onClick={onSkip}>
          {tr('onboarding.skip')}
        </Button>
      </div>
    </>
  )
}
