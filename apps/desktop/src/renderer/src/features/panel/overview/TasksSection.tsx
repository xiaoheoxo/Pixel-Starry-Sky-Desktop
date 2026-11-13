// 概况 › 后台任务：项目里没停的开发服务（一块一块：状态点、名字、命令、端口胶囊、输出最后一句；没起来的整块淡红，写退出码和错误，
// 「重新启动」是主按钮），加上这个会话的后台命令和监视任务（任务行就是对话上方那一条，输出就地展开）
import { useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, Square, SquareTerminal } from 'lucide-react'
import type { BackgroundTask } from '@pixelsky/protocol'
import { cn, IconButton, useToast } from '@/ui'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { stripAnsi } from '@/ui/code/ansi'
import { openSessionPage } from '@/features/checks/SessionCheckBar'
import { portUrl } from '@/features/coding/bottom/portsModel'
import { useEngineState } from '@/features/engine'
import { machineOf } from '@/features/machines/store'
import { TaskStrip } from '@/features/session/live/SessionStrips'
import type { ServiceDefinition } from '../../../../../shared/types/project-tools'
import { statusKeys } from '../EnvironmentPanel'
import { openRightTab } from '../workspaceStore'
import type { SectionProps } from './OverviewPanel'
import { Pill, Section, SUB_LABEL, Tag } from './Section'

const NO_TASKS: BackgroundTask[] = []

const DOT: Record<ServiceDefinition['status'], string> = {
  stopped: 'bg-fg-faint',
  starting: 'bg-status-working',
  running: 'bg-success',
  stopping: 'bg-status-working',
  failed: 'bg-danger',
}

export function TasksSection({ sessionId, active }: SectionProps) {
  useI18n()
  const toast = useToast()
  const tasks = useEngineState(s => (active ? s.snapshots[sessionId]?.tasks : null)) ?? NO_TASKS
  const [services, setServices] = useState<ServiceDefinition[]>([])
  useEffect(() => {
    if (!active) return
    if (isDemo) return setServices(demo().projectTools.environment.services)
    const api = window.pixelsky?.projectTools
    if (!api) return
    let gone = false
    const load = (): void =>
      void api
        .services({ sessionId })
        .then(next => !gone && setServices(next))
        .catch(() => undefined)
    load()
    // 只是多了几行输出时不重读（和 git/summary.ts 一样）
    const off = api.onChange(kind => kind === 'state' && load())
    return () => {
      gone = true
      off()
    }
  }, [sessionId, active])
  const run = (fn: () => Promise<unknown> | undefined): void =>
    void fn()?.catch(e => toast(translateMessage((e as Error).message)))
  const stop = (id: string): void => {
    if (isDemo) setServices(list => list.filter(s => s.id !== id))
    else run(() => window.pixelsky?.projectTools.stopService(id))
  }
  const restart = (id: string): void => {
    if (!isDemo) run(() => window.pixelsky?.projectTools.restartService(id))
  }
  const shown = services.filter(s => s.status !== 'stopped')
  if (!active || !(tasks.length + shown.length)) return null
  const running = tasks.length + shown.filter(s => s.status !== 'failed').length
  // 远程机器的端口没有转发到这台电脑，内置浏览器打不开
  const local = machineOf(sessionId) === 'local'
  const failed = shown.filter(s => s.status === 'failed')
  return (
    <Section
      id="tasks"
      icon={SquareTerminal}
      title={tr('engine.labels.backgroundTask')}
      count={running}
      tone={failed.length ? 'bad' : undefined}
      summary={
        failed.length
          ? tr('overview.serviceFailed', { name: failed[0]!.name })
          : tr('sidebar.tree.running', { count: running })
      }
    >
      {shown.map(s => (
        <ServiceCard
          key={s.id}
          s={s}
          url={!local ? null : s.healthUrl || (s.port ? portUrl(s.port) : null)}
          onOpen={url => openSessionPage(sessionId, url)}
          onStop={() => stop(s.id)}
          onRestart={() => restart(s.id)}
        />
      ))}
      {shown.length > 0 && tasks.length > 0 && <div className={SUB_LABEL}>{tr('overview.thisSessionTasks')}</div>}
      <TaskStrip
        bare
        sessionId={sessionId}
        tasks={tasks}
        onOpenPort={local ? port => openSessionPage(sessionId, portUrl(port)) : undefined}
      />
    </Section>
  )
}

