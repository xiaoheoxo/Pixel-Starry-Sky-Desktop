// 概况 › MCP：已连接、要处理、工具数、本会话调用；每个服务的状态、来源、工具和调用次数。配置和工具说明还在连接器页（「管理」）
import { useState } from 'react'
import { Plug, Plus, RefreshCw } from 'lucide-react'
import type { McpReport } from '@pixelsky/protocol'
import { Button, cn, Switch } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { DOT, sourceLabel, STATUS_KEY } from '../connectors/ConnectorsPanel'
import { displayName, initials, summarize, type Connector } from '../connectors/connectorsModel'
import type { ConnectorActions } from '../connectors/useConnectors'
import { ToolError } from '../ToolsUi'
import { openRightTab } from '../workspaceStore'
import { mcpActions, topTools } from './overviewModel'
import type { SectionProps } from './OverviewPanel'
import { Section, SECTION_ROW, SectionAction, Stat } from './Section'

export function McpSection({ active, mcp }: SectionProps) {
  useI18n()
  const { list, report, actions, error } = mcp
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  if (!active || !list.length) return null
  const sum = summarize(list)
  const toggle = (name: string): void =>
    setExpanded(current => {
      const next = new Set(current)
      if (!next.delete(name)) next.add(name)
      return next
    })
  return (
    <Section
      id="mcp"
      icon={Plug}
      title={tr('overview.mcp')}
      summary={
        <>
          {sum.connected ? tr('overview.mcpConnected', { count: sum.connected }) : tr('overview.mcpNotConnected')}
          {sum.attention > 0 && (
            <span className="text-warn-fg"> · {tr('overview.mcpAttention', { count: sum.attention })}</span>
          )}
        </>
      }
    >
      {report ? (
        <>
          {!report.live && <p className="pb-1 text-meta text-fg-muted">{tr('connectors.notLive')}</p>}
          <div className="mb-1.5 grid grid-cols-4 gap-0.5">
            <Stat value={sum.connected} label={tr('connectors.statConnected')} />
            <Stat
              value={<span className={sum.attention > 0 ? 'text-warn-fg' : undefined}>{sum.attention}</span>}
              label={tr('connectors.statAttention')}
            />
            <Stat value={sum.tools} label={tr('connectors.statTools')} />
            <Stat value={sum.calls} label={tr('connectors.statCalls')} />
          </div>
        </>
      ) : (
        <p className="pb-1 text-meta text-fg-muted">{tr('connectors.idleHint')}</p>
      )}
      {list.map(c => (
        <McpRow
          key={c.name}
          c={c}
          report={report}
          actions={actions}
          open={expanded.has(c.name)}
          onToggle={() => toggle(c.name)}
        />
      ))}
      {error && (
        <div className="mt-1.5">
          <ToolError error={error} />
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <SectionAction onClick={() => openRightTab('connectors')}>{tr('settings.AboutSection.manage')}</SectionAction>
        <SectionAction onClick={actions.settings}>
          <Plus size={13} strokeWidth={1.6} />
          {tr('connectors.add')}
        </SectionAction>
        <SectionAction disabled={actions.busy === 'refresh'} onClick={actions.refresh}>
          <RefreshCw size={13} strokeWidth={1.6} className={cn(actions.busy === 'refresh' && 'animate-spin')} />
          {tr('connectors.refresh')}
        </SectionAction>
      </div>
    </Section>
  )
}

function McpRow({
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
  const meta =
    c.status === 'connected'
      ? [
          tr('connectors.toolCount', { count: c.tools.length }),
          c.calls ? tr('connectors.used', { count: c.calls }) : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : tr(STATUS_KEY[c.status])
  return (
    <>
      <button type="button" aria-expanded={open} data-overview-mcp={c.name} onClick={onToggle} className={SECTION_ROW}>
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-selected text-label font-semibold">
          {initials(name)}
        </span>
        <span title={c.name} className={cn('min-w-0 flex-1 truncate', c.status === 'disabled' && 'text-fg-muted')}>
          {name}
        </span>
        <span title={meta} className="max-w-[60%] min-w-0 truncate text-meta text-fg-muted tabular-nums">
          {meta}
        </span>
        <span className={cn('size-[7px] shrink-0 rounded-full', DOT[c.status])} />
      </button>
      {open && <McpDetail c={c} report={report} actions={actions} />}
    </>
  )
}

function McpDetail({ c, report, actions }: { c: Connector; report: McpReport | null; actions: ConnectorActions }) {
  const can = mcpActions(c.status, report)
  const { tools, more } = topTools(c)
  // 远程机器读不到配置，就没有传输方式
  const source = [sourceLabel(c), c.config?.transport].filter(Boolean).join(' · ')
  return (
    <div className="mt-0.5 mb-1.5 ml-[27px] border-l border-line-subtle pl-[9px] text-meta">
      <p title={source} className="truncate text-fg-muted">
        {source}
      </p>
      {c.error && (
        <p title={c.error} className="line-clamp-3 py-0.5 break-words text-danger">
          {c.error}
        </p>
      )}
      {tools.map(t => (
        <div key={t.name} className="flex min-h-[22px] items-center gap-[7px] text-fg-secondary">
          <span title={t.description ?? t.name} className="min-w-0 flex-1 truncate font-mono">
            {t.name}
          </span>
          {!!c.toolCalls[t.name] && (
            <span className="shrink-0 text-fg-muted tabular-nums">
              {tr('connectors.toolCalls', { count: c.toolCalls[t.name]! })}
            </span>
          )}
        </div>
      ))}
      {more > 0 && <p className="py-0.5 text-fg-muted">{tr('overview.mcpMoreTools', { count: more })}</p>}
      <div className="mt-[3px] flex min-h-6 items-center gap-1.5">
        {can.login && (
          <Button
            variant="primary"
            className="h-6 px-2 text-meta"
            disabled={actions.busy === 'login:' + c.name}
            onClick={() => actions.login(c.name)}
          >
            {tr('connectors.login')}
          </Button>
        )}
        {can.reconnect && (
          <SectionAction disabled={actions.busy === 'reconnect:' + c.name} onClick={() => actions.reconnect(c.name)}>
            <RefreshCw
              size={13}
              strokeWidth={1.6}
              className={cn(actions.busy === 'reconnect:' + c.name && 'animate-spin')}
            />
            {tr('connectors.reconnect')}
          </SectionAction>
        )}
        <span className="flex-1" />
        {can.toggle && (
          <>
            <span className="text-fg-muted">{tr('connectors.enable')}</span>
            <Switch
              size="sm"
              label={`${tr('connectors.enable')} · ${c.name}`}
              checked={c.status !== 'disabled'}
              disabled={actions.busy === 'toggle:' + c.name}
              onChange={on => actions.toggle(c.name, on)}
            />
          </>
        )}
      </div>
    </div>
  )
}
