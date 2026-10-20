// 额度用完自动换了账号的提示条（docs/ui/engine-accounts-claude.md §3，样式稿 docs/ui/multi-account-mockup.html「会话 · 自动换了账号」）：
// 文字按 notice.account 拼（界面语言），右边「换回去」「关闭自动切换」跟着当前账号状态变——提示一直留在记录里，不能永远可点
import { Fragment, useEffect, useState } from 'react'
import type { NoticeAccountSwitch } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { useSettings } from '@/features/settings/SettingsProvider'
import { resetClock, resetShort } from '@/features/session/quota/quotaModel'
import { openAccountsPage, setAccountAuto, switchAccount, useAccounts } from './accountsStore'

/** 提示文字：「X 的 5 小时额度用完了，已换到 Y 并重新发送这条消息。16:45 恢复」；恢复时间过了就不写 */
export function accountNoticeText(a: NoticeAccountSwitch, now: number): string {
  const window =
    a.window === 'five_hour'
      ? tr('accounts.notice.fiveHour')
      : a.window === 'seven_day'
        ? tr('accounts.notice.week')
        : null
  const text = window
    ? tr('accounts.notice.switchedWindow', { from: a.fromName, window, to: a.toName })
    : tr('accounts.notice.switched', { from: a.fromName, to: a.toName })
  return a.resetsAt !== null && a.resetsAt > now
    ? tr('accounts.notice.withReset', { text, reset: resetShort(a.resetsAt, now) })
    : text
}

const link = 'press text-accent-fg hover:underline disabled:cursor-default disabled:text-fg-faint disabled:no-underline'

/**
 * 按钮：
 * - 当前账号就是原账号（手动或自动换回了）→ 灰字「已换回 X」
 * - 当前还是换到的那个 → 「换回去」，原账号没到恢复时间时灰掉（现在换回去，下一条多半又用完、又被换走）
 * - 自动切换开着 → 「关闭自动切换」；关了 → 灰字「已关闭自动切换」+「设置」
 * 读不到账号列表（远程机器）时只有文字
 */
export function AccountNoticeActions({
  account,
  onError,
}: {
  account: NoticeAccountSwitch
  onError: (message: string | null) => void
}) {
  useI18n()
  const settings = useSettings()
  const list = useAccounts(account.engine)
  const [now, setNow] = useState(() => Date.now())
  const [acting, setActing] = useState(false)
  // 到了恢复时间「换回去」变成可点
  useEffect(() => {
    const at = account.resetsAt
    if (at === null || at <= now) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(at - now + 500, 2 ** 31 - 1))
    return () => window.clearTimeout(timer)
  }, [account.resetsAt, now])
  if (!list) return null
  const run = (fn: () => Promise<void>): void => {
    setActing(true)
    onError(null)
    fn()
      .catch((e: unknown) => onError((e as Error).message))
      .finally(() => setActing(false))
  }
  const back = list.current === account.from
  const from = list.accounts.find(a => a.id === account.from)
  const canBack = !back && list.current === account.to && !!from && from.status !== 'expired'
  const waiting = account.resetsAt !== null && now < account.resetsAt
  const parts: React.ReactNode[] = []
  if (back)
    parts.push(
      <span key="back" className="text-fg-faint">
        {tr('accounts.notice.switchedBack', { name: account.fromName })}
      </span>,
    )
  else if (canBack)
    parts.push(
      <button
        key="back"
        type="button"
        data-account-notice-back
        disabled={acting || waiting}
        title={
          waiting && account.resetsAt !== null
            ? tr('accounts.notice.switchBackWait', { time: resetClock(account.resetsAt, now) })
            : undefined
        }
        onClick={() => run(() => switchAccount(account.engine, account.from))}
        className={link}
      >
        {tr('accounts.notice.switchBack')}
      </button>,
    )
  if (list.auto.enabled)
    parts.push(
      <button
        key="auto"
        type="button"
        data-account-notice-auto
        disabled={acting}
        onClick={() => run(() => setAccountAuto(account.engine, { enabled: false }))}
        className={link}
      >
        {tr('accounts.notice.autoOff')}
      </button>,
    )
  else
    parts.push(
      <span key="auto" className="text-fg-faint">
        {tr('accounts.notice.autoIsOff')}
      </span>,
      <button
        key="settings"
        type="button"
        onClick={() => {
          openAccountsPage(account.engine === 'claude' ? 'claude' : 'chatgpt')
          settings.openSettings('models')
        }}
        className={link}
      >
        {tr('accounts.notice.settings')}
      </button>,
    )
  return (
    <span data-account-notice className="flex flex-wrap items-center gap-x-1.5 text-meta">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span aria-hidden className="text-fg-faint">
              ·
            </span>
          )}
          {p}
        </Fragment>
      ))}
    </span>
  )
}
