// 订阅账号多开的界面件（docs/ui/engine-accounts.md §6，样式稿 docs/ui/multi-account-mockup.html）：
// 账号选择列表（授权卡片的「切换账号」下拉、模型菜单的子菜单共用）、添加 / 重新登录的进度行
import { useEffect, useState } from 'react'
import { Check, Plus, Users } from 'lucide-react'
import type { AccountEngine, EngineAccount, EngineAccountQuota } from '@pixelsky/protocol'
import { cn, Spinner, useToast } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { planLabel } from './channelLabels'
import { cancelLogin, clearLogin, loginRunning, sendLoginCode, startLogin, useEngineLogin } from './loginStore'
import {
  accountName,
  loadAccountsQuota,
  quotaWindows,
  switchAccount,
  useAccounts,
  useAccountsQuota,
} from './accountsStore'

export function AccountAvatar({ account, small }: { account: EngineAccount; small?: boolean }) {
  const letter = (account.email || account.label || '?').trim().charAt(0).toUpperCase()
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-selected font-semibold text-fg-secondary',
        small ? 'size-5 text-[10px]' : 'size-7 text-meta',
        account.status === 'expired' && 'opacity-60',
      )}
    >
      {letter}
    </span>
  )
}

/** 细额度条：用到 80% 变黄，用完变红 */
export function QuotaBar({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, percent))
  return (
    <span className="inline-block h-1 w-10 shrink-0 overflow-hidden rounded-full bg-selected align-middle">
      <span
        className={cn('block h-full rounded-full', p >= 100 ? 'bg-danger' : p >= 80 ? 'bg-warn' : 'bg-success')}
        style={{ width: `${p}%` }}
      />
    </span>
  )
}

export function PlanTag({ plan }: { plan: string | null }) {
  if (!plan) return null
  return (
    <span className="shrink-0 rounded bg-subtle px-1.5 text-label leading-[17px] font-medium text-fg-secondary">
      {planLabel(plan)}
    </span>
  )
}

/** 一行额度简写「5 小时 39% · 周 61%」；读不到为 null */
export function quotaSummary(q: EngineAccountQuota | undefined): { text: string; used: number } | null {
  const { short, week } = quotaWindows(q)
  if (!short && !week) return null
  const parts: string[] = []
  if (short) parts.push(tr('accounts.shortPct', { p: Math.round(short.usedPercent) }))
  if (week) parts.push(tr('accounts.weekPct', { p: Math.round(week.usedPercent) }))
  const used = Math.max(short?.usedPercent ?? 0, week?.usedPercent ?? 0, q?.blocked ? 100 : 0)
  return { text: parts.join(' · '), used }
}

/**
 * 账号选择列表：已存的账号（带额度），点一下切换；登录失效的给「重新登录」。
 * 下面是添加账号、管理账号，footer 是调用方加的（取消授权、说明）
 */
export function AccountPickList({
  engine,
  onDone,
  onManage,
  footer,
}: {
  engine: AccountEngine
  /** 选了账号 / 开始登录后（关菜单） */
  onDone: () => void
  onManage: () => void
  footer?: React.ReactNode
}) {
  useI18n()
  const toast = useToast()
  const list = useAccounts(engine)
  const quota = useAccountsQuota(engine)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    void loadAccountsQuota(engine)
  }, [engine])
  if (!list) return null
  const pick = (a: EngineAccount): void => {
    if (a.id === list.current || busy) return
    setBusy(a.id)
    void switchAccount(engine, a.id)
      .then(() => onDone())
      .catch((e: unknown) => toast(translateMessage((e as Error).message)))
      .finally(() => setBusy(null))
  }
  return (
    <div data-account-list={engine}>
      <p className="px-2 pt-1 pb-1.5 text-label text-fg-faint">{tr('accounts.pickHint')}</p>
      {list.accounts.map(a => {
        const q = quotaSummary(quota.find(x => x.id === a.id))
        const current = a.id === list.current
        const expired = a.status === 'expired'
        return (
          <div
            key={a.id}
            data-account={a.id}
            className={cn(
              'flex min-h-[42px] items-center gap-2.5 rounded-md px-2 py-1',
              current ? 'bg-hover' : 'hover:bg-hover',
            )}
          >
            <button
              type="button"
              data-menu-item
              disabled={expired}
              onClick={() => pick(a)}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default"
              title={a.email ?? undefined}
            >
              <AccountAvatar account={a} small />
              <span className="min-w-0 flex-1">
                <span className={cn('flex items-center gap-1.5 text-ui', expired ? 'text-fg-muted' : 'text-fg')}>
                  <span className="truncate">{a.email ?? accountName(a)}</span>
                  <PlanTag plan={a.plan} />
                  {a.label && a.email && <span className="shrink-0 text-label text-fg-muted">{a.label}</span>}
                </span>
                <span className="flex items-center gap-1.5 text-label text-fg-muted tabular-nums">
                  {expired ? (
                    <span className="rounded-full bg-warn/15 px-1.5 text-warn">{tr('accounts.expired')}</span>
                  ) : q ? (
                    <>
                      <QuotaBar percent={q.used} />
                      {q.text}
                    </>
                  ) : null}
                </span>
              </span>
              {busy === a.id ? <Spinner /> : current && <Check size={14} className="shrink-0 text-accent-fg" />}
            </button>
            {expired && (
              <button
                type="button"
                onClick={() => {
                  void startLogin(engine, 'browser', a.id)
                  onManage()
                }}
                className="shrink-0 rounded px-1.5 py-0.5 text-label text-accent-fg hover:bg-selected"
              >
                {tr('accounts.relogin')}
              </button>
            )}
          </div>
        )
      })}
      <div role="separator" className="my-1 border-t border-line-subtle" />
      <button
        type="button"
        data-menu-item
        onClick={() => {
          void startLogin(engine, 'browser', 'add')
          onManage()
        }}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-fg-secondary hover:bg-hover hover:text-fg"
      >
        <Plus size={15} strokeWidth={1.5} />
        {tr('accounts.add')}
      </button>
      <button
        type="button"
        data-menu-item
        onClick={onManage}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-fg-secondary hover:bg-hover hover:text-fg"
      >
        <Users size={15} strokeWidth={1.5} />
        {tr('accounts.manageMore')}
      </button>
      {footer}
    </div>
  )
}

