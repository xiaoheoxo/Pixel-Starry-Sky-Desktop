// 设置 › 项目「原来的 AI 会话」（docs/ui/resume-scan-mockup.html）：手动扫一遍全部本机项目里 Claude Code / Codex 留下的会话，
// 点「接着聊」打开那个项目、那个引擎的选择框。远程机器上只说明原因、给「切换到本机」。
import { useRef, useState } from 'react'
import { History, Monitor, RotateCw } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Button, IconButton, Popover, PopoverItem, Spinner, cn, useToast } from '@/ui'
import { isDemo, projects as demoProjects } from '@/data'
import { useEngineState } from '@/features/engine'
import { useSidebarPrefs } from '@/features/appearance/sidebar'
import { arrangeProjects } from '@/features/sidebar/projectGroups'
import { relativeTime } from '@/features/engine/labels'
import { machineOf, selectMachine, useMachines } from '@/features/machines/store'
import { openResumeFor, type HintEngine } from '@/features/resume/hint'
import { RESUME_ENGINE_NAMES } from '@/features/resume/store'
import {
  rescanProject,
  rowEngines,
  rowLatest,
  scanAllProjects,
  scanView,
  stopResumeScan,
  useResumeScan,
  type ScanRow,
} from '@/features/resume/scanAll'

const ENGINES: readonly HintEngine[] = ['claude', 'codex']

/** 一个引擎那一格：在扫转圈，读不到写原因，有会话写数量（带正开着的） */
function EngineCell({ row, engine }: { row: ScanRow; engine: HintEngine }) {
  if (row.state === 'scanning') return <Spinner />
  if (row.state === 'waiting') return <span className="text-fg-faint">—</span>
  const scan = row.result?.[engine]
  if (!scan) return <span className="text-fg-faint">—</span>
  if (scan.error)
    return (
      <span className="text-fg-faint" title={scan.error}>
        {tr('resume.scan.unreadable')}
      </span>
    )
  if (!scan.count) return <span className="text-fg-faint">—</span>
  return (
    <span className="flex items-center gap-1.5 tabular-nums">
      {scan.count}
      {scan.live > 0 && (
        <span className="rounded-full border border-warn/40 px-1.5 text-[10.5px] leading-4 text-warn-fg">
          {tr('resume.scan.live', { n: scan.live })}
        </span>
      )}
    </span>
  )
}

/** 「接着聊」：只有一个引擎有会话直接打开；两个都有弹菜单选 */
function ContinueButton({ row, onOpened }: { row: ScanRow; onOpened: () => void }) {
  const engines = rowEngines(row)
  const [menu, setMenu] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  if (!engines.length) return null
  const open = (engine: HintEngine): void => {
    setMenu(false)
    openResumeFor(row.projectId, engine, onOpened)
  }
  return (
    <span ref={anchor} className="inline-flex">
      <Button
        variant="primary"
        className="h-7 px-2.5 text-meta"
        aria-haspopup={engines.length > 1 ? 'menu' : undefined}
        aria-expanded={engines.length > 1 ? menu : undefined}
        onClick={() => (engines.length > 1 ? setMenu(v => !v) : open(engines[0]))}
      >
        {tr('resume.scan.continue')}
        {engines.length > 1 ? ' ▾' : ''}
      </Button>
      {engines.length > 1 && (
        <Popover open={menu} onClose={() => setMenu(false)} anchor={anchor} align="end" role="menu">
          {engines.map(engine => (
            <PopoverItem key={engine} role="menuitem" onClick={() => open(engine)}>
              {tr('resume.scan.continueEngine', {
                engine: RESUME_ENGINE_NAMES[engine],
                n: row.result?.[engine]?.count ?? 0,
              })}
            </PopoverItem>
          ))}
        </Popover>
      )}
    </span>
  )
}

