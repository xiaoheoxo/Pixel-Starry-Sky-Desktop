import { useEffect, useState } from 'react'
import { scriptCommand } from '@pixelsky/protocol'
import { Clipboard, FolderOpen, Globe, Pencil, Play, RotateCw, Square, Trash2 } from 'lucide-react'
import { Button, IconButton, Select } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { useProjectContext } from './projectContext'
import { CARD, FIELD, Field, NoProject, ToolError, ToolsHeader, useOperation } from './ToolsUi'
import type { EnvironmentState, ServiceDefinition, ServiceInput } from '../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { demo as demoData } from '@/data/demo'
import { ListInput } from './ListInput'

const EMPTY_NAMES: readonly string[] = []
export const OPEN_BROWSER = 'pixelsky:open-browser'
const blank: ServiceInput = {
  name: '',
  command: '',
  cwd: '',
  port: null,
  healthUrl: '',
  envNames: [],
  autoStart: false,
}
const statusKeys = {
  stopped: 'projectTools.stopped',
  starting: 'projectTools.starting',
  running: 'projectTools.running',
  stopping: 'projectTools.stopping',
  failed: 'projectTools.failedStatus',
} as const

export function EnvironmentPanel() {
  const context = useProjectContext()
  return context.ref ? (
    <EnvironmentBody key={context.key + ':' + JSON.stringify(context.ref)} target={context.ref} demo={context.demo} />
  ) : (
    <NoProject />
  )
}
function EnvironmentBody({ target, demo }: { target: WorkspaceRef; demo: boolean }) {
  useI18n()
  const [data, setData] = useState<EnvironmentState | null>(
    demo ? structuredClone(demoData().projectTools.environment) : null,
  )
  const [form, setForm] = useState<ServiceInput | null>(null),
    [portInfo, setPortInfo] = useState<{ occupied: boolean; pid: string | null; suggested: number } | null>(null)
  const [confirm, setConfirm] = useState<{
    service: ServiceDefinition
    action: 'start' | 'restart' | 'force' | 'delete'
  } | null>(null)
  const { busy, error, setError, run } = useOperation()
  useEffect(() => {
    if (demo) return
    let gone = false
    void window
      .pixelsky!.projectTools.environment(target)
      .then(next => {
        if (!gone) setData(next)
      })
      .catch(e => {
        if (!gone) setError(e.message)
      })
    const off = window.pixelsky!.projectTools.onChange(() => {
      void window
        .pixelsky!.projectTools.services(target)
        .then(services => {
          if (!gone) setData(d => (d ? { ...d, services } : d))
        })
        .catch(e => {
          if (!gone) setError(e.message)
        })
    })
    return () => {
      gone = true
      off()
    }
  }, [])
  const refresh = async (force = false) => {
    if (!demo) setData(await window.pixelsky!.projectTools.environment(target, force))
  }
  const save = () =>
    run(async () => {
      if (!form) return
      if (demo) {
        const next: ServiceDefinition = {
          ...blank,
          ...form,
          id: form.id ?? crypto.randomUUID(),
          projectId: 'demo',
          workspacePath: demoData().projectTools.environment.projectPath,
          cwd: form.cwd || demoData().projectTools.environment.projectPath,
          port: form.port ?? null,
          healthUrl: form.healthUrl ?? null,
          envNames: form.envNames ?? [],
          autoStart: form.autoStart === true,
          status: 'stopped',
          health: 'none',
          pid: null,
          exitCode: null,
          output: '',
          error: null,
          updatedAt: Date.now(),
        }
        setData(d => (d ? { ...d, services: [...d.services.filter(s => s.id !== next.id), next] } : d))
      } else {
        await window.pixelsky!.projectTools.saveService(target, form)
        await refresh()
      }
      setForm(null)
      setPortInfo(null)
    })
  const action = () =>
    run(async () => {
      if (!confirm) return
      const { service, action } = confirm
      if (demo)
        setData(d =>
          d
            ? {
                ...d,
                services:
                  action === 'delete'
                    ? d.services.filter(s => s.id !== service.id)
                    : d.services.map(s =>
                        s.id === service.id ? { ...s, status: action === 'force' ? 'stopped' : 'running' } : s,
                      ),
              }
            : d,
        )
      else {
        const api = window.pixelsky!.projectTools
        if (action === 'delete') await api.deleteService(service.id)
        else if (action === 'force') await api.stopService(service.id, true)
        else if (action === 'restart') await api.restartService(service.id)
        else await api.startService(service.id)
        await refresh()
      }
      setConfirm(null)
    })
  return (
    <div data-tools-environment className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
      <ToolsHeader
        title={tr('projectTools.environmentTitle')}
        subtitle={data?.projectPath}
        busy={busy}
        refresh={() => void run(() => refresh(true))}
      />
      <ToolError error={error} />
      {!data ? (
        <p className="py-8 text-center text-list text-fg-muted">
          {error ? tr('projectTools.error') : tr('projectTools.loading')}
        </p>
      ) : (
        <>
          <section className={CARD}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-all font-mono text-meta text-fg-secondary">{data.projectPath}</span>
              <IconButton
                icon={FolderOpen}
                label={tr('projectTools.openFolder')}
                onClick={() =>
                  void run(async () => {
                    if (!demo) await window.pixelsky!.projectTools.openPath(target)
                  })
                }
              />
              <IconButton
                icon={Clipboard}
                label={tr('projectTools.copyDiagnostics')}
                onClick={() =>
                  void run(() =>
                    navigator.clipboard.writeText(
                      JSON.stringify(
                        { project: data.projectPath, branch: data.branch, commit: data.commit, tools: data.tools },
                        null,
                        2,
                      ),
                    ),
                  )
                }
              />
            </div>
            <p className="mt-2 text-list text-fg-muted">
              {tr('projectTools.branch')}: {data.branch ?? '—'} ·{' '}
              {data.dirty ? tr('projectTools.dirty') : tr('projectTools.clean')}
            </p>
          </section>
          <section className={CARD}>
            <h3 className="mb-2 text-list font-medium text-fg">{tr('projectTools.tools')}</h3>
            {data.tools.map(tool => (
              <div key={tool.name} className="flex items-start gap-2 border-b border-line py-2 last:border-0">
                <span className="w-14 shrink-0 font-mono text-list text-fg">{tool.name}</span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-list text-fg-secondary">{tool.version ?? '—'}</p>
                  <p title={tool.path ?? ''} className="truncate text-meta text-fg-faint">
                    {tool.path ?? ''}
                  </p>
                  {tool.expected && (
                    <p className="text-meta text-fg-muted">
                      {tr('projectTools.expected')}: {tool.expected}
                    </p>
                  )}
                </div>
                <span className={'text-meta ' + (tool.status === 'ready' ? 'text-success' : 'text-warn')}>
                  {tr(('projectTools.tool.' + tool.status) as 'projectTools.tool.ready')}
                </span>
              </div>
            ))}
          </section>
          <section className="flex shrink-0 flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-list font-medium text-fg">{tr('projectTools.services')}</h3>
              <Button
                onClick={() => {
                  setForm({ ...blank })
                  setPortInfo(null)
                }}
              >
                {tr('projectTools.addService')}
              </Button>
            </div>
            {form && (
              <form
                className={CARD + ' flex flex-col gap-2'}
                onSubmit={e => {
                  e.preventDefault()
                  void save()
                }}
              >
                {!!Object.keys(data.scripts).length && (
                  <Select
                    label={tr('projectTools.fromScript')}
                    value=""
                    options={[
                      { value: '', label: tr('projectTools.fromScript') },
                      ...Object.keys(data.scripts).map(value => ({ value, label: value })),
                    ]}
                    onChange={name => {
                      if (name) setForm({ ...form, name, command: scriptCommand(data.packageManager ?? 'npm', name) })
                    }}
                  />
                )}
                <Field label={tr('projectTools.serviceName')}>
                  <input
                    autoFocus
                    required
                    maxLength={80}
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    className={FIELD}
                  />
                </Field>
                <Field label={tr('projectTools.command')}>
                  <input
                    required
                    maxLength={2000}
                    value={form.command}
                    onChange={e => setForm({ ...form, command: e.target.value })}
                    className={FIELD + ' font-mono'}
                  />
                </Field>
                <Field label={tr('projectTools.cwd')}>
                  <input
                    value={form.cwd ?? ''}
                    onChange={e => setForm({ ...form, cwd: e.target.value })}
                    placeholder={data.projectPath}
                    className={FIELD}
                  />
                </Field>
                <Field label={tr('projectTools.port')}>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={form.port ?? ''}
                    onChange={e => {
                      setForm({ ...form, port: e.target.value ? Number(e.target.value) : null })
                      setPortInfo(null)
                    }}
                    className={FIELD}
                  />
                </Field>
                <p className="text-meta text-fg-muted">{tr('projectTools.portHint')}</p>
                {form.port && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () =>
                        setPortInfo(
                          demo
                            ? { occupied: false, pid: null, suggested: form.port! }
                            : await window.pixelsky!.projectTools.portStatus(form.port!),
                        ),
                      )
                    }
                  >
                    {tr('projectTools.checkPort')}
                  </Button>
                )}
                {portInfo && (
                  <div className="text-meta text-fg-muted">
                    {portInfo.occupied
                      ? tr('projectTools.portOccupied', { p0: portInfo.pid ?? '—' })
                      : tr('projectTools.portFree')}
                    {portInfo.occupied && (
                      <Button
                        onClick={() => {
                          setForm({ ...form, port: portInfo.suggested })
                          setPortInfo(null)
                        }}
                      >
                        {tr('projectTools.usePort', { p0: portInfo.suggested })}
                      </Button>
                    )}
                  </div>
                )}
                <Field label={tr('projectTools.healthUrl')}>
                  <input
                    value={form.healthUrl ?? ''}
                    onChange={e => setForm({ ...form, healthUrl: e.target.value })}
                    className={FIELD}
                  />
                </Field>
                <Field label={tr('projectTools.envNames')}>
                  <ListInput
                    value={form.envNames ?? EMPTY_NAMES}
                    onChange={envNames => setForm({ ...form, envNames })}
                    className={FIELD}
                  />
                </Field>
                <label className="flex items-center gap-2 text-list text-fg-secondary">
                  <input
                    type="checkbox"
                    checked={form.autoStart === true}
                    onChange={e => setForm({ ...form, autoStart: e.target.checked })}
                  />
                  {tr('projectTools.autoStart')}
                </label>
                <div className="flex gap-2">
                  <Button type="submit" disabled={busy} variant="primary">
                    {tr('projectTools.save')}
                  </Button>
                  <Button disabled={busy} onClick={() => setForm(null)}>
                    {tr('projectTools.cancel')}
                  </Button>
                </div>
              </form>
            )}
            {!data.services.length && (
              <p className="py-6 text-center text-meta text-fg-muted">{tr('projectTools.noServices')}</p>
            )}
            {data.services.map(service => (
              <article data-tool-service={service.id} key={service.id} className={CARD}>
                <div className="flex items-start justify-between gap-2">
                  <h4 className="min-w-0 flex-1 break-words text-list font-medium text-fg">{service.name}</h4>
                  <span className="text-meta text-fg-muted">{tr(statusKeys[service.status])}</span>
                </div>
                <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-meta text-fg-secondary">
                  {service.command}
                </pre>
                <p className="mt-1 text-meta text-fg-muted">
                  {service.port ? ':' + service.port + ' · ' : ''}
                  {tr(('projectTools.health.' + service.health) as 'projectTools.health.none')}
                  {service.exitCode !== null ? ' · ' + tr('projectTools.exitCode', { p0: service.exitCode }) : ''}
                </p>
                {service.error && <ToolError error={service.error} />}
                <div className="mt-2 flex flex-wrap gap-1">
                  {service.status === 'running' || service.status === 'starting' ? (
                    <Button
                      icon={Square}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          if (demo)
                            setData(d =>
                              d
                                ? {
                                    ...d,
                                    services: d.services.map(s =>
                                      s.id === service.id ? { ...s, status: 'stopped' } : s,
                                    ),
                                  }
                                : d,
                            )
                          else {
                            await window.pixelsky!.projectTools.stopService(service.id)
                            await refresh()
                          }
                        })
                      }
                    >
                      {tr('projectTools.stop')}
                    </Button>
                  ) : (
                    service.status !== 'stopping' && (
                      <Button icon={Play} disabled={busy} onClick={() => setConfirm({ service, action: 'start' })}>
                        {tr('projectTools.start')}
                      </Button>
                    )
                  )}
                  {service.status === 'stopping' && (
                    <Button disabled={busy} onClick={() => setConfirm({ service, action: 'force' })}>
                      {tr('projectTools.forceStop')}
                    </Button>
                  )}
                  <IconButton
                    icon={RotateCw}
                    disabled={busy}
                    label={tr('projectTools.restart')}
                    onClick={() => setConfirm({ service, action: 'restart' })}
                  />
                  <IconButton
                    icon={Pencil}
                    disabled={busy || ['running', 'starting', 'stopping'].includes(service.status)}
                    label={tr('projectTools.edit')}
                    onClick={() => {
                      setForm(service)
                      setPortInfo(null)
                    }}
                  />
                  <IconButton
                    icon={Trash2}
                    disabled={busy || ['running', 'starting', 'stopping'].includes(service.status)}
                    label={tr('projectTools.remove')}
                    onClick={() => setConfirm({ service, action: 'delete' })}
                  />
                  {(service.healthUrl || service.port) && (
                    <IconButton
                      icon={Globe}
                      label={tr('projectTools.browserTitle')}
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent(OPEN_BROWSER, {
                            detail: { ref: target, url: service.healthUrl || 'http://127.0.0.1:' + service.port },
                          }),
                        )
                      }
                    />
                  )}
                </div>
                {service.output && (
                  <details className="mt-2 text-meta text-fg-muted">
                    <summary>{tr('projectTools.logs')}</summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-subtle p-2 font-mono">
                      {service.output}
                    </pre>
                    <Button onClick={() => void run(() => navigator.clipboard.writeText(service.output))}>
                      {tr('projectTools.copyLogs')}
                    </Button>
                  </details>
                )}
              </article>
            ))}
          </section>
        </>
      )}
      {confirm && (
        <ConfirmDialog
          title={tr('projectTools.confirmService')}
          description={
            <div className="flex flex-col gap-2">
              <p>{confirm.service.name}</p>
              <pre className="whitespace-pre-wrap break-all">{confirm.service.command}</pre>
              <p className="break-all">{confirm.service.cwd}</p>
              <p>
                {confirm.service.port ? 'PORT=' + confirm.service.port : ''} {confirm.service.envNames.join(', ')}
              </p>
              <p>{tr(('projectTools.serviceAction.' + confirm.action) as 'projectTools.serviceAction.start')}</p>
            </div>
          }
          confirmLabel={tr(
            confirm.action === 'delete'
              ? 'projectTools.remove'
              : confirm.action === 'force'
                ? 'projectTools.forceStop'
                : 'projectTools.start',
          )}
          cancelLabel={tr('projectTools.cancel')}
          busy={busy}
          danger={confirm.action === 'delete' || confirm.action === 'force'}
          error={error}
          onConfirm={() => void action()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
