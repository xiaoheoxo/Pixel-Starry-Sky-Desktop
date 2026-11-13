// 概况 › MCP（「状态」里的一格）：每个服务一个状态圆点、已连接 / 要处理、工具数和本会话调用。点开：按状态筛选、三格数字、
// 每个服务一张小卡（来源、连接方式、工具数、调用次数；点开是地址、密钥名、出错原因、工具按调用排、登录 / 重连和启用开关）。
// 配置和工具说明全文还在连接器页（「管理」）
import { useState } from 'react'
import { ChevronRight, ExternalLink, Plug, Plus, RefreshCw } from 'lucide-react'
import type { McpReport } from '@pixelsky/protocol'
import { CopyButton, cn, IconButton, Switch } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { agoText } from '@/features/session/live/agentActivity'
import { useMinuteNow } from '@/features/session/quota/quotaStore'
import { DOT, sourceLabel, STATUS_KEY } from '../connectors/ConnectorsPanel'
import { displayName, initials, summarize, type Connector } from '../connectors/connectorsModel'
import type { ConnectorActions } from '../connectors/useConnectors'
import { ToolError } from '../ToolsUi'
import { openRightTab } from '../workspaceStore'
import { mcpActions, topTools } from './overviewModel'
import type { SectionProps } from './OverviewPanel'
import { FilterChips, Meter, Pill, SectionLink, StatusTile, SUB_LABEL, Tag, Unit } from './Section'

type Group = 'attn' | 'ok' | 'off'
const groupOf = (c: Connector): Group =>
  c.status === 'connected' ? 'ok' : c.status === 'auth' || c.status === 'failed' ? 'attn' : 'off'
/** 出事的在前，其余按调用次数 */
const RANK: Record<Connector['status'], number> = { failed: 0, auth: 1, connected: 2, pending: 3, idle: 4, disabled: 5 }

export function McpSection({ active, mcp }: SectionProps) {
  useI18n()
  const { list, report, actions, error } = mcp
  if (!active || !list.length) return null
  const sum = summarize(list)
  return (
    <StatusTile
      id="mcp"
      icon={Plug}
      title={tr('overview.mcp')}
      tone={sum.attention > 0 ? 'warn' : undefined}
      value={
        !report ? (
          <>
            {list.length}
            <Unit>{tr('overview.mcpUnitServers')}</Unit>
          </>
        ) : sum.attention > 0 ? (
          <>
            {sum.attention}
            <Unit>{tr('overview.mcpUnitAttention')}</Unit>
          </>
        ) : (
          <>
            {sum.connected}
            <Unit>{tr('overview.mcpUnitConnected', { total: list.length })}</Unit>
          </>
        )
      }
      folded={`${tr('overview.mcp')} ${
        sum.attention > 0
          ? tr('overview.mcpAttention', { count: sum.attention })
          : tr('overview.mcpConnected', { count: sum.connected })
      }`}
      visual={
        <span className="mt-1 flex flex-wrap gap-[3px]">
          {list.map(c => (
            <i
              key={c.name}
              title={`${displayName(c)}：${tr(STATUS_KEY[c.status])}`}
              className={cn('size-[7px] rounded-full', DOT[c.status])}
            />
          ))}
        </span>
      }
      sub={
        report ? tr('overview.mcpToolsCalls', { tools: sum.tools, calls: sum.calls }) : tr('overview.mcpNotConnected')
      }
    >
      <McpDetail list={list} report={report} actions={actions} />
      {error && (
        <div className="mt-1.5">
          <ToolError error={error} />
        </div>
      )}
    </StatusTile>
  )
}

