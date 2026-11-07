// 概况 › 后台任务：项目里没停的开发服务，加上这个会话的后台命令和监视任务（任务行就是对话上方那一条，输出就地展开）
import { useEffect, useState } from 'react'
import { Globe, Square, SquareTerminal } from 'lucide-react'
import type { BackgroundTask } from '@pixelsky/protocol'
import { cn, IconButton, useToast } from '@/ui'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { openSessionPage } from '@/features/checks/SessionCheckBar'
import { portUrl } from '@/features/coding/bottom/portsModel'
import { useEngineState } from '@/features/engine'
import { machineOf } from '@/features/machines/store'
import { TaskStrip } from '@/features/session/live/SessionStrips'
import type { ServiceDefinition } from '../../../../../shared/types/project-tools'
import { statusKeys } from '../EnvironmentPanel'
import { openRightTab } from '../workspaceStore'
import type { SectionProps } from './OverviewPanel'
import { Section } from './Section'

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
  const stop = (id: string): void => {
    if (isDemo) setServices(list => list.filter(s => s.id !== id))
    else window.pixelsky?.projectTools.stopService(id).catch(e => toast(translateMessage((e as Error).message)))
  }
  const shown = services.filter(s => s.status !== 'stopped')
  if (!active || !(tasks.length + shown.length)) return null
  const running = tasks.length + shown.filter(s => s.status !== 'failed').length
  // 远程机器的端口没有转发到这台电脑，内置浏览器打不开
  const local = machineOf(sessionId) === 'local'
  return (
    <Section
      id="tasks"
      icon={SquareTerminal}
      title={tr('engine.labels.backgroundTask')}
      summary={tr('sidebar.tree.running', { count: running })}
    >
      {shown.map(s => {
        const url = !local ? null : s.healthUrl || (s.port ? portUrl(s.port) : null)
        return (
          <div
            key={s.id}
            data-overview-service={s.id}
            className="flex min-h-[26px] items-center gap-[7px] text-fg-secondary"
          >
            <span className={cn('size-[7px] shrink-0 rounded-full', DOT[s.status])} />
            <span title={s.command} className="min-w-0 flex-1 truncate font-mono text-meta">
              {s.name}
            </span>
            {s.status !== 'running' && (
              <span className="shrink-0 text-meta text-fg-muted">{tr(statusKeys[s.status])}</span>
            )}
            {s.port && <span className="shrink-0 font-mono text-meta text-fg-muted">:{s.port}</span>}
            {url && (
              <IconButton
                icon={Globe}
                label={tr('portTip.open')}
                size={24}
                iconSize={13}
                onClick={() => openSessionPage(sessionId, url)}
              />
            )}
            <IconButton
              icon={SquareTerminal}
              label={tr('session.live.SessionStrips.output')}
              size={24}
              iconSize={13}
              onClick={() => openRightTab('sandbox')}
            />
            {s.status !== 'failed' && (
              <IconButton
                icon={Square}
                label={tr('projectTools.stop')}
                size={24}
                iconSize={13}
                disabled={s.status === 'stopping'}
                onClick={() => stop(s.id)}
              />
            )}
          </div>
        )
      })}
      <TaskStrip
        bare
        sessionId={sessionId}
        tasks={tasks}
        onOpenPort={local ? port => openSessionPage(sessionId, portUrl(port)) : undefined}
      />
    </Section>
  )
}
