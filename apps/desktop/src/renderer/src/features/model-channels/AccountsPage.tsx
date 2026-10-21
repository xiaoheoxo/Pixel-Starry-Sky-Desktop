// 设置 › 模型通道 › ChatGPT 账号（docs/ui/engine-accounts.md §6）：账号表（5 小时 / 本周额度、切换、重新登录、⋯），
// 添加账号的进度行，「额度用完时自动换账号」开关（默认关，打开才展开细项）
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, MoreHorizontal, Plus, RefreshCw } from 'lucide-react'
import { DEFAULT_ACCOUNT, type AccountEngine, type EngineAccount } from '@pixelsky/protocol'
import { Button, Popover, Segmented, Spinner, Switch, cn, useToast } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { resetShort } from '@/features/session/quota/quotaModel'
import { SectionTitle } from '@/features/settings/SettingRow'
import type { AuthChannel } from './channelModel'
import { loginRunning, startLogin, useEngineLogin } from './loginStore'
import { AccountAvatar, AccountLoginRow, PlanTag, QuotaBar } from './AccountsUI'
import {
  ACCOUNT_ENGINE,
  accountName,
  loadAccountsQuota,
  openAccountsPage,
  quotaWindows,
  removeAccount,
  setAccountAuto,
  switchAccount,
  updateAccount,
  useAccounts,
  useAccountsQuota,
} from './accountsStore'

const ENGINE_NAME: Record<AccountEngine, string> = { codex: 'Codex', claude: 'Claude Code' }

export function AccountsPage({ channel }: { channel: AuthChannel }) {
  useI18n()
  const engine = ACCOUNT_ENGINE[channel]
  // 换了机器（远程上不管理账号）或这条通道不支持：回到模型通道
  const list = useAccounts(engine)
  useEffect(() => {
    if (!engine) openAccountsPage(null)
  }, [engine])
  if (!engine) return null
  return (
    <section data-accounts-page={channel}>
      <SectionTitle>
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => openAccountsPage(null)}
            title={tr('accounts.back')}
            className="text-fg-muted hover:text-fg"
          >
            {tr('modelChannels.title')}
          </button>
          <ChevronRight size={16} className="text-fg-faint" />
          {tr('accounts.pageTitle', { channel: tr(`modelChannels.tab.${channel}`) })}
        </span>
      </SectionTitle>
      <p className="-mt-2 mb-5 text-meta text-fg-muted">
        {tr(engine === 'claude' ? 'accounts.pageDescClaude' : 'accounts.pageDesc', { engine: ENGINE_NAME[engine] })}
      </p>
      {list ? <AccountsTable engine={engine} /> : <Spinner />}
      {list && <AutoSwitchCard engine={engine} />}
    </section>
  )
}

