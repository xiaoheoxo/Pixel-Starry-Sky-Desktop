// 概况 › 上下文：占用比例、各类占用（标签 + 单色条 + 数字：现有图表色在色盲校验下分不清，不做多色堆叠条），压缩和明细
import { useState, type ReactNode } from 'react'
import { Gauge } from 'lucide-react'
import type { ContextWindow } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { isDemo } from '@/data'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { bridge, useEngineState } from '@/features/engine'
import { compactBlock, contextNumber, contextPercentage } from '@/features/session/contextData'
import { requestContextDetails } from '@/features/session/contextFocus'
import type { QuotaLevel } from '@/features/session/quota/quotaModel'
import { contextLevel, contextRows } from './overviewModel'
import { useHasComposer, useSessionContext } from './overviewData'
import type { SectionProps } from './OverviewPanel'
import { Meter, Section, SectionAction } from './Section'

const TEXT: Record<QuotaLevel, string> = { normal: 'text-fg', warn: 'text-warn-fg', full: 'text-danger' }

export function ContextSection({ sessionId, active }: SectionProps) {
  useI18n()
  const context = useSessionContext(sessionId, active)
  const percent = contextPercentage(context)
  if (!context || percent === null) return null
  const used = `${contextNumber(context.used)} / ${contextNumber(context.window)}`
  return (
    <Section
      id="context"
      icon={Gauge}
      title={tr('session.ContextWindowButton.context2')}
      summary={`${Number(percent.toFixed(1))}% · ${used}`}
      quietOpen
    >
      <ContextBody key={sessionId} sessionId={sessionId} context={context} percent={percent} used={used} />
    </Section>
  )
}

/** 压缩要花一次模型调用，按钮先开确认；运行中、有排队时点不了。这里和「要处理」共用，各放各的位置 */
export function useCompactAction(sessionId: string): { button: ReactNode; details: ReactNode } {
  const blocked = useEngineState(s => compactBlock(s.snapshots[sessionId]))
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const canCompact = !isDemo && !blocked && !busy
  const compact = async (): Promise<void> => {
    if (!canCompact) return
    setBusy(true)
    setError('')
    try {
      await bridge?.compact(sessionId)
      setConfirm(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return {
    button: (
      <SectionAction
        disabled={!canCompact}
        title={
          isDemo
            ? tr('session.ContextWindowButton.engineActionsAreUnavailable')
            : blocked === 'busy'
              ? tr('session.ContextWindowButton.waitForCurrentTask')
              : blocked === 'unsupported'
                ? tr('session.ContextWindowButton.thisEngineDoesNot')
                : tr('session.ContextWindowButton.compactingCallsModelAnd')
        }
        onClick={() => setConfirm(v => !v)}
      >
        {tr('session.ContextWindowButton.compactConversation')}
      </SectionAction>
    ),
    details: (
      <>
        {confirm && (
          <div className="mt-2 rounded-lg bg-subtle p-2.5 text-meta">
            <p>{tr('session.ContextWindowButton.compactingCallsModelAnd2')}</p>
            <div className="mt-2 flex justify-end gap-3">
              <button type="button" onClick={() => setConfirm(false)} className="text-fg-muted">
                {tr('account.AccountMenu.cancel')}
              </button>
              <button
                type="button"
                disabled={!canCompact}
                onClick={() => void compact()}
                className="text-accent-fg disabled:opacity-50"
              >
                {tr('session.ContextWindowButton.startCompaction')}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p role="status" className="mt-2 text-meta text-danger">
            {translateMessage(error)}
          </p>
        )}
      </>
    ),
  }
}

function ContextBody({
  sessionId,
  context,
  percent,
  used,
}: {
  sessionId: string
  context: ContextWindow
  percent: number
  used: string
}) {
  useI18n()
  const hasComposer = useHasComposer(sessionId)
  const compact = useCompactAction(sessionId)
  const level = contextLevel(percent)
  const rows = contextRows(context)
  const largest = Math.max(...rows.map(r => r.tokens))
  const note = [used, context.model].filter(Boolean).join(' · ')
  return (
    <>
      <div className="mb-1 flex items-baseline gap-[7px]">
        <b className={cn('text-section font-medium tabular-nums', TEXT[level])}>{Number(percent.toFixed(1))}%</b>
        <span title={note} className="min-w-0 truncate text-meta text-fg-muted tabular-nums">
          {context.compacting ? tr('session.ContextWindowButton.compacting') : note}
        </span>
      </div>
      <Meter percent={percent} level={level} label={tr('session.ContextWindowButton.contextUsage')} />
      <div className="mt-[7px]">
        {rows.map(row => (
          <div
            key={row.name}
            className="grid min-h-[21px] grid-cols-[6em_1fr_3.5em] items-center gap-2 text-meta text-fg-secondary"
          >
            <span title={row.name} className="truncate">
              {row.name}
            </span>
            <div className="h-[3px] overflow-hidden rounded-full bg-selected">
              <i
                className="block h-full rounded-full bg-fg-muted"
                style={{ width: `${Math.round((row.tokens / largest) * 100)}%` }}
              />
            </div>
            <span className="text-right text-fg-muted tabular-nums">{contextNumber(row.tokens)}</span>
          </div>
        ))}
      </div>
      {context.diagnostic && context.diagnosticStale && (
        <p className="mt-1 text-label text-fg-faint">{tr('overview.contextStale')}</p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {compact.button}
        {context.diagnostic && hasComposer && (
          <SectionAction onClick={() => requestContextDetails(sessionId)}>{tr('overview.details')}</SectionAction>
        )}
      </div>
      {compact.details}
    </>
  )
}