/**
 * 添加 / 重新登录账号的进度（账号表最后一行）；没有在登录、也没有刚失败的不显示。
 * Claude 登录有时要把网页上的授权码粘回来（没有设备码登录），下面多一个粘贴框（engine-accounts-claude.md §1）
 */
export function AccountLoginRow({ engine, names }: { engine: AccountEngine; names: Record<string, string> }) {
  useI18n()
  const login = useEngineLogin(engine)
  const [copied, setCopied] = useState(false)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  if (!login?.target) return null
  const running = loginRunning(login)
  if (!running && login.phase !== 'failed') return null
  const title =
    login.target === 'add'
      ? tr('accounts.adding')
      : tr('accounts.reloggingIn', { name: names[login.target] ?? login.target })
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
  const pasteCode = running && engine === 'claude' && login.phase !== 'verify'
  return (
    <div
      data-account-login={login.target}
      className={cn('border-t border-line-subtle px-4 py-3 text-meta', running ? 'bg-accent/10' : 'bg-danger/10')}
    >
      <div className="flex items-center gap-3">
        {running && <Spinner />}
        <span className="min-w-0 flex-1 text-fg-secondary">
          {running ? (
            <>
              <span className="font-medium text-fg">{title}</span>
              {' · '}
              {login.userCode ? tr('accounts.deviceCode', { code: login.userCode }) : tr('accounts.addingHint')}
              {login.url && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(login.url!)
                    setCopied(true)
                  }}
                  className="ml-2 text-accent-fg hover:underline"
                >
                  {copied ? tr('accounts.linkCopied') : tr('accounts.copyLink')}
                </button>
              )}
            </>
          ) : (
            <span className="text-danger">
              {tr('accounts.addFailed', { error: translateMessage(login.error ?? '') })}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={() => (running ? void cancelLogin(engine) : clearLogin(engine))}
          className="shrink-0 rounded px-2 py-1 text-fg-secondary hover:bg-hover hover:text-fg"
        >
          {tr('accounts.cancel')}
        </button>
      </div>
      {pasteCode && (
        <form
          data-account-code
          className="mt-2 flex items-center gap-2 pl-7"
          onSubmit={e => {
            e.preventDefault()
            submitCode()
          }}
        >
          <span className="shrink-0 text-fg-muted">{tr('accounts.pasteCodeHint')}</span>
          <input
            value={code}
            onChange={e => setCode(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-label={tr('modelChannels.auth.codePlaceholder')}
            placeholder={tr('modelChannels.auth.codePlaceholder')}
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 font-mono text-meta text-fg outline-none placeholder:font-sans placeholder:text-fg-faint focus:border-line-strong"
          />
          <button
            type="submit"
            disabled={!code.trim()}
            className="shrink-0 rounded px-2 py-1 text-accent-fg hover:bg-selected disabled:cursor-default disabled:text-fg-faint disabled:hover:bg-transparent"
          >
            {tr('accounts.pasteCode')}
          </button>
        </form>
      )}
      {codeError && (
        <p role="alert" className="mt-1 pl-7 text-danger">
          {translateMessage(codeError)}
        </p>
      )}
    </div>
  )
}