function McpDetail({
  list,
  report,
  actions,
}: {
  list: readonly Connector[]
  report: McpReport | null
  actions: ConnectorActions
}) {
  useI18n()
  const now = useMinuteNow()
  const [filter, setFilter] = useState<'all' | Group>('all')
  const [open, setOpen] = useState<string | null>(null)
  const count = (g: Group): number => list.filter(c => groupOf(c) === g).length
  const chips = [
    { id: 'all' as const, label: tr('overview.filterAll'), count: list.length },
    { id: 'attn' as const, label: tr('overview.attention'), count: count('attn'), dot: 'bg-warn' },
    { id: 'ok' as const, label: tr('connectors.statusConnected'), count: count('ok'), dot: 'bg-success' },
    { id: 'off' as const, label: tr('overview.mcpFilterOff'), count: count('off') },
  ].filter(c => c.id === 'all' || c.count > 0)
  const shown = chips.some(c => c.id === filter) ? filter : 'all'
  const sorted = list
    .filter(c => shown === 'all' || groupOf(c) === shown)
    .sort((a, b) => RANK[a.status] - RANK[b.status] || b.calls - a.calls)
  const sum = summarize(list)
  const top = list
    .flatMap(c => Object.entries(c.toolCalls).map(([tool, n]) => ({ server: displayName(c), tool, n })))
    .sort((a, b) => b.n - a.n)[0]
  return (
    <>
      <FilterChips<'all' | Group> value={shown} onChange={setFilter} options={chips} className="-mt-0.5 mb-1" />
      {!report ? (
        <p className="mb-1.5 rounded-lg bg-ov-chip px-2.5 py-[5px] text-label text-fg-muted">
          {tr('connectors.idleHint')}
        </p>
      ) : (
        <>
          {!report.live && (
            <p className="mb-1.5 rounded-lg bg-ov-chip px-2.5 py-[5px] text-label text-fg-muted">
              {tr('connectors.notLive')}
            </p>
          )}
          <div className="mb-1.5 grid grid-cols-[auto_auto_minmax(0,1fr)] gap-1.5">
            <Stat value={String(sum.tools)} label={tr('overview.mcpStatTools')} />
            <Stat value={String(sum.calls)} label={tr('overview.mcpStatCalls')} />
            <Stat
              mono
              value={top ? top.tool : '—'}
              label={top ? tr('overview.mcpStatTop', { count: top.n }) : tr('overview.mcpStatTopNone')}
              title={top ? `${top.server} · ${top.tool}` : undefined}
            />
          </div>
        </>
      )}
      {sorted.map(c => (
        <ServerCard
          key={c.name}
          c={c}
          report={report}
          actions={actions}
          open={open === c.name}
          onToggle={() => setOpen(open === c.name ? null : c.name)}
        />
      ))}
      <div className="flex flex-wrap items-center gap-1.5 pt-2">
        <SectionLink onClick={() => openRightTab('connectors')}>
          <ExternalLink size={13} strokeWidth={1.6} />
          {tr('settings.AboutSection.manage')}
        </SectionLink>
        <SectionLink onClick={actions.settings}>
          <Plus size={13} strokeWidth={1.6} />
          {tr('connectors.add')}
        </SectionLink>
        <span className="ml-auto inline-flex items-center gap-0.5 text-label text-fg-faint">
          {report && agoText(Math.max(0, now - report.at))}
          <IconButton
            icon={RefreshCw}
            label={tr('connectors.refresh')}
            size={22}
            iconSize={13}
            disabled={actions.busy === 'refresh'}
            onClick={actions.refresh}
          />
        </span>
      </div>
    </>
  )
}

function Stat({ value, label, mono, title }: { value: string; label: string; mono?: boolean; title?: string }) {
  return (
    <div title={title} className="min-w-0 rounded-lg bg-ov-chip px-[9px] py-[5px]">
      <b
        className={cn(
          'block truncate font-medium tabular-nums',
          mono ? 'font-mono text-meta leading-[17.5px]' : 'text-prose leading-[1.25]',
        )}
      >
        {value}
      </b>
      <span className="block truncate text-label text-fg-muted">{label}</span>
    </div>
  )
}

