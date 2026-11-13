// 概况 › 上下文（「状态」里的一格）：比例、离自动压缩还有多少；点开是用量、三段条（已用 / 空闲 / 自动压缩预留）、各类占用
// （标签 + 单色条 + 数字 + 占窗口：现有图表色在色盲校验下分不清，不做多色堆叠条），压缩和明细
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
import { agoText } from '@/features/session/live/agentActivity'
import { percentText, type QuotaLevel } from '@/features/session/quota/quotaModel'
import { useMinuteNow } from '@/features/session/quota/quotaStore'
import { contextLevel, contextRows, contextSplit, type ContextSplit } from './overviewModel'
import { useHasComposer, useSessionContext } from './overviewData'
import type { SectionProps } from './OverviewPanel'
import {
  Meter,
  NOTE,
  Pill,
  SECTION_LINKS,
  SectionLink,
  StatusTile,
  SUB_LABEL,
  type PillTone,
  type Tone,
} from './Section'

/** 空闲少于窗口的这一比例：快自动压缩了，说明变橙 */
const SOON = 0.05

export const LEVEL_TONE: Record<QuotaLevel, Tone | undefined> = { normal: undefined, warn: 'warn', full: 'bad' }

export function ContextSection({ sessionId, active }: SectionProps) {
  useI18n()
  const context = useSessionContext(sessionId, active)
  const percent = contextPercentage(context)
  const split = context && contextSplit(context)
  if (!context || percent === null || !split) return null
  const level = contextLevel(percent)
  const soon = split.buffer > 0 && split.free < split.window * SOON
  return (
    <StatusTile
      id="context"
      icon={Gauge}
      title={tr('session.ContextWindowButton.context2')}
      value={percentText(percent)}
      tone={LEVEL_TONE[level]}
      visual={<ContextBar split={split} level={level} thin />}
      subTone={soon ? 'warn' : undefined}
      sub={
        context.compacting
          ? tr('session.ContextWindowButton.compacting')
          : split.buffer > 0
            ? tr(soon ? 'overview.ctxCompactSoon' : 'overview.ctxToCompact', { n: contextNumber(split.free) })
            : `${contextNumber(split.used)} / ${contextNumber(split.window)}`
      }
    >
      <ContextBody key={sessionId} sessionId={sessionId} context={context} split={split} level={level} />
    </StatusTile>
  )
}

const FILL: Record<QuotaLevel, string> = { normal: 'bg-accent', warn: 'bg-warn', full: 'bg-danger' }

/** 三段条：已用（按比例变色）、空闲（灰）、自动压缩预留（斜纹，靠右） */
function ContextBar({ split, level, thin }: { split: ContextSplit; level: QuotaLevel; thin?: boolean }) {
  const used = (split.used / split.window) * 100
  return (
    <div
      role="progressbar"
      aria-label={tr('session.ContextWindowButton.contextUsage')}
      aria-valuenow={Math.round(used)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('relative overflow-hidden rounded-full bg-ov-track', thin ? 'mt-[3px] h-1' : 'h-2')}
    >
      <i
        className={cn('absolute inset-y-0 left-0 rounded-full', FILL[level])}
        style={{ width: `${Math.max(used, 2)}%` }}
      />
      {split.buffer > 0 && (
        <i
          title={tr('overview.ctxBuffer', { n: contextNumber(split.buffer) })}
          className="ov-hatch absolute inset-y-0 right-0"
          style={{ width: `${(split.buffer / split.window) * 100}%` }}
        />
      )}
    </div>
  )
}

