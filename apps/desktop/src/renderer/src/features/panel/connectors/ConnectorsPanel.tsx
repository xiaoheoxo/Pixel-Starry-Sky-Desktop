// 右侧工作区 › 连接器（docs/ui/connectors.md，样式稿 docs/ui/connectors-mockup.html）：
// 当前会话的 MCP 服务器、实时状态、工具和本会话调用次数；重新连接、这个会话停用 / 启用、登录
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Eye,
  MoreHorizontal,
  PauseCircle,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Wrench,
} from 'lucide-react'
import type { EngineId, ExtensionEntry, McpOp, McpReport } from '@pixelsky/protocol'
import { Button, cn, EngineIcon, IconButton, useToast } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { useEngineState } from '@/features/engine'
import { usePaneState } from '@/features/panes/store'
import { focusedTab, isNewTab, parseFileTab } from '@/features/panes/tree'
import { useSettings } from '@/features/settings/SettingsProvider'
import { isDemo, demo as demoData } from '@/data/demo'
import { EmptyState, PanelCard } from '../PanelSurface'
import { ToolError } from '../ToolsUi'
import {
  buildConnectors,
  countCalls,
  displayName,
  initials,
  summarize,
  tint,
  type Connector,
  type ConnectorStatus,
} from './connectorsModel'

const ENGINE_NAME: Record<EngineId, () => string> = {
  claude: () => 'Claude Code',
  codex: () => 'Codex',
  pixel: () => tr('engine.pixel.name'),
}

/** 头像底色（按名字固定） */
const TILES = [
  'bg-accent-soft text-accent-fg',
  'bg-[color-mix(in_srgb,var(--status-seen)_14%,transparent)] text-[var(--status-seen)]',
  'bg-[color-mix(in_srgb,var(--ultracode)_14%,transparent)] text-[var(--ultracode)]',
  'bg-[color-mix(in_srgb,var(--warn)_16%,transparent)] text-warn',
  'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger',
]

const DOT: Record<ConnectorStatus, string> = {
  connected: 'bg-success',
  pending: 'bg-status-working',
  auth: 'bg-warn',
  failed: 'bg-danger',
  disabled: 'bg-fg-faint',
  idle: 'bg-fg-faint',
}

const STATUS_KEY = {
  connected: 'connectors.statusConnected',
  pending: 'connectors.statusPending',
  auth: 'connectors.statusAuth',
  failed: 'connectors.statusFailed',
  disabled: 'connectors.statusDisabled',
  idle: 'connectors.statusIdle',
} as const

interface SessionView {
  id: string
  engine: EngineId
  cwd: string
  report: McpReport | null
  calls: Record<string, Record<string, number>>
}

const sessionTab = (tab: string | null): string | null => (tab && !isNewTab(tab) && !parseFileTab(tab) ? tab : null)

export function ConnectorsPanel({ active }: { active: boolean }) {
  useI18n()
  const tab = usePaneState(s => focusedTab(s.layout))
  const id = sessionTab(tab)
  // 只取用得到的：流式输出时快照每来一个字都变，结果没变就不重新渲染
  const json = useEngineState(s => {
    if (!active || !id || isDemo) return ''
    const snap = s.snapshots[id]
    const record = snap?.record ?? s.sessions.find(x => x.record.id === id)?.record
    if (!record) return ''
    const view: SessionView = {
      id,
      engine: record.engine,
      cwd: record.cwd,
      report: snap?.mcp ?? null,
      calls: snap ? countCalls(record.engine, snap.items) : {},
    }
    return JSON.stringify(view)
  })
  const live = useMemo(() => (json ? (JSON.parse(json) as SessionView) : null), [json])
  if (isDemo) {
    const d = demoData().connectors
    return (
      <Body
        key="demo"
        view={{ id: 'demo', engine: d.engine, cwd: d.cwd, report: d.report, calls: d.calls }}
        demoEntries={d.entries}
      />
    )
  }
  if (!live)
    return (
      <div className="flex min-h-0 flex-1 p-3">
        <PanelCard>
          <EmptyState icon={Plug} title={tr('connectors.noSession')} hint={tr('connectors.noSessionHint')} />
        </PanelCard>
      </div>
    )
  return <Body key={live.id} view={live} active={active} />
}