export function ResumeScanCard({ onOpened }: { onOpened: () => void }) {
  useI18n()
  const machines = useMachines()
  const realProjects = useEngineState(s => s.projects)
  // 演示模式：侧栏用的是演示数据里的项目（没有路径）
  const unsorted = isDemo ? demoProjects.map(p => ({ id: p.id, name: p.name, path: p.path ?? '' })) : realProjects
  // 和侧栏同一个顺序：分区在前、按拖出来的顺序
  const prefs = useSidebarPrefs()
  const projects = arrangeProjects(unsorted, prefs.groups ?? [], prefs.order ?? []).flatMap(e =>
    e.kind === 'group' ? e.projects : [e.project],
  )
  const scan = useResumeScan()
  const [onlyWith, setOnlyWith] = useState(true)
  const toast = useToast()

  if (machines.currentId !== 'local') {
    const machine = machines.machines.find(m => m.id === machines.currentId)
    return (
      <div data-resume-scan="remote" className="mb-6 rounded-lg border border-line p-3.5">
        <div className="text-ui font-medium text-fg">{tr('resume.scan.title')}</div>
        <div className="mt-2.5 flex items-center gap-3 rounded-md bg-subtle p-3.5 text-meta">
          <Monitor size={20} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-fg">{tr('resume.scan.remoteTitle')}</div>
            <div className="text-fg-muted">
              {tr('resume.scan.remoteBody', { machine: machine?.name || machine?.host || machines.currentId })}
            </div>
          </div>
          <Button
            className="h-7 shrink-0 px-2.5 text-meta"
            onClick={() => void selectMachine('local').catch((e: Error) => toast(e.message))}
          >
            {tr('resume.scan.switchLocal')}
          </Button>
        </div>
      </div>
    )
  }

  const byId = new Map(projects.map(p => [p.id, p]))
  // 扫过以后从侧栏移除的项目：不显示，也不算进数字
  const view = scanView({ ...scan, rows: scan.rows.filter(r => byId.has(r.projectId)) }, onlyWith)
  const scanned = scan.rows.length > 0
  const start = (): void => void scanAllProjects(projects, id => machineOf(id) === 'local')
  const hidden = [
    view.hiddenNone && tr('resume.scan.hiddenNone', { n: view.hiddenNone }),
    view.hiddenRemote && tr('resume.scan.hiddenRemote', { n: view.hiddenRemote }),
    view.hiddenSkipped && tr('resume.scan.hiddenSkipped', { n: view.hiddenSkipped }),
  ].filter(Boolean) as string[]

  return (
    <div data-resume-scan="local" className="mb-6 rounded-lg border border-line p-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-ui font-medium text-fg">{tr('resume.scan.title')}</span>
        <span className="flex-1" />
        {scanned && (
          <label className="flex items-center gap-1.5 text-meta text-fg-secondary">
            <input
              type="checkbox"
              checked={onlyWith}
              onChange={e => setOnlyWith(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            {tr('resume.scan.onlyWith')}
          </label>
        )}
        {scan.running ? (
          <Button className="h-7 px-2.5 text-meta" disabled={scan.stopping} onClick={stopResumeScan}>
            {tr(scan.stopping ? 'resume.scan.stopping' : 'resume.scan.stop')}
          </Button>
        ) : (
          <Button
            variant={scanned ? 'outline' : 'primary'}
            icon={scanned ? RotateCw : History}
            className="h-7 px-2.5 text-meta"
            disabled={!projects.length}
            onClick={start}
          >
            {tr(scanned ? 'resume.scan.again' : 'resume.scan.start')}
          </Button>
        )}
      </div>
      <p className="mt-1.5 text-meta text-fg-muted">
        {projects.length ? tr('resume.scan.intro') : tr('resume.scan.noProjects')}
      </p>

      {scanned && (
        <>
          {scan.running && (
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-subtle">
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${view.total ? Math.round((view.done / view.total) * 100) : 100}%` }}
              />
            </div>
          )}
          <div data-resume-scan-status className="mt-2 flex items-center gap-2 text-meta text-fg-muted">
            {scan.running && <Spinner />}
            {scan.running
              ? tr('resume.scan.progress', { done: view.done, total: view.total, found: view.found })
              : view.done < view.total
                ? tr('resume.scan.stopped', { done: view.done, total: view.total, found: view.found })
                : tr('resume.scan.finished', {
                    total: view.total,
                    found: view.found,
                    time: relativeTime(scan.finishedAt ?? Date.now()),
                  })}
          </div>

          {view.rows.length > 0 ? (
            // 项目多时表格在卡片里滚动，不把下面的「从其他工具导入」挤远
            <div className="mt-2 max-h-[360px] overflow-y-auto">
              <table className="w-full border-collapse text-meta">
                <thead>
                  <tr className="sticky top-0 border-b border-line bg-surface text-left text-label text-fg-faint">
                    <th className="py-1.5 pr-2 font-medium">{tr('resume.scan.col.project')}</th>
                    {ENGINES.map(e => (
                      <th key={e} className="w-[110px] py-1.5 pr-2 font-medium">
                        {RESUME_ENGINE_NAMES[e]}
                      </th>
                    ))}
                    <th className="w-[90px] py-1.5 pr-2 font-medium">{tr('resume.scan.col.latest')}</th>
                    <th className="w-[120px] py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map(row => {
                    const project = byId.get(row.projectId)
                    if (!project) return null
                    const latest = rowLatest(row)
                    return (
                      <tr
                        key={row.projectId}
                        data-resume-scan-row={row.projectId}
                        className={cn('border-b border-line-subtle', row.state === 'remote' && 'opacity-60')}
                      >
                        <td className="max-w-0 py-2 pr-2">
                          <div className="truncate font-medium text-fg">{project.name}</div>
                          <div className="truncate text-label text-fg-faint" title={project.path}>
                            {project.path}
                          </div>
                        </td>
                        {row.state === 'remote' ? (
                          <td colSpan={3} className="py-2 pr-2 text-fg-faint">
                            {tr('resume.scan.remoteRow')}
                          </td>
                        ) : (
                          <>
                            {ENGINES.map(e => (
                              <td key={e} className="py-2 pr-2 text-fg">
                                <EngineCell row={row} engine={e} />
                              </td>
                            ))}
                            <td className="py-2 pr-2 text-fg-secondary">
                              {row.state === 'scanning'
                                ? tr('resume.scan.scanning')
                                : row.state === 'waiting'
                                  ? tr(scan.running ? 'resume.scan.waiting' : 'resume.scan.skipped')
                                  : latest
                                    ? relativeTime(latest)
                                    : '—'}
                            </td>
                          </>
                        )}
                        <td className="py-2 text-right whitespace-nowrap">
                          {row.state !== 'remote' && (
                            <span className="inline-flex items-center gap-1">
                              {row.state === 'done' && <ContinueButton row={row} onOpened={onOpened} />}
                              <IconButton
                                icon={RotateCw}
                                label={tr('resume.scan.rescanOne')}
                                size={26}
                                iconSize={13}
                                disabled={row.state === 'scanning' || (scan.running && row.state === 'waiting')}
                                onClick={() => void rescanProject(row.projectId)}
                              />
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            !scan.running && <p className="mt-3 text-meta text-fg-muted">{tr('resume.scan.noneFound')}</p>
          )}

          {onlyWith && hidden.length > 0 && (
            <div className="mt-2.5 text-label text-fg-faint">
              {hidden.join(' · ')}
              {' · '}
              <button type="button" onClick={() => setOnlyWith(false)} className="text-accent-fg hover:underline">
                {tr('resume.scan.showAll')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