/** 压缩要花一次模型调用，按钮先在原地确认；运行中、有排队时点不了。这里和「要处理」共用，各放各的位置 */
export function useCompactAction(sessionId: string, tone?: PillTone): { button: ReactNode; details: ReactNode } {
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
      <Pill
        tone={tone}
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
      </Pill>
    ),
    details: (
      <>
        {confirm && (
          <div className="mt-2 rounded-xl bg-ov-chip px-2.5 py-2 text-meta leading-[1.45] text-fg-secondary">
            <p>{tr('session.ContextWindowButton.compactingCallsModelAnd2')}</p>
            <div className="flex justify-end gap-1.5 pt-1.5">
              <Pill tone="ghost" onClick={() => setConfirm(false)}>
                {tr('account.AccountMenu.cancel')}
              </Pill>
              <Pill tone="primary" disabled={!canCompact} onClick={() => void compact()}>
                {tr('session.ContextWindowButton.startCompaction')}
              </Pill>
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
  split,
  level,
}: {
  sessionId: string
  context: ContextWindow
  split: ContextSplit
  level: QuotaLevel
}) {
  useI18n()
  const now = useMinuteNow()
  const hasComposer = useHasComposer(sessionId)
  const compact = useCompactAction(sessionId, level === 'full' ? 'primary' : 'default')
  const rows = contextRows(context)
  const largest = Math.max(...rows.map(r => r.tokens))
  const observed = context.diagnostic?.observedAt ?? context.observedAt
  return (
    <>
      <div className="mb-1.5 flex min-w-0 items-baseline gap-1.5">
        <b className="text-section font-medium tabular-nums">{contextNumber(split.used)}</b>
        <span className="truncate text-fg-muted">
          / {[contextNumber(split.window), context.model].filter(Boolean).join(' · ')}
        </span>
        {observed !== null && (
          <span className="ml-auto shrink-0 text-label text-fg-faint">{agoText(Math.max(0, now - observed))}</span>
        )}
      </div>
      <ContextBar split={split} level={level} />
      <div className="mt-1.5 mb-0.5 flex flex-wrap gap-x-3 gap-y-[3px] text-label text-fg-muted tabular-nums">
        <span>
          <i className={cn('mr-1 inline-block size-2 rounded-[3px] align-[-1px]', FILL[level])} />
          {tr('overview.ctxUsed', { n: contextNumber(split.used) })}
        </span>
        <span>
          <i className="mr-1 inline-block size-2 rounded-[3px] bg-ov-track align-[-1px]" />
          {tr('overview.ctxFree', { n: contextNumber(split.free) })}
        </span>
        {split.buffer > 0 && (
          <span>
            <i className="ov-hatch mr-1 inline-block size-2 rounded-[3px] align-[-1px]" />
            {tr('overview.ctxBuffer', { n: contextNumber(split.buffer) })}
          </span>
        )}
      </div>
      {context.compacting && <p className={NOTE}>{tr('session.ContextWindowButton.compacting')}</p>}
      {rows.length > 0 && (
        <>
          <div className={SUB_LABEL}>
            {tr('overview.ctxCategories')}
            <span className="ml-auto">{tr('overview.ctxShare')}</span>
          </div>
          {/* 一个网格：名称列按最长的那个定宽（英文名长，不再截断），条、数字、占比对齐 */}
          <div className="grid grid-cols-[minmax(0,max-content)_minmax(20px,1fr)_auto_auto] items-center gap-x-2 gap-y-1 text-fg-secondary">
            {rows.map(row => (
              <div key={row.name} className="contents">
                <span title={row.name} className="truncate">
                  {row.name}
                </span>
                <Meter percent={(row.tokens / largest) * 100} muted />
                <span className="text-right text-fg-muted tabular-nums">{contextNumber(row.tokens)}</span>
                <span className="min-w-[26px] text-right text-label text-fg-faint tabular-nums">
                  {percentText((row.tokens / split.window) * 100)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {split.deferred > 0 && <p className={NOTE}>{tr('overview.ctxDeferred', { n: contextNumber(split.deferred) })}</p>}
      {context.diagnostic && context.diagnosticStale && <p className={NOTE}>{tr('overview.contextStale')}</p>}
      <div className={SECTION_LINKS}>
        {compact.button}
        {context.diagnostic && hasComposer && (
          <SectionLink onClick={() => requestContextDetails(sessionId)}>{tr('overview.details')}</SectionLink>
        )}
      </div>
      {compact.details}
    </>
  )
}