/** 输出的最后一句（去掉颜色码） */
const lastLine = (output: string): string =>
  stripAnsi(output)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .at(-1) ?? ''

function ServiceCard({
  s,
  url,
  onOpen,
  onStop,
  onRestart,
}: {
  s: ServiceDefinition
  /** 远程机器的端口没有转发到这台电脑，内置浏览器打不开：null */
  url: string | null
  onOpen(url: string): void
  onStop(): void
  onRestart(): void
}) {
  const failed = s.status === 'failed'
  const line = lastLine(s.output)
  return (
    <div
      data-overview-service={s.id}
      className={cn(
        'group/svc -mx-1 rounded-xl px-1.5 pt-1.5 pb-[7px] [&+&]:mt-0.5',
        failed ? 'bg-danger/15' : 'hover:bg-hover focus-within:bg-hover',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          title={tr(statusKeys[s.status])}
          className={cn(
            'mx-1 size-[7px] shrink-0 rounded-full',
            DOT[s.status],
            s.status === 'running' && 'ring-3 ring-success/25',
          )}
        />
        <b className="shrink-0 font-medium text-fg">{s.name}</b>
        <span title={s.command} className="min-w-0 flex-1 truncate font-mono text-label text-fg-faint">
          {s.command}
        </span>
        {failed ? (
          s.exitCode !== null && <Tag tone="bad">{tr('projectTools.exitCode', { p0: s.exitCode })}</Tag>
        ) : (
          <>
            <span className="flex shrink-0 items-center opacity-0 group-hover/svc:opacity-100 group-focus-within/svc:opacity-100">
              <IconButton
                icon={SquareTerminal}
                label={tr('session.live.SessionStrips.output')}
                size={22}
                iconSize={13}
                onClick={() => openRightTab('sandbox')}
              />
              <IconButton
                icon={RefreshCw}
                label={tr('projectTools.restart')}
                size={22}
                iconSize={13}
                onClick={onRestart}
              />
              <IconButton
                icon={Square}
                label={tr('projectTools.stop')}
                size={22}
                iconSize={13}
                disabled={s.status === 'stopping'}
                onClick={onStop}
              />
            </span>
            {s.status !== 'running' && (
              <span className="shrink-0 text-meta text-fg-muted">{tr(statusKeys[s.status])}</span>
            )}
            {s.port &&
              (url ? (
                <button
                  type="button"
                  title={tr('portTip.open')}
                  onClick={() => onOpen(url)}
                  className="press inline-flex h-5 shrink-0 items-center gap-[3px] rounded-full bg-accent-soft px-2 font-mono text-label font-medium text-accent-fg hover:bg-accent/22"
                >
                  :{s.port}
                  <ExternalLink size={11} strokeWidth={1.8} />
                </button>
              ) : (
                <span className="shrink-0 font-mono text-label text-fg-muted">:{s.port}</span>
              ))}
          </>
        )}
      </div>
      {failed ? (
        <>
          {s.error && (
            <p className="mt-1 ml-[19px] rounded-lg bg-danger/10 px-2.5 py-1.5 text-meta leading-[1.45] break-words text-danger">
              {s.error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 pt-1 pl-[19px]">
            <Pill tone="primary" onClick={onRestart}>
              <RefreshCw size={13} strokeWidth={1.6} />
              {tr('overview.serviceRestart')}
            </Pill>
            <Pill tone="ghost" onClick={() => openRightTab('sandbox')}>
              <SquareTerminal size={13} strokeWidth={1.6} />
              {tr('session.live.SessionStrips.output')}
            </Pill>
          </div>
        </>
      ) : (
        line && (
          <p title={line} className="mt-1 ml-[19px] truncate font-mono text-label text-fg-muted">
            {line}
          </p>
        )
      )}
    </div>
  )
}
