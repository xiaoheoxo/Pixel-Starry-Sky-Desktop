// 概况 › 已加载（Claude，「状态」里的一格）：记忆文件、Skills、自定义子智能体的个数和合计占用；点开按组列，每组带个数和合计，
// 每项一条占用条，MCP 工具按服务合计。都从上下文诊断来，没有诊断就不显示
import { useState } from 'react'
import { Layers } from 'lucide-react'
import type { ContextDetail } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { contextNumber } from '@/features/session/contextData'
import { requestContextDetails } from '@/features/session/contextFocus'
import { splitFileName } from '@/features/session/memoryPath'
import { useHasComposer, useSessionContext } from './overviewData'
import type { SectionProps } from './OverviewPanel'
import { Meter, SECTION_LINKS, SectionLink, StatusTile, Unit } from './Section'

/** 每组先列占用最大的几个，其余点开 */
const FIRST_ROWS = 3

interface Row {
  name: string
  /** 名字后面的淡字：记忆文件的目录、服务的工具数 */
  note?: string
  tokens: number
}

const total = (rows: readonly { tokens: number }[]): number => rows.reduce((n, r) => n + r.tokens, 0)

/** MCP 工具按服务合计 */
function byServer(tools: readonly ContextDetail[]): Row[] {
  const servers = new Map<string, { count: number; tokens: number }>()
  for (const t of tools) {
    const s = servers.get(t.source ?? '') ?? { count: 0, tokens: 0 }
    servers.set(t.source ?? '', { count: s.count + 1, tokens: s.tokens + t.tokens })
  }
  return [...servers].map(([name, s]) => ({
    name: name || tr('overview.mcpToolsGroup'),
    note: tr('connectors.toolCount', { count: s.count }),
    tokens: s.tokens,
  }))
}

export function LoadedSection({ sessionId, active }: SectionProps) {
  useI18n()
  const diagnostic = useSessionContext(sessionId, active)?.diagnostic
  const hasComposer = useHasComposer(sessionId)
  if (!diagnostic) return null
  const memory: Row[] = diagnostic.memory.map(m => {
    const { dir, name } = splitFileName(m.name)
    return { name, note: dir.replace(/[\\/]$/, ''), tokens: m.tokens }
  })
  const items = [...memory, ...diagnostic.skills, ...diagnostic.agents]
  if (!items.length) return null
  const largest = [...items].sort((a, b) => b.tokens - a.tokens)[0]!
  return (
    <StatusTile
      id="loaded"
      icon={Layers}
      title={tr('overview.loaded')}
      value={
        <>
          {items.length}
          <Unit>{tr('overview.loadedUnit', { tokens: contextNumber(total(items)) })}</Unit>
        </>
      }
      folded={`${tr('overview.loaded')} ${items.length}`}
      sub={tr('overview.loadedLargest', { name: largest.name, tokens: contextNumber(largest.tokens) })}
    >
      <Group title={tr('session.contextData.memoryFiles')} rows={memory} />
      <Group title="Skills" rows={diagnostic.skills} mono />
      <Group title={tr('session.progress.subagents')} rows={diagnostic.agents} mono />
      <Group title={tr('overview.mcpToolsGroup')} rows={byServer(diagnostic.tools)} mono />
      {hasComposer && (
        <div className={SECTION_LINKS}>
          <SectionLink onClick={() => requestContextDetails(sessionId)}>{tr('overview.details')}</SectionLink>
        </div>
      )}
    </StatusTile>
  )
}

function Group({ title, rows, mono }: { title: string; rows: readonly Row[]; mono?: boolean }) {
  useI18n()
  const [all, setAll] = useState(false)
  if (!rows.length) return null
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens)
  const most = Math.max(1, sorted[0]!.tokens)
  const more = all ? 0 : sorted.length - FIRST_ROWS
  return (
    <div className="[&+&]:mt-2">
      <div className="flex min-h-[22px] items-center gap-1.5 font-medium text-fg">
        {title}
        <span className="text-label font-normal text-fg-muted">{rows.length}</span>
        <span className="ml-auto text-label font-normal text-fg-muted tabular-nums">{contextNumber(total(rows))}</span>
      </div>
      {(more > 0 ? sorted.slice(0, FIRST_ROWS) : sorted).map((row, i) => (
        <div
          key={row.name + i}
          title={row.note ? `${row.name} · ${row.note}` : row.name}
          className="-mx-1.5 grid min-h-6 grid-cols-[minmax(0,1fr)_48px_38px] items-center gap-2 rounded-full px-1.5 text-fg-secondary hover:bg-hover"
        >
          <span className="min-w-0 truncate">
            <span className={mono ? 'font-mono' : undefined}>{row.name}</span>
            {row.note && <small className="ml-[5px] text-label text-fg-faint">{row.note}</small>}
          </span>
          <Meter percent={(row.tokens / most) * 100} muted />
          <span className="text-right text-label text-fg-muted tabular-nums">{contextNumber(row.tokens)}</span>
        </div>
      ))}
      {more > 0 && (
        <SectionLink onClick={() => setAll(true)}>{tr('artifacts.moreDelivered', { count: more })}</SectionLink>
      )}
    </div>
  )
}