function Body({
  view,
  active = true,
  demoEntries,
}: {
  view: SessionView
  active?: boolean
  demoEntries?: ExtensionEntry[]
}) {
  const demo = !!demoEntries
  const settings = useSettings()
  const toast = useToast()
  const [entries, setEntries] = useState<ExtensionEntry[]>(demoEntries ?? [])
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  // 配置：设置 › 扩展的数据（SSH 机器上的会话读不到，只显示引擎报告的）
  useEffect(() => {
    if (demo || !window.pixelsky) return
    let gone = false
    // 扩展连着变几次时只收最后一次读的结果，旧的晚到不覆盖新的
    let seq = 0
    const load = () => {
      const n = ++seq
      return window
        .pixelsky!.extensions.state({ sessionId: view.id })
        .then(s => !gone && n === seq && setEntries(s.entries))
        .catch(() => !gone && n === seq && setEntries([]))
    }
    void load()
    const off = window.pixelsky.extensions.onChange(() => void load())
    return () => {
      gone = true
      off()
    }
  }, [view.id, demo])

  // 打开时取一次最新状态（结果经会话事件进快照）
  useEffect(() => {
    if (demo || !active || !window.pixelsky) return
    void window.pixelsky.engine.mcp(view.id, { kind: 'refresh' }).catch(() => undefined)
  }, [view.id, active, demo])

  const list = useMemo(
    () => buildConnectors(view.engine, view.report, entries, view.calls),
    [view.engine, view.report, entries, view.calls],
  )
  const ops = view.report?.ops ?? []

  const run = async (key: string, op: McpOp) => {
    if (demo || !window.pixelsky) return
    setBusy(key)
    setError('')
    try {
      const result = await window.pixelsky.engine.mcp(view.id, op)
      if (result.url) {
        await window.pixelsky.projectTools.openExternal(result.url)
        toast(tr('connectors.loginOpened'))
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const actions: Actions = {
    busy,
    ops,
    refresh: () => run('refresh', { kind: 'refresh' }),
    reconnect: name => run('reconnect:' + name, { kind: 'reconnect', name }),
    toggle: (name, enabled) => run('toggle:' + name, { kind: 'toggle', name, enabled }),
    login: name => run('login:' + name, { kind: 'login', name }),
    settings: () => settings.openSettings('extensions'),
  }

  const current = selected ? list.find(c => c.name === selected) : undefined
  return (
    <div data-tools-connectors className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      {current ? (
        <Detail connector={current} view={view} actions={actions} back={() => setSelected(null)} />
      ) : (
        <List list={list} view={view} actions={actions} open={setSelected} />
      )}
      <ToolError error={error} />
    </div>
  )
}

interface Actions {
  busy: string | null
  ops: McpReport['ops']
  refresh(): void
  reconnect(name: string): void
  toggle(name: string, enabled: boolean): void
  login(name: string): void
  settings(): void
}

function Avatar({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center font-semibold tracking-tight',
        size === 'lg' ? 'size-10 rounded-[10px] text-ui' : 'size-8 rounded-lg text-meta',
        TILES[tint(name)],
      )}
    >
      {initials(name)}
    </span>
  )
}

function sourceLabel(c: Connector): string {
  switch (c.source) {
    case 'user':
      return tr('connectors.sourceUser')
    case 'local':
      return tr('connectors.sourceLocal')
    case 'project':
      return tr('connectors.sourceProject')
    case 'plugin':
      return tr('connectors.sourcePlugin', { name: c.sourceDetail ?? '' }).trim()
    case 'managed':
      return tr('connectors.sourceManaged')
    case 'builtin':
      return tr('connectors.sourceBuiltin')
    default:
      return c.sourceDetail ?? tr('connectors.sourceEngine')
  }
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function List({
  list,
  view,
  actions,
  open,
}: {
  list: Connector[]
  view: SessionView
  actions: Actions
  open(name: string): void
}) {
  const [query, setQuery] = useState('')
  const [showOff, setShowOff] = useState(false)
  const sum = summarize(list)
  const q = query.trim().toLowerCase()
  const shown = q
    ? list.filter(c => c.name.toLowerCase().includes(q) || c.tools.some(t => t.name.toLowerCase().includes(q)))
    : list
  const group = (...states: ConnectorStatus[]) => shown.filter(c => states.includes(c.status))
  const attention = group('auth', 'failed'),
    connected = group('connected'),
    pending = group('pending'),
    idle = group('idle'),
    off = group('disabled')

  const header = (
    <div className="flex shrink-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <h2 className="text-ui font-semibold text-fg">{tr('connectors.title')}</h2>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-meta text-fg-muted">
          <EngineIcon engine={view.engine} size={12} />
          <span className="truncate" title={view.cwd}>
            {tr('connectors.session', { engine: ENGINE_NAME[view.engine]() })} · {baseName(view.cwd)}
          </span>
        </p>
      </div>
      <IconButton
        icon={RefreshCw}
        label={tr('connectors.refresh')}
        disabled={actions.busy === 'refresh'}
        onClick={actions.refresh}
      />
      <IconButton icon={Settings2} label={tr('connectors.openSettings')} onClick={actions.settings} />
    </div>
  )

  if (!list.length)
    return (
      <>
        {header}
        <div className="flex flex-col items-center px-2 pb-2 pt-7 text-center">
          <div className="mb-3.5 flex size-12 items-center justify-center rounded-xl bg-accent-soft text-accent-fg">
            <Plug size={20} strokeWidth={1.5} />
          </div>
          <p className="text-ui font-semibold text-fg">{tr('connectors.emptyTitle')}</p>
          <p className="mt-1.5 max-w-[25rem] text-meta text-fg-muted">{tr('connectors.emptyHint')}</p>
          <p className="mt-1.5 max-w-[25rem] text-label text-fg-faint">{tr('connectors.emptyNote')}</p>
          <Button variant="primary" icon={Plus} className="mt-4" onClick={actions.settings}>
            {tr('connectors.add')}
          </Button>
        </div>
      </>
    )

  return (
    <>
      {header}
      {view.report && !view.report.live && <Note>{tr('connectors.notLive')}</Note>}
      {!view.report && <Note>{tr('connectors.idleHint')}</Note>}
      <div className="grid shrink-0 grid-cols-4 rounded-lg border border-line-card bg-surface">
        <Stat value={sum.connected} label={tr('connectors.statConnected')} dot />
        <Stat value={sum.attention} label={tr('connectors.statAttention')} warn={sum.attention > 0} />
        <Stat value={sum.tools} label={tr('connectors.statTools')} />
        <Stat value={sum.calls} label={tr('connectors.statCalls')} />
      </div>
      {list.length > 3 && (
        <label className="flex h-8 shrink-0 items-center gap-2 rounded-md border border-line-card bg-surface px-2.5 text-fg-faint focus-within:border-accent">
          <Search size={14} strokeWidth={1.7} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={tr('connectors.search')}
            className="min-w-0 flex-1 bg-transparent text-list text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
      )}
      {q && !shown.length && <p className="px-1 text-meta text-fg-faint">{tr('connectors.noMatch')}</p>}
      {attention.length > 0 && (
        <Section title={tr('connectors.groupAttention')} count={attention.length}>
          {attention.map(c => (
            <Row key={c.name} c={c} actions={actions} open={open} />
          ))}
        </Section>
      )}
      {connected.length > 0 && (
        <Section title={tr('connectors.groupConnected')} count={connected.length} hint={tr('connectors.sortHint')}>
          {connected.map(c => (
            <Row key={c.name} c={c} actions={actions} open={open} />
          ))}
        </Section>
      )}
      {pending.length > 0 && (
        <Section title={tr('connectors.groupPending')} count={pending.length}>
          {pending.map(c => (
            <Row key={c.name} c={c} actions={actions} open={open} />
          ))}
        </Section>
      )}
      {idle.length > 0 && (
        <Section title={tr('connectors.groupIdle')} count={idle.length}>
          {idle.map(c => (
            <Row key={c.name} c={c} actions={actions} open={open} />
          ))}
        </Section>
      )}
      {off.length > 0 && (
        <div className="shrink-0">
          <button
            type="button"
            aria-expanded={showOff}
            onClick={() => setShowOff(v => !v)}
            className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-meta text-fg-muted hover:bg-hover"
          >
            <ChevronRight size={13} className={cn('transition-transform', showOff && 'rotate-90')} />
            {tr('connectors.groupDisabled', { count: off.length })}
            {!showOff && <span className="truncate text-fg-faint">· {off.map(displayName).join(', ')}</span>}
          </button>
          {showOff && (
            <div className="mt-1.5 overflow-hidden rounded-lg border border-line-card bg-surface">
              {off.map(c => (
                <Row key={c.name} c={c} actions={actions} open={open} />
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mt-1 flex shrink-0 items-center justify-between border-t border-line pt-3 text-meta text-fg-muted">
        <span>{tr('connectors.footer')}</span>
        <button
          type="button"
          className="flex items-center gap-0.5 text-accent-fg hover:underline"
          onClick={actions.settings}
        >
          {tr('connectors.openSettings')}
          <ChevronRight size={13} />
        </button>
      </div>
    </>
  )
}

function Note({ children }: { children: string }) {
  return <p className="shrink-0 rounded-md bg-subtle px-2.5 py-2 text-meta text-fg-muted">{children}</p>
}

function Stat({ value, label, dot, warn }: { value: number; label: string; dot?: boolean; warn?: boolean }) {
  return (
    <div className="min-w-0 px-3 py-2 [&+&]:border-l [&+&]:border-line">
      <b
        className={cn(
          'flex items-center gap-1.5 text-section font-semibold tabular-nums',
          warn ? 'text-warn' : 'text-fg',
        )}
      >
        {dot && value > 0 && <span className="size-[7px] rounded-full bg-success" />}
        {value}
      </b>
      <span className="block truncate text-label text-fg-muted">{label}</span>
    </div>
  )
}

function Section({
  title,
  count,
  hint,
  children,
}: {
  title: string
  count: number
  hint?: string
  children: ReactNode
}) {
  return (
    <section className="flex shrink-0 flex-col gap-2">
      <div className="flex items-baseline justify-between px-0.5">
        <h3 className="text-meta font-semibold text-fg-secondary">
          {title}
          <span className="ml-1.5 font-normal text-fg-faint">{count}</span>
        </h3>
        {hint && <span className="text-label text-fg-faint">{hint}</span>}
      </div>
      <div className="overflow-hidden rounded-lg border border-line-card bg-surface">{children}</div>
    </section>
  )
}

function Row({ c, actions, open }: { c: Connector; actions: Actions; open(name: string): void }) {
  const problem = c.status === 'auth' || c.status === 'failed'
  const meta =
    c.status === 'auth'
      ? tr('connectors.statusAuth') + ' · ' + sourceLabel(c)
      : c.status === 'failed'
        ? tr('connectors.statusFailed') + (c.error ? ': ' + firstLine(c.error) : '') + ' · ' + sourceLabel(c)
        : c.status === 'pending' || c.status === 'idle'
          ? tr(STATUS_KEY[c.status]) + ' · ' + sourceLabel(c)
          : sourceLabel(c)
  return (
    <div
      role="button"
      tabIndex={0}
      data-connector={c.name}
      onClick={() => open(c.name)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open(c.name)
        }
      }}
      className={cn(
        'group grid cursor-pointer grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-l-[3px] border-transparent py-2.5 pl-[9px] pr-3 outline-none hover:bg-hover focus-visible:bg-hover [&+&]:border-t [&+&]:border-t-line',
        c.status === 'auth' && 'border-l-warn',
        c.status === 'failed' && 'border-l-danger',
      )}
    >
      <Avatar name={displayName(c)} />
      <div className="min-w-0">
        <div className="truncate text-list font-medium text-fg">{displayName(c)}</div>
        <div
          title={meta}
          className={cn(
            'mt-px truncate text-meta',
            c.status === 'auth' ? 'text-warn-fg' : c.status === 'failed' ? 'text-danger' : 'text-fg-muted',
          )}
        >
          {meta}
        </div>
      </div>
      <div className="flex items-center gap-2.5 text-meta text-fg-muted">
        {problem ? (
          c.status === 'auth' && actions.ops.includes('login') ? (
            <SmallButton
              busy={actions.busy === 'login:' + c.name}
              onClick={() => actions.login(c.name)}
              label={tr('connectors.login')}
            />
          ) : actions.ops.includes('reconnect') ? (
            <SmallButton
              icon={RefreshCw}
              busy={actions.busy === 'reconnect:' + c.name}
              onClick={() => actions.reconnect(c.name)}
              label={tr('connectors.retry')}
            />
          ) : (
            <Chevron />
          )
        ) : (
          <>
            {c.calls > 0 && (
              <span className="rounded bg-accent-soft px-1.5 text-label tabular-nums text-accent-fg">
                {tr('connectors.used', { count: c.calls })}
              </span>
            )}
            {c.status === 'connected' && (
              <span className="min-w-[3.5rem] text-right tabular-nums">
                {tr('connectors.toolCount', { count: c.tools.length })}
              </span>
            )}
            <Chevron />
          </>
        )}
      </div>
    </div>
  )
}

const Chevron = () => (
  <ChevronRight
    size={15}
    className="text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
  />
)

function SmallButton({
  label,
  onClick,
  busy,
  icon: Icon,
}: {
  label: string
  onClick(): void
  busy: boolean
  icon?: typeof RefreshCw
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={e => {
        e.stopPropagation()
        onClick()
      }}
      className="flex h-6 items-center gap-1 whitespace-nowrap rounded-md border border-line-strong bg-surface px-2 text-meta font-medium text-fg hover:border-fg-faint disabled:opacity-50"
    >
      {Icon && <Icon size={12} strokeWidth={1.7} className={cn(busy && 'animate-spin')} />}
      {label}
    </button>
  )
}

const firstLine = (text: string) => text.split('\n', 1)[0] ?? ''

function Detail({
  connector: c,
  view,
  actions,
  back,
}: {
  connector: Connector
  view: SessionView
  actions: Actions
  back(): void
}) {
  const problem = c.status === 'auth' || c.status === 'failed'
  const [tab, setTab] = useState<'tools' | 'config'>(problem || c.status !== 'connected' ? 'config' : 'tools')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const more = useRef<HTMLButtonElement>(null)
  const canToggle = actions.ops.includes('toggle') && view.report?.live
  const menuActions: MenuAction[] = [
    { label: tr('connectors.editInSettings'), icon: Settings2, run: actions.settings },
    ...(canToggle
      ? [
          c.status === 'disabled'
            ? { label: tr('connectors.enable'), icon: Play, separator: true, run: () => actions.toggle(c.name, true) }
            : {
                label: tr('connectors.disable'),
                icon: PauseCircle,
                separator: true,
                danger: true,
                run: () => actions.toggle(c.name, false),
              },
        ]
      : []),
  ]
  const pill =
    c.status === 'connected'
      ? 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-success'
      : c.status === 'failed'
        ? 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger'
        : c.status === 'auth'
          ? 'bg-[color-mix(in_srgb,var(--warn)_14%,transparent)] text-warn-fg'
          : 'bg-subtle text-fg-muted'
  const sub = [c.status === 'connected' ? tr('connectors.toolCount', { count: c.tools.length }) : null, sourceLabel(c)]
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      <button
        type="button"
        onClick={back}
        className="-mb-1 -ml-1 flex h-6 w-fit shrink-0 items-center gap-1 rounded-md pl-1 pr-2 text-meta text-fg-muted hover:bg-hover hover:text-fg"
      >
        <ChevronLeft size={14} />
        {tr('connectors.back')}
      </button>
      <div className="grid shrink-0 grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3">
        <Avatar name={displayName(c)} size="lg" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 title={c.name} className="truncate text-section font-semibold text-fg">
              {displayName(c)}
            </h2>
            <span
              className={cn('flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-label font-medium', pill)}
            >
              <span className={cn('size-[6px] rounded-full', DOT[c.status])} />
              {tr(STATUS_KEY[c.status])}
            </span>
          </div>
          <p title={sub} className="mt-0.5 truncate text-meta text-fg-muted">
            {sub}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {actions.ops.includes('reconnect') && view.report?.live && c.status !== 'disabled' && (
            <Button
              icon={RefreshCw}
              disabled={actions.busy === 'reconnect:' + c.name}
              className="h-7 px-2.5 text-meta"
              onClick={() => actions.reconnect(c.name)}
            >
              {tr('connectors.reconnect')}
            </Button>
          )}
          <IconButton
            ref={more}
            icon={MoreHorizontal}
            label={tr('connectors.more')}
            onClick={() => {
              const r = more.current!.getBoundingClientRect()
              setMenu({ x: r.right - 192, y: r.bottom + 4 })
            }}
          />
        </div>
      </div>
      {problem && (
        <div
          className={cn(
            'shrink-0 rounded-lg border px-3.5 py-3',
            c.status === 'failed'
              ? 'border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,var(--surface))]'
              : 'border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,var(--surface))]',
          )}
        >
          <p
            className={cn(
              'flex items-center gap-1.5 text-list font-semibold',
              c.status === 'failed' ? 'text-danger' : 'text-warn-fg',
            )}
          >
            <AlertTriangle size={14} strokeWidth={1.8} />
            {tr(c.status === 'failed' ? 'connectors.failedTitle' : 'connectors.authTitle')}
          </p>
          {c.status === 'auth' && <p className="mt-1.5 text-meta text-fg-secondary">{tr('connectors.authHint')}</p>}
          {c.error && (
            <pre className="mt-2.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface/70 px-2.5 py-2 font-mono text-label text-danger">
              {c.error}
            </pre>
          )}
          <div className="mt-3 flex gap-1.5">
            {c.status === 'auth' && actions.ops.includes('login') && view.report?.live && (
              <Button variant="primary" className="h-7 px-2.5 text-meta" onClick={() => actions.login(c.name)}>
                {tr('connectors.login')}
              </Button>
            )}
            {c.status === 'failed' && (
              <Button variant="primary" icon={Settings2} className="h-7 px-2.5 text-meta" onClick={actions.settings}>
                {tr('connectors.editInSettings')}
              </Button>
            )}
            <Button icon={RefreshCw} className="h-7 px-2.5 text-meta" onClick={actions.refresh}>
              {tr('connectors.refresh')}
            </Button>
          </div>
        </div>
      )}
      <div role="tablist" className="flex shrink-0 gap-0.5 border-b border-line">
        {(['tools', 'config'] as const).map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              '-mb-px border-b-2 px-2.5 pb-2 pt-1.5 text-list font-medium',
              tab === id ? 'border-fg text-fg' : 'border-transparent text-fg-muted hover:text-fg',
            )}
          >
            {tr(id === 'tools' ? 'connectors.tabTools' : 'connectors.tabConfig')}
            {id === 'tools' && c.tools.length > 0 && (
              <span className="ml-1 font-normal text-fg-faint">{c.tools.length}</span>
            )}
          </button>
        ))}
      </div>
      {tab === 'tools' ? <Tools c={c} /> : <Config c={c} />}
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={tr('connectors.more')}
          actions={menuActions}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

function Tools({ c }: { c: Connector }) {
  const [filter, setFilter] = useState<'all' | 'read' | 'other'>('all')
  if (!c.tools.length) return <p className="px-1 text-meta text-fg-faint">{tr('connectors.noTools')}</p>
  const read = c.tools.filter(t => t.readOnly).length
  const shown = c.tools.filter(t => (filter === 'all' ? true : filter === 'read' ? t.readOnly : !t.readOnly))
  const chip = (id: typeof filter, label: string, Icon?: typeof Eye) => (
    <button
      type="button"
      aria-pressed={filter === id}
      onClick={() => setFilter(id)}
      className={cn(
        'flex h-6 items-center gap-1 rounded-full border px-2.5 text-meta',
        filter === id ? 'border-fg bg-fg text-surface' : 'border-line-card bg-surface text-fg-secondary hover:bg-hover',
      )}
    >
      {Icon && <Icon size={12} strokeWidth={1.7} />}
      {label}
    </button>
  )
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {chip('all', tr('connectors.filterAll', { count: c.tools.length }))}
        {read > 0 && chip('read', tr('connectors.filterReadOnly', { count: read }), Eye)}
        {read > 0 && chip('other', tr('connectors.filterOther', { count: c.tools.length - read }), Pencil)}
      </div>
      <div className="shrink-0 overflow-hidden rounded-lg border border-line-card bg-surface">
        {shown.map(t => (
          <div
            key={t.name}
            className="grid grid-cols-[1.375rem_minmax(0,1fr)_auto] items-start gap-2.5 px-3 py-2.5 [&+&]:border-t [&+&]:border-line"
          >
            <span
              className={cn(
                'mt-px flex size-[1.375rem] items-center justify-center rounded-md',
                t.readOnly
                  ? 'bg-subtle text-fg-muted'
                  : 'bg-[color-mix(in_srgb,var(--warn)_14%,transparent)] text-warn-fg',
              )}
            >
              {t.readOnly ? <Eye size={12} strokeWidth={1.7} /> : <Wrench size={12} strokeWidth={1.7} />}
            </span>
            <div className="min-w-0">
              <div className="truncate font-mono text-meta font-semibold text-fg">{t.name}</div>
              {t.description && (
                <div title={t.description} className="mt-px line-clamp-2 text-meta text-fg-muted">
                  {t.description}
                </div>
              )}
            </div>
            <span className="pt-0.5 text-label tabular-nums text-fg-faint">
              {c.toolCalls[t.name] ? tr('connectors.toolCalls', { count: c.toolCalls[t.name]! }) : ''}
            </span>
          </div>
        ))}
      </div>
      {read > 0 && (
        <div className="flex shrink-0 flex-wrap gap-x-3.5 gap-y-1 text-label text-fg-faint">
          <span className="flex items-center gap-1">
            <Eye size={12} />
            {tr('connectors.readOnlyHint')}
          </span>
          <span className="flex items-center gap-1">
            <Wrench size={12} />
            {tr('connectors.otherHint')}
          </span>
        </div>
      )}
    </>
  )
}

function Config({ c }: { c: Connector }) {
  const cfg = c.config
  const transport = cfg
    ? tr(
        cfg.transport === 'stdio'
          ? 'connectors.transportStdio'
          : cfg.transport === 'sse'
            ? 'connectors.transportSse'
            : 'connectors.transportHttp',
      )
    : null
  return (
    <div className="shrink-0 overflow-hidden rounded-lg border border-line-card bg-surface text-list">
      <KV label={tr('connectors.configSource')}>
        {sourceLabel(c)}
        {cfg?.path && <small className="mt-0.5 block break-all text-label text-fg-faint">{cfg.path}</small>}
      </KV>
      {cfg ? (
        <>
          <KV label={tr('connectors.configTransport')}>
            <span className="inline-flex h-[18px] items-center rounded bg-subtle px-1.5 text-label text-fg-secondary">
              {transport}
            </span>
            {cfg.target && (
              <div className="mt-1 break-all rounded-md bg-subtle px-2 py-1.5 font-mono text-label text-fg-secondary">
                {cfg.target}
              </div>
            )}
          </KV>
          <KV label={tr('connectors.configSecrets')}>
            {cfg.secrets.length ? (
              <>
                <span className="flex flex-col gap-0.5 font-mono text-meta">
                  {cfg.secrets.map(s => (
                    <span key={s}>{s}=••••••••</span>
                  ))}
                </span>
                <small className="mt-0.5 block text-label text-fg-faint">{tr('connectors.secretsHidden')}</small>
              </>
            ) : (
              <span className="text-fg-faint">{tr('connectors.none')}</span>
            )}
          </KV>
          <KV label={tr('connectors.configScope')}>
            {cfg.project ? tr('connectors.scopeProject', { path: cfg.project }) : tr('connectors.scopeGlobal')}
          </KV>
        </>
      ) : (
        <KV label={tr('connectors.configTransport')}>
          <span className="text-meta text-fg-muted">{tr('connectors.noConfig')}</span>
        </KV>
      )}
      {c.version && <KV label={tr('connectors.configVersion')}>{c.version}</KV>}
    </div>
  )
}

function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 px-3 py-2.5 [&+&]:border-t [&+&]:border-line">
      <span className="text-meta text-fg-muted">{label}</span>
      <div className="min-w-0 break-words text-fg">{children}</div>
    </div>
  )
}