function AccountsTable({ engine }: { engine: AccountEngine }) {
  useI18n()
  const toast = useToast()
  const list = useAccounts(engine)!
  const quota = useAccountsQuota(engine)
  const login = useEngineLogin(engine)
  const [refreshing, setRefreshing] = useState(false)
  const [removing, setRemoving] = useState<EngineAccount | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = (force: boolean): void => {
    setRefreshing(true)
    void loadAccountsQuota(engine, force).finally(() => setRefreshing(false))
  }
  useEffect(() => refresh(false), [engine]) // eslint-disable-line react-hooks/exhaustive-deps
  const adding = loginRunning(login) && login?.target === 'add'
  const names = Object.fromEntries(list.accounts.map(a => [a.id, accountName(a)]))
  const act = (fn: () => Promise<void>): void =>
    void fn().catch((e: unknown) => toast(translateMessage((e as Error).message)))

  return (
    <div data-accounts-table={engine} className="rounded-lg border border-line">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="min-w-0 flex-1 text-ui font-medium text-fg">
          {tr('accounts.list')}
          <span className="font-normal text-fg-muted"> · {list.accounts.length}</span>
        </span>
        <button
          type="button"
          onClick={() => refresh(true)}
          disabled={refreshing}
          title={tr('account.AccountMenu.refresh')}
          className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          <RefreshCw size={13} className={cn(refreshing && 'animate-spin')} />
        </button>
        <Button icon={Plus} disabled={adding} onClick={() => void startLogin(engine, 'browser', 'add')}>
          {tr('accounts.add')}
        </Button>
      </div>
      {list.accounts.length > 0 && (
        <div className="grid h-[30px] grid-cols-[minmax(0,1fr)_120px_120px_132px] items-center gap-3 border-t border-line-subtle bg-subtle px-4 text-label text-fg-faint">
          <span>{tr('accounts.colAccount')}</span>
          <span>{tr('accounts.colShort')}</span>
          <span>{tr('accounts.colWeek')}</span>
          <span />
        </div>
      )}
      {list.accounts.map(a => (
        <AccountRow
          key={a.id}
          engine={engine}
          account={a}
          index={list.accounts.indexOf(a)}
          current={a.id === list.current}
          quota={quota.find(q => q.id === a.id)}
          onSwitch={() => act(() => switchAccount(engine, a.id))}
          onRelogin={() => void startLogin(engine, 'browser', a.id)}
          onRemove={() => {
            setError(null)
            setRemoving(a)
          }}
          onUpdate={patch => act(() => updateAccount(engine, a.id, patch))}
        />
      ))}
      {list.accounts.length <= 1 && (
        <p className="border-t border-line-subtle px-4 py-3 text-meta text-fg-muted">{tr('accounts.empty')}</p>
      )}
      <AccountLoginRow engine={engine} names={names} />
      <p className="border-t border-line-subtle px-4 py-2.5 text-meta text-fg-muted">{tr('accounts.footer')}</p>
      {removing && (
        <ConfirmDialog
          title={tr('accounts.removeTitle', { name: accountName(removing) })}
          description={tr('accounts.removeDesc')}
          confirmLabel={tr('accounts.remove')}
          cancelLabel={tr('accounts.cancel')}
          danger
          busy={busy}
          error={error}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            setBusy(true)
            void removeAccount(engine, removing.id)
              .then(() => setRemoving(null))
              .catch((e: unknown) => setError(translateMessage((e as Error).message)))
              .finally(() => setBusy(false))
          }}
        />
      )}
    </div>
  )
}

function QuotaCell({ window }: { window: ReturnType<typeof quotaWindows>['short'] }) {
  if (!window) return <span className="text-meta text-fg-faint">—</span>
  const used = window.rejected ? 100 : window.usedPercent
  return (
    <span className="min-w-0 text-meta text-fg-secondary tabular-nums">
      <span className="flex items-center gap-1.5">
        <QuotaBar percent={used} />
        {Math.round(used)}%
      </span>
      {window.resetsAt && (
        <span className="block truncate text-label text-fg-faint">{resetShort(window.resetsAt, Date.now())}</span>
      )}
    </span>
  )
}