function ServerCard({
  c,
  report,
  actions,
  open,
  onToggle,
}: {
  c: Connector
  report: McpReport | null
  actions: ConnectorActions
  open: boolean
  onToggle(): void
}) {
  const name = displayName(c)
  const bad = c.status === 'failed',
    warn = c.status === 'auth',
    off = c.status === 'disabled' || c.status === 'idle'
  const right = bad ? (
    <Tag tone="bad">{tr(STATUS_KEY.failed)}</Tag>
  ) : warn ? (
    <Tag tone="warn">{tr(STATUS_KEY.auth)}</Tag>
  ) : c.status === 'disabled' || c.status === 'pending' ? (
    <Tag>{tr(STATUS_KEY[c.status])}</Tag>
  ) : c.status === 'connected' ? (
    <span className={cn('shrink-0 tabular-nums', c.calls ? 'text-fg-muted' : 'text-fg-faint')}>
      {c.calls ? tr('connectors.used', { count: c.calls }) : tr('overview.mcpUnused')}
    </span>
  ) : null
  return (
    <div
      data-overview-mcp={c.name}
      className={cn(
        '-mx-1 rounded-xl px-1.5 pt-[5px] pb-1.5 [&+&]:mt-0.5',
        open ? 'bg-ov-chip' : bad ? 'bg-danger/15' : warn ? 'bg-warn/18' : 'hover:bg-hover',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="press flex min-h-6 w-full items-center gap-2 text-left"
      >
        <span className="relative grid size-[22px] shrink-0 place-items-center rounded-lg bg-fg/10 text-[10px] font-semibold text-fg-secondary">
          {initials(name)}
          <i className={cn('absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-ov-tile', DOT[c.status])} />
        </span>
        <span title={c.name} className={cn('min-w-0 flex-1 truncate', off ? 'text-fg-muted' : 'font-medium text-fg')}>
          {name}
          {c.version && (
            <small className="ml-1 text-label font-normal text-fg-faint">
              {/^\d/.test(c.version) ? `v${c.version}` : c.version}
            </small>
          )}
        </span>
        {right}
        <ChevronRight
          size={12}
          strokeWidth={1.6}
          className={cn(
            'shrink-0 text-fg-faint transition-transform motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
      </button>
      <div className="flex flex-wrap items-center gap-1 pt-[3px] pl-[30px]">
        <Tag className="h-[18px] px-[7px] text-fg-muted">{sourceLabel(c)}</Tag>
        {c.config?.transport && <Tag className="h-[18px] px-[7px] text-fg-muted">{c.config.transport}</Tag>}
        {c.status === 'connected' && (
          <Tag className="h-[18px] px-[7px] text-fg-muted">{tr('connectors.toolCount', { count: c.tools.length })}</Tag>
        )}
      </div>
      {open && <ServerBody c={c} report={report} actions={actions} />}
    </div>
  )
}

function ServerBody({ c, report, actions }: { c: Connector; report: McpReport | null; actions: ConnectorActions }) {
  const can = mcpActions(c.status, report)
  const [all, setAll] = useState(false)
  const { tools, more } = topTools(c, all ? Infinity : 3)
  const most = Math.max(1, ...tools.map(t => c.toolCalls[t.name] ?? 0))
  return (
    <div className="pt-1.5 pl-[30px]">
      {/* 远程机器读不到配置，就没有地址 */}
      {c.config && (
        <div className="flex min-h-[22px] items-center gap-1.5 text-label text-fg-muted">
          <span title={c.config.target} className="min-w-0 flex-1 truncate font-mono">
            {c.config.target}
          </span>
          <CopyButton text={c.config.target} iconOnly />
        </div>
      )}
      {!!c.config?.secrets.length && (
        <div className="flex min-h-[22px] flex-wrap items-center gap-1 text-label text-fg-muted">
          {c.config.secrets.map(k => (
            <Tag key={k} className="font-mono">
              {k}
            </Tag>
          ))}
          <span className="text-fg-faint">{tr('connectors.secretsHidden')}</span>
        </div>
      )}
      {c.error && (
        <p
          className={cn(
            'my-1 rounded-lg px-2.5 py-1.5 leading-[1.45] break-words',
            c.status === 'auth' ? 'bg-warn/12 text-warn-fg' : 'bg-danger/10 text-danger',
          )}
        >
          {c.error}
        </p>
      )}
      {tools.length > 0 && (
        <>
          <div className={SUB_LABEL}>
            {tr('overview.mcpTools')}
            <span className="ml-auto">{tr('overview.mcpToolCalls')}</span>
          </div>
          {tools.map(t => {
            const n = c.toolCalls[t.name] ?? 0
            return (
              <div key={t.name} className="py-[3px]">
                <div className="flex items-center gap-1.5 text-fg-secondary">
                  <span className="min-w-0 truncate font-mono text-[11.5px]">{t.name}</span>
                  {t.readOnly && (
                    <Tag title={tr('connectors.readOnlyHint')} className="h-4 px-1.5">
                      {tr('overview.mcpReadOnly')}
                    </Tag>
                  )}
                  <span
                    className={cn('ml-auto shrink-0 text-label tabular-nums', n ? 'text-fg-muted' : 'text-fg-faint')}
                  >
                    {n ? `×${n}` : '—'}
                  </span>
                </div>
                {t.description && (
                  <div title={t.description} className="truncate text-label text-fg-faint">
                    {t.description}
                  </div>
                )}
                {n > 0 && <Meter percent={(n / most) * 100} className="mt-[3px] h-[3px] opacity-75" />}
              </div>
            )
          })}
          {more > 0 && (
            <SectionLink onClick={() => setAll(true)}>{tr('overview.mcpMoreTools', { count: more })}</SectionLink>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
        {can.login && (
          <Pill tone="primary" disabled={actions.busy === 'login:' + c.name} onClick={() => actions.login(c.name)}>
            {tr('connectors.login')}
          </Pill>
        )}
        {can.reconnect && (
          <Pill
            tone={c.status === 'failed' ? 'primary' : 'default'}
            disabled={actions.busy === 'reconnect:' + c.name}
            onClick={() => actions.reconnect(c.name)}
          >
            <RefreshCw
              size={13}
              strokeWidth={1.6}
              className={cn(actions.busy === 'reconnect:' + c.name && 'animate-spin')}
            />
            {tr('connectors.reconnect')}
          </Pill>
        )}
        <span className="flex-1" />
        {can.toggle && (
          <span className="inline-flex items-center gap-1.5 text-label text-fg-muted">
            {tr('connectors.enable')}
            <Switch
              size="sm"
              label={`${tr('connectors.enable')} · ${c.name}`}
              checked={c.status !== 'disabled'}
              disabled={actions.busy === 'toggle:' + c.name}
              onChange={on => actions.toggle(c.name, on)}
            />
          </span>
        )}
      </div>
    </div>
  )
}
