// 概况 › 已加载（Claude）：记忆文件、Skills、自定义子智能体和各自占用，都从上下文诊断来，没有诊断就不显示
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
import { Section, SectionAction } from './Section'

/** 每组先列占用最大的几个，其余点开 */
const FIRST_ROWS = 3

export function LoadedSection({ sessionId, active }: SectionProps) {
  useI18n()
  const diagnostic = useSessionContext(sessionId, active)?.diagnostic
  const hasComposer = useHasComposer(sessionId)
  if (!diagnostic) return null
  const counts = [
    { label: tr('overview.memory'), count: diagnostic.memory.length },
    { label: 'Skills', count: diagnostic.skills.length },
    { label: tr('session.progress.subagents'), count: diagnostic.agents.length },
  ].filter(c => c.count > 0)
  if (!counts.length) return null
  return (
    <Section
      id="loaded"
      icon={Layers}
      title={tr('overview.loaded')}
      summary={counts.map(c => `${c.label} ${c.count}`).join(' · ')}
    >
      <Group title={tr('session.contextData.memoryFiles')} rows={diagnostic.memory} file />
      <Group title="Skills" rows={diagnostic.skills} />
      <Group title={tr('session.progress.subagents')} rows={diagnostic.agents} />
      {hasComposer && (
        <div className="mt-1.5">
          <SectionAction onClick={() => requestContextDetails(sessionId)}>{tr('overview.details')}</SectionAction>
        </div>
      )}
    </Section>
  )
}

function Group({ title, rows, file }: { title: string; rows: ContextDetail[]; file?: boolean }) {
  useI18n()
  const [all, setAll] = useState(false)
  if (!rows.length) return null
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens)
  const more = all ? 0 : sorted.length - FIRST_ROWS
  return (
    <>
      <div className="pt-1 text-meta text-fg-muted">{title}</div>
      {(more > 0 ? sorted.slice(0, FIRST_ROWS) : sorted).map((row, i) => (
        <div key={row.name + i} className="flex min-h-[22px] items-center gap-[7px] text-fg-secondary">
          <span title={row.name} className="min-w-0 flex-1 truncate font-mono text-meta">
            {file ? splitFileName(row.name).name : row.name}
          </span>
          <span className="text-meta text-fg-muted tabular-nums">{contextNumber(row.tokens)}</span>
        </div>
      ))}
      {more > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="press h-6 px-0.5 text-meta text-accent-fg hover:underline"
        >
          {tr('artifacts.moreDelivered', { count: more })}
        </button>
      )}
    </>
  )
}
