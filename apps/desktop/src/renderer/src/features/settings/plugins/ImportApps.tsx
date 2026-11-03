import { useEffect, useState } from 'react'
import type { ExtensionScope, ImportApp, ImportAppScan, ImportItem } from '@pixelsky/protocol'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { Button, cn } from '@/ui'
import { tr } from '@/i18n/core'

// 从本机其他软件导入（docs/ui/extension-remaining-plan.md §H，示意图 docs/ui/import-from-apps-mockup.html）：
// 第 1 步选软件（没找到配置的灰着），第 2 步勾选、选范围。已有同名的默认不勾，勾了导入后自动改名。

const KIND_ORDER: Array<ImportItem['kind']> = ['mcp', 'skill']

export function ImportApps({
  refTarget,
  projectName,
  projectPath,
  onDone,
  onCancel,
}: {
  refTarget: WorkspaceRef | null
  /** 当前项目名；没有项目时只能装到全局 */
  projectName: string | null
  projectPath: string | null
  onDone(note: string): void
  onCancel(): void
}) {
  const bridge = window.pixelsky?.extensions
  const [scans, setScans] = useState<ImportAppScan[] | null>(null)
  const [app, setApp] = useState<ImportApp | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [toProject, setToProject] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    bridge
      ?.scanApps(refTarget)
      .then(r => alive && setScans(r))
      .catch(e => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [])

  const current = scans?.find(s => s.app === app) ?? null
  const choose = (s: ImportAppScan): void => {
    setApp(s.app)
    setPicked(new Set(s.items.filter(i => !i.exists).map(i => i.key)))
    // 来自项目配置的默认装到项目
    setToProject(!!projectName && s.items.some(i => i.project) && s.items.every(i => i.project))
  }
  const toggle = (key: string, on: boolean): void => {
    const next = new Set(picked)
    if (on) next.add(key)
    else next.delete(key)
    setPicked(next)
  }

  const submit = async (): Promise<void> => {
    if (!current || !picked.size || busy) return
    setBusy(true)
    setError(null)
    try {
      const scope: ExtensionScope =
        toProject && projectPath ? { kind: 'project', path: projectPath } : { kind: 'global' }
      const r = await bridge!.importApp(refTarget, current.app, [...picked], scope)
      const note = tr('plugins.import.done').replace('{app}', current.name).replace('{n}', String(r.imported))
      if (!r.failed.length) return onDone(note)
      // 有失败的：面板留着显示原因，只留下没导入成功的勾（列表经 extensions:changed 自己刷新）
      const failed = new Set(r.failed.map(f => f.name))
      setPicked(new Set(current.items.filter(i => picked.has(i.key) && failed.has(i.name)).map(i => i.key)))
      setError(
        [
          r.imported ? note : '',
          tr('plugins.import.failed'),
          ...r.failed.map(f => tr('plugins.import.failedItem', { name: f.name, error: f.error })),
        ]
          .filter(Boolean)
          .join('\n'),
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-import-apps className="flex flex-col gap-3 rounded-xl border border-line-card bg-surface p-4">
      <div>
        <h4 className="text-section font-semibold">
          {current ? tr('plugins.import.titleApp').replace('{app}', current.name) : tr('plugins.import.title')}
        </h4>
        <p className="text-meta text-fg-muted">
          {current ? (
            <button type="button" className="press no-drag text-accent-fg" onClick={() => setApp(null)}>
              ‹ {tr('plugins.import.back')}
            </button>
          ) : (
            tr('plugins.import.intro')
          )}
        </p>
      </div>

      {!scans && !error && <p className="text-meta text-fg-muted">{tr('plugins.import.loading')}</p>}

      {scans && !current && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {scans.map(s => {
            const mcp = s.items.filter(i => i.kind === 'mcp').length
            const skill = s.items.filter(i => i.kind === 'skill').length
            const found = [
              mcp && tr('plugins.import.mcpCount').replace('{n}', String(mcp)),
              skill && tr('plugins.import.skillCount').replace('{n}', String(skill)),
            ]
              .filter(Boolean)
              .join(tr('plugins.hooks.separator'))
            const off = !s.items.length
            return (
              <button
                key={s.app}
                type="button"
                data-import-app={s.app}
                disabled={off}
                onClick={() => choose(s)}
                className={cn(
                  'press no-drag flex flex-col items-start gap-0.5 rounded-lg border border-line p-3 text-left',
                  off ? 'opacity-50' : 'hover:bg-subtle',
                )}
              >
                <span className="text-list font-medium text-fg">{s.name}</span>
                <span className="text-meta text-fg-muted">
                  {off
                    ? s.errors.length
                      ? tr('plugins.import.unreadable')
                      : tr('plugins.import.none')
                    : tr('plugins.import.found').replace('{x}', found)}
                </span>
                <span className="text-meta break-all text-fg-faint">
                  {s.places.join(tr('plugins.hooks.separator'))}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {current && (
        <>
          {KIND_ORDER.filter(k => current.items.some(i => i.kind === k)).map(kind => {
            const items = current.items.filter(i => i.kind === kind)
            return (
              <div key={kind} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-meta text-fg-muted">
                  <span>{kind === 'mcp' ? tr('plugins.import.mcp') : tr('plugins.import.skills')}</span>
                  <button
                    type="button"
                    className="press no-drag text-accent-fg"
                    onClick={() => setPicked(new Set([...picked, ...items.map(i => i.key)]))}
                  >
                    {tr('plugins.import.selectAll')}
                  </button>
                </div>
                {items.map(i => (
                  <label
                    key={i.key}
                    data-import-item={i.name}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-subtle',
                      i.exists && 'opacity-70',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(i.key)}
                      onChange={e => toggle(i.key, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-list font-medium text-fg">
                        {i.name}
                        {i.project && (
                          <span className="ml-2 text-meta font-normal text-fg-faint">
                            {tr('plugins.import.project')}
                          </span>
                        )}
                      </span>
                      <span className="block truncate font-mono text-meta text-fg-muted" title={i.detail}>
                        {i.detail}
                      </span>
                    </span>
                    {i.secrets.map(s => (
                      <span
                        key={s}
                        className="rounded bg-subtle px-1.5 text-meta text-fg-muted"
                        title={tr('plugins.import.secret')}
                      >
                        {s} ••••
                      </span>
                    ))}
                    {i.needsInput && <span className="text-meta text-warn">{tr('plugins.import.needsInput')}</span>}
                    {i.exists && <span className="text-meta text-warn">{tr('plugins.import.exists')}</span>}
                  </label>
                ))}
              </div>
            )
          })}
          {current.errors.length > 0 && (
            <p className="text-meta whitespace-pre-wrap text-warn">
              {tr('plugins.import.partial')}
              {'\n' + current.errors.join('\n')}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4 text-list text-fg-secondary">
            <span>{tr('plugins.import.scope')}</span>
            <label className="flex items-center gap-1">
              <input type="radio" checked={!toProject} onChange={() => setToProject(false)} />
              {tr('plugins.import.global')}
            </label>
            <label className={cn('flex items-center gap-1', !projectName && 'opacity-50')}>
              <input type="radio" disabled={!projectName} checked={toProject} onChange={() => setToProject(true)} />
              {tr('plugins.import.currentProject')}
              {projectName ? tr('plugins.import.projectName', { name: projectName }) : ''}
            </label>
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="text-meta whitespace-pre-wrap text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-meta text-fg-muted">{tr('plugins.import.copyNote')}</span>
        <Button variant="ghost" onClick={onCancel}>
          {tr('plugins.import.cancel')}
        </Button>
        {current && (
          <Button data-import-go variant="primary" disabled={busy || !picked.size} onClick={() => void submit()}>
            {tr('plugins.import.submit').replace('{n}', String(picked.size))}
          </Button>
        )}
      </div>
    </div>
  )
}