function AccountRow({
  engine,
  account: a,
  index,
  current,
  quota,
  onSwitch,
  onRelogin,
  onRemove,
  onUpdate,
}: {
  engine: AccountEngine
  account: EngineAccount
  index: number
  current: boolean
  quota: Parameters<typeof quotaWindows>[0]
  onSwitch: () => void
  onRelogin: () => void
  onRemove: () => void
  onUpdate: (patch: { label?: string | null; move?: 'up' }) => void
}) {
  useI18n()
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const login = useEngineLogin(engine)
  const relogging = loginRunning(login) && login?.target === a.id
  const expired = a.status === 'expired'
  const { short, week } = quotaWindows(quota)
  const saveLabel = (): void => {
    setEditing(false)
    const next = input.current?.value.trim() || null
    if (next !== a.label) onUpdate({ label: next })
  }
  return (
    <div
      data-account-row={a.id}
      className="grid min-h-[58px] grid-cols-[minmax(0,1fr)_120px_120px_132px] items-center gap-3 border-t border-line-subtle px-4 py-2 hover:bg-hover"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <AccountAvatar account={a} />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5 text-ui">
            <span className={cn('truncate', expired ? 'text-fg-muted' : 'text-fg')} title={a.email ?? undefined}>
              {a.email ?? accountName(a)}
            </span>
            <PlanTag engine={engine} plan={a.plan} />
            {current && (
              <span className="shrink-0 rounded-full bg-accent/15 px-1.5 text-label leading-[18px] text-accent-fg">
                {tr('accounts.current')}
              </span>
            )}
            {expired && (
              <span className="shrink-0 rounded-full bg-warn/15 px-1.5 text-label leading-[18px] text-warn">
                {tr('accounts.expired')}
              </span>
            )}
          </span>
          {editing ? (
            <input
              ref={input}
              autoFocus
              defaultValue={a.label ?? ''}
              maxLength={40}
              placeholder={tr('accounts.renamePlaceholder')}
              onBlur={saveLabel}
              onKeyDown={e => {
                if (e.key === 'Enter') saveLabel()
                if (e.key === 'Escape') setEditing(false)
              }}
              className="mt-0.5 h-6 w-48 rounded border border-line bg-surface px-1.5 text-meta text-fg outline-none focus:border-fg-faint"
            />
          ) : (
            <span className="block truncate text-label text-fg-muted">
              {[a.label, a.id === DEFAULT_ACCOUNT ? tr('accounts.original') : null].filter(Boolean).join(' · ')}
            </span>
          )}
        </span>
      </span>
      {expired ? (
        <>
          <span className="text-meta text-fg-faint">—</span>
          <span className="text-meta text-fg-faint">—</span>
        </>
      ) : (
        <>
          <QuotaCell window={short} />
          <QuotaCell window={week} />
        </>
      )}
      <span className="relative flex items-center justify-end gap-1">
        {relogging ? (
          <Spinner />
        ) : expired ? (
          <Button onClick={onRelogin}>{tr('accounts.relogin')}</Button>
        ) : (
          !current && <Button onClick={onSwitch}>{tr('accounts.switchTo')}</Button>
        )}
        <button
          type="button"
          aria-label={tr('accounts.more')}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => setMenu(v => !v)}
          className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-selected hover:text-fg"
        >
          <MoreHorizontal size={15} />
        </button>
        <Popover open={menu} onClose={() => setMenu(false)} side="bottom" align="end" className="w-40" role="menu">
          <MenuItem
            onClick={() => {
              setMenu(false)
              setEditing(true)
            }}
          >
            {tr('accounts.rename')}
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(false)
              onRelogin()
            }}
          >
            {tr('accounts.relogin')}
          </MenuItem>
          {index > 0 && (
            <MenuItem
              onClick={() => {
                setMenu(false)
                onUpdate({ move: 'up' })
              }}
            >
              {tr('accounts.moveUp')}
            </MenuItem>
          )}
          {!current && a.id !== DEFAULT_ACCOUNT && (
            <>
              <div role="separator" className="my-1 border-t border-line-subtle" />
              <MenuItem
                danger
                onClick={() => {
                  setMenu(false)
                  onRemove()
                }}
              >
                {tr('accounts.remove')}
              </MenuItem>
            </>
          )}
        </Popover>
      </span>
    </div>
  )
}

function MenuItem({ danger, onClick, children }: { danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      data-menu-item
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center rounded-md px-2 text-left text-ui hover:bg-hover',
        danger ? 'text-danger' : 'text-fg',
      )}
    >
      {children}
    </button>
  )
}

function AutoSwitchCard({ engine }: { engine: AccountEngine }) {
  useI18n()
  const toast = useToast()
  const list = useAccounts(engine)!
  const auto = list.auto
  const set = (patch: Partial<typeof auto>): void =>
    void setAccountAuto(engine, patch).catch((e: unknown) => toast(translateMessage((e as Error).message)))
  return (
    <div data-account-auto={engine} className="mt-4 rounded-lg border border-line">
      <div className="flex items-start gap-4 px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium text-fg">{tr('accounts.autoTitle')}</span>
          <span className="mt-0.5 block text-meta text-fg-muted">{tr('accounts.autoDesc')}</span>
        </span>
        <Switch checked={auto.enabled} label={tr('accounts.autoTitle')} onChange={enabled => set({ enabled })} />
      </div>
      {auto.enabled && (
        <div className="grid gap-2.5 border-t border-line-subtle px-4 py-3 text-meta text-fg-secondary">
          <div className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-fg-muted">{tr('accounts.autoOrder')}</span>
            <Segmented
              label={tr('accounts.autoOrder')}
              value={auto.order}
              onChange={order => set({ order })}
              options={[
                { value: 'list', label: tr('accounts.autoOrderList') },
                { value: 'most', label: tr('accounts.autoOrderMost') },
              ]}
            />
          </div>
          <label className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-fg-muted">{tr('accounts.autoBack')}</span>
            <input type="checkbox" checked={auto.switchBack} onChange={e => set({ switchBack: e.target.checked })} />
            {tr('accounts.autoBackDesc')}
          </label>
          <label className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-fg-muted">{tr('accounts.autoNotice')}</span>
            <input type="checkbox" checked={auto.notice} onChange={e => set({ notice: e.target.checked })} />
            {tr('accounts.autoNoticeDesc')}
          </label>
        </div>
      )}
    </div>
  )
}
