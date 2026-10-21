import { translateMessage } from '../../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
// 对话流上方的后台任务条（docs/engines.md §15.3，参考 JuCode TaskStrip）；子智能体在进度卡片里（docs/ui/progress-card.md）
import { useState } from 'react'
import type { BackgroundTask, TaskOutput } from '@pixelsky/protocol'
import { Spinner, cn } from '@/ui'
import { AnsiText } from '@/ui/code/AnsiText'
import { bridge, taskKindLabel } from '@/features/engine'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { useOpenTrace } from './trace'

const LINK = 'shrink-0 rounded px-1.5 py-0.5 text-meta text-fg-muted hover:bg-hover hover:text-fg'

/** 后台命令、监视任务的输出能读回来 */
const hasOutput = (kind: string) => kind.startsWith('local_bash') || kind.startsWith('monitor')

/** 后台任务条：每个任务可以停止；后台命令能看输出；多智能体编排能打开追踪 */
export function TaskStrip({ sessionId, tasks }: { sessionId: string; tasks: BackgroundTask[] }) {
  useI18n()
  const openTrace = useOpenTrace()
  const [open, setOpen] = useState<string | null>(null)
  const [outputs, setOutputs] = useState<Record<string, TaskOutput | { error: string } | undefined>>({})
  const [stopping, setStopping] = useState<Record<string, true>>({})
  if (tasks.length === 0) return null

  const loadOutput = (taskId: string): void => {
    setOutputs(o => ({ ...o, [taskId]: undefined }))
    // 演示模式从演示数据取（docs/ui/demo-conversation.md）
    const request = isDemo
      ? Promise.resolve().then(() => demo().conversations.taskOutput(sessionId, taskId))
      : bridge?.taskOutput(sessionId, taskId)
    request
      ?.then(out => setOutputs(o => ({ ...o, [taskId]: out })))
      .catch((err: Error) => setOutputs(o => ({ ...o, [taskId]: { error: err.message } })))
  }
  const toggleOutput = (taskId: string): void => {
    const next = open === taskId ? null : taskId
    setOpen(next)
    if (next) loadOutput(next)
  }
  const stop = (taskId: string): void => {
    setStopping(s => ({ ...s, [taskId]: true }))
    bridge?.stopTask(sessionId, taskId).catch(() =>
      setStopping(s => {
        const rest = { ...s }
        delete rest[taskId]
        return rest
      }),
    )
  }

  return (
    <div
      data-task-strip
      className="flex max-h-[30vh] flex-col gap-1 overflow-y-auto rounded-xl border border-line bg-surface px-3 py-2 shadow-sm"
    >
      {tasks.map(t => {
        const out = outputs[t.id]
        return (
          <div key={t.id} className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 text-meta">
              <Spinner size={12} />
              <span className="shrink-0 text-fg-muted">{taskKindLabel(t.kind)}</span>
              <span className="min-w-0 truncate text-fg" title={t.description}>
                {t.description}
              </span>
              {t.message && (
                <span className="min-w-0 truncate text-fg-faint" title={t.message}>
                  {t.message}
                </span>
              )}
              <span className="flex-1" />
              {openTrace && t.kind.startsWith('local_workflow') && (
                <button type="button" className={LINK} onClick={() => openTrace()}>
                  {tr('session.live.ItemRows.viewActivity')}{' '}
                </button>
              )}
              {hasOutput(t.kind) && (
                <button type="button" className={LINK} onClick={() => toggleOutput(t.id)}>
                  {open === t.id
                    ? tr('session.live.SessionStrips.collapseOutput')
                    : tr('session.live.SessionStrips.output')}
                </button>
              )}
              <button
                type="button"
                className={cn(LINK, 'hover:text-danger')}
                disabled={!!stopping[t.id]}
                onClick={() => stop(t.id)}
              >
                {stopping[t.id] ? tr('session.CacheMissAlerts.stopping') : tr('session.Composer.stop')}
              </button>
            </div>
            {open === t.id && (
              <div className="mt-1 mb-1 ml-5 rounded-lg border border-line bg-subtle px-3 py-2 text-meta">
                {!out ? (
                  <span className="text-fg-faint">{tr('session.live.SessionStrips.loading')}</span>
                ) : 'error' in out ? (
                  <span className="text-fg-faint">{translateMessage(out.error)}</span>
                ) : (
                  <>
                    {out.truncated && (
                      <div className="mb-1 text-fg-faint">
                        {tr('session.live.SessionStrips.showingLastPortionOnly')}
                      </div>
                    )}
                    <pre className="max-h-48 overflow-auto font-mono leading-[1.6] whitespace-pre-wrap text-fg-secondary">
                      {out.output ? <AnsiText text={out.output} /> : tr('session.live.SessionStrips.noOutputYet')}
                    </pre>
                    <button type="button" className={cn(LINK, 'mt-1 -ml-1.5')} onClick={() => loadOutput(t.id)}>
                      {tr('account.AccountMenu.refresh')}{' '}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 保留模式：主智能体停了，还有后台子智能体在跑（docs/ui/subagent-stop.md §S4） */
export function KeptAgentsStrip({
  count,
  onView,
  onStopAll,
}: {
  count: number
  onView: () => void
  onStopAll: () => void
}) {
  useI18n()
  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl border border-active/40 bg-accent-soft px-3 py-1.5 text-meta text-fg">
      <Spinner size={12} />
      <span className="min-w-0 truncate">{tr('subagentStop.keptStrip', { n: count })}</span>
      <span className="flex-1" />
      <button type="button" className={LINK} onClick={onView}>
        {tr('subagentStop.view')}
      </button>
      <button type="button" className={cn(LINK, 'text-danger hover:text-danger')} onClick={onStopAll}>
        ■ {tr('subagentStop.stopAll')}
      </button>
    </div>
  )
}
