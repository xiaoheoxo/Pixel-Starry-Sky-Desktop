import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Folder, Monitor, Plus, Server, X } from 'lucide-react'
import { Button, IconButton, Select } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { machineErrors } from '../../../../shared/i18n/machineMessages'
import type { MachineInput, WorkspaceChoice } from '../../../../shared/types/machines'
import { useEngineState, addProject } from '@/features/engine'
import { useActiveWorkspace } from '@/features/editor/target'
import { openRightTab } from '@/features/panel/workspaceStore'
import { initMachines, machineOf, selectMachine, selectWorkspace, useMachines } from './store'
import { cachedWorkspaces, loadWorkspaces } from './workspaceList'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { getFiles } from '@/features/files/store'
import { confirmFiles } from '@/features/files/FileConfirm'
import { useUnsavedCheck } from '@/features/settings/unsavedEdits'

const FIELD =
  'w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg outline-none focus:border-accent-line'
const fresh: MachineInput = { name: '', host: '', port: 22, username: '', auth: 'agent' }
export function MachineDialogs() {
  const { t, locale } = useI18n(),
    state = useMachines(),
    active = useActiveWorkspace()
  const projects = useEngineState(s => s.projects)
  // 从输入框上方文件夹菜单来的：选了一定开新对话
  const [freshPick, setFreshPick] = useState(false)
  const [view, setView] = useState<'machines' | 'workspaces' | null>(null),
    [form, setForm] = useState<MachineInput | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [query, setQuery] = useState('')
  const [trust, setTrust] = useState<{ id: string; fingerprint: string; changed?: boolean } | null>(null)
  const [confirm, setConfirm] = useState<{ id: string; action: 'disconnect' | 'remove' } | null>(null)
  // 添加 / 编辑机器的表单：打开时的样子。改过再关弹窗、或去编辑另一台，先问一句（主机、用户名、密码不静默丢）
  const formOrigin = useRef('')
  const openForm = (next: MachineInput | null): void => {
    formOrigin.current = next ? JSON.stringify(next) : ''
    setForm(next)
  }
  const [discard, setDiscard] = useState<(() => void) | null>(null)
  // 在设置里打开时，关设置、切分区也问（settings/unsavedEdits.tsx）
  useUnsavedCheck(() => !!form && JSON.stringify(form) !== formOrigin.current)
  const leaveForm = (action: () => void): void => {
    if (form && JSON.stringify(form) !== formOrigin.current) setDiscard(() => action)
    else action()
  }
  const [workspaces, setWorkspaces] = useState<WorkspaceChoice[]>([]),
    [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [directory, setDirectory] = useState<{ path: string; parent: string | null; directories: string[] } | null>(
      null,
    ),
    [path, setPath] = useState('')
  // 目录列表里勾选的子目录：一次加成几个项目（docs/ui/multi-root-projects.md §2.2）
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const message = (error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error)
    return (machineErrors as Record<string, { zh: string; en: string }>)[raw]?.[locale === 'en-US' ? 'en' : 'zh'] ?? raw
  }
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    return window.pixelsky?.projectTools.onChange(() => setRevision(v => v + 1))
  }, [])
  useEffect(() => {
    void initMachines().catch(e => setError(message(e)))
    const machines = (e: Event) => {
      setView('machines')
      setError('')
      openForm((e as CustomEvent<{ add?: boolean } | null>).detail?.add && !isDemo ? { ...fresh } : null)
      setDirectory(null)
      setQuery('')
    }
    const workspace = (e: Event) => {
      setFreshPick(!!(e as CustomEvent<{ fresh?: boolean } | null>).detail?.fresh)
      setView('workspaces')
      setError('')
      setQuery('')
      setDirectory(null)
    }
    window.addEventListener('pixelsky:manage-machines', machines)
    window.addEventListener('pixelsky:choose-workspace', workspace)
    return () => {
      window.removeEventListener('pixelsky:manage-machines', machines)
      window.removeEventListener('pixelsky:choose-workspace', workspace)
    }
  }, [])
  // 工作区列表（issue #11）：有上次读到的就直接显示，在后台刷新后替换，不清空、不显示「正在读取」；
  // 只有从没读过时才显示。项目工具变化时（revision）合并成一次后台刷新
  useEffect(() => {
    if (view !== 'workspaces') return
    if (isDemo) {
      setWorkspaces(demo().machineWorkspaces?.(state.currentId) ?? [])
      setLoading(false)
      return
    }
    let gone = false
    const list = projects.filter(p => machineOf(p.id) === state.currentId)
    const cached = cachedWorkspaces(state.currentId, list)
    setWorkspaces(cached ?? [])
    setLoading(!cached)
    const timer = window.setTimeout(
      () =>
        void loadWorkspaces(state.currentId, list, message).then(rows => {
          if (!gone) {
            setWorkspaces(rows)
            setLoading(false)
          }
        }),
      cached ? 250 : 0,
    )
    return () => {
      gone = true
      window.clearTimeout(timer)
    }
  }, [view, state.currentId, projects, revision])
  // 启动后空闲时预读一次：第一次打开也直接有列表
  useEffect(() => {
    if (isDemo || !window.pixelsky) return
    const list = projects.filter(p => machineOf(p.id) === state.currentId)
    if (!list.length || cachedWorkspaces(state.currentId, list)) return
    const timer = window.setTimeout(() => void loadWorkspaces(state.currentId, list, message).catch(() => {}), 3000)
    return () => window.clearTimeout(timer)
  }, [state.currentId, projects])
  const connect = async (id: string, fingerprint?: string) => {
    const result = await window.pixelsky!.machines.connect(id, fingerprint)
    if (!result.connected && result.fingerprint)
      setTrust({ id, fingerprint: result.fingerprint, changed: result.changed })
    else setTrust(null)
  }
  const browse = async (path?: string) => {
    const next = await window.pixelsky!.machines.directories(state.currentId, path)
    setDirectory(next)
    setPath(next.path)
    setChecked(new Set())
  }
  const current = state.machines.find(m => m.id === state.currentId)
  if (!view) return null
  return (
    <>
      <MachineModal
        title={t(
          view === 'machines'
            ? 'machines.title'
            : freshPick
              ? 'machines.folder.newElsewhereTitle'
              : 'machines.workspace',
        )}
        busy={busy}
        close={() => {
          if (!trust && !confirm && !discard) leaveForm(() => setView(null))
        }}
      >
        {error && (
          <p role="alert" className="mb-3 break-words rounded-md bg-subtle p-3 text-meta text-danger">
            {error}
          </p>
        )}
        {view === 'machines' ? (
          <>
            <p className="mb-4 text-meta text-fg-muted">{t('machines.requirements')}</p>
            <input
              className={FIELD + ' mb-3'}
              value={query}
              aria-label={t('machines.searchMachines')}
              placeholder={t('machines.searchMachines')}
              onChange={e => setQuery(e.target.value)}
            />
            {state.machines
              .filter(m => m.kind !== 'wsl')
              .filter(m => (m.name + m.host).toLowerCase().includes(query.toLowerCase()))
              .map(machine => (
                <div key={machine.id} className="mb-2 rounded-lg border border-line bg-surface p-3">
                  <div className="flex items-center gap-2">
                    {machine.id === 'local' ? <Monitor size={16} /> : <Server size={16} />}
                    <strong className="min-w-0 flex-1 break-words text-ui">
                      {machine.name || t('machines.local')}
                      {machine.id === state.currentId ? ' ✓' : ''}
                    </strong>
                    <span className="text-meta text-fg-muted">
                      {t(machine.status === 'local' ? 'machines.local' : `machines.${machine.status}`)}
                    </span>
                  </div>
                  <p className="mt-1 break-all text-meta text-fg-muted">
                    {machine.id === 'local' ? machine.platform : `${machine.username}@${machine.host}:${machine.port}`}
                  </p>
                  {machine.error && <p className="mt-1 break-words text-meta text-warn">{message(machine.error)}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {['local', 'connected'].includes(machine.status) ? (
                      <Button
                        disabled={busy || machine.id === state.currentId}
                        onClick={() =>
                          void run(async () => {
                            await selectMachine(machine.id)
                            setView('workspaces')
                          })
                        }
                      >
                        {t('machines.use')}
                      </Button>
                    ) : (
                      <Button disabled={busy} onClick={() => void run(() => connect(machine.id))}>
                        {t('machines.connect')}
                      </Button>
                    )}
                    {machine.id !== 'local' && (
                      <>
                        {machine.status === 'connected' ? (
                          <Button disabled={busy} onClick={() => setConfirm({ id: machine.id, action: 'disconnect' })}>
                            {t('machines.disconnect')}
                          </Button>
                        ) : (
                          <Button
                            disabled={busy}
                            onClick={() => {
                              leaveForm(() =>
                                openForm({
                                  id: machine.id,
                                  name: machine.name,
                                  host: machine.host,
                                  port: machine.port,
                                  username: machine.username,
                                  auth: machine.auth as MachineInput['auth'],
                                  privateKeyPath: machine.privateKeyPath,
                                }),
                              )
                              setError('')
                            }}
                          >
                            {t('machines.edit')}
                          </Button>
                        )}
                        <Button disabled={busy} onClick={() => setConfirm({ id: machine.id, action: 'remove' })}>
                          {t('machines.remove')}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            {!form ? (
              <Button icon={Plus} disabled={busy || isDemo} onClick={() => openForm({ ...fresh })}>
                {t('machines.add')}
              </Button>
            ) : (
              <form
                className="mt-4 space-y-3 rounded-lg border border-line p-4"
                onSubmit={e => {
                  e.preventDefault()
                  void run(async () => {
                    await window.pixelsky!.machines.save(form)
                    setForm(null)
                  })
                }}
              >
                <Field label={t('machines.name')}>
                  <input
                    required
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    className={FIELD}
                  />
                </Field>
                <div className="flex gap-3">
                  <Field label={t('machines.host')}>
                    <input
                      required
                      value={form.host}
                      onChange={e => setForm({ ...form, host: e.target.value })}
                      className={FIELD}
                    />
                  </Field>
                  <label className="w-28 shrink-0 text-meta">
                    {t('machines.port')}
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      required
                      value={form.port}
                      onChange={e => setForm({ ...form, port: Number(e.target.value) })}
                      className={FIELD}
                    />
                  </label>
                </div>
                <Field label={t('machines.user')}>
                  <input
                    required
                    value={form.username}
                    onChange={e => setForm({ ...form, username: e.target.value })}
                    className={FIELD}
                  />
                </Field>
                <Select
                  label={t('machines.auth')}
                  value={form.auth}
                  options={(['agent', 'key', 'password'] as const).map(value => ({
                    value,
                    label: t(`machines.${value}`),
                  }))}
                  onChange={auth => setForm({ ...form, auth })}
                />
                {form.auth === 'key' && (
                  <>
                    <Field label={t('machines.key')}>
                      <div className="flex gap-2">
                        <input
                          required
                          value={form.privateKeyPath ?? ''}
                          className={FIELD}
                          onChange={e => setForm({ ...form, privateKeyPath: e.target.value })}
                        />
                        <Button
                          onClick={() =>
                            void run(async () => {
                              const key = await window.pixelsky!.machines.chooseKey()
                              if (key) setForm({ ...form, privateKeyPath: key })
                            })
                          }
                        >
                          {t('machines.chooseKey')}
                        </Button>
                      </div>
                    </Field>
                    <Field label={t('machines.passphrase')}>
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={form.passphrase ?? ''}
                        placeholder={form.id ? t('machines.keepSecret') : ''}
                        onChange={e => setForm({ ...form, passphrase: e.target.value || undefined })}
                        className={FIELD}
                      />
                    </Field>
                  </>
                )}
                {form.auth === 'password' && (
                  <Field label={t('machines.password')}>
                    <input
                      type="password"
                      autoComplete="new-password"
                      required={!form.id}
                      placeholder={form.id ? t('machines.keepSecret') : ''}
                      value={form.password ?? ''}
                      onChange={e => setForm({ ...form, password: e.target.value || undefined })}
                      className={FIELD}
                    />
                  </Field>
                )}
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" disabled={busy}>
                    {t('machines.save')}
                  </Button>
                  <Button disabled={busy} onClick={() => setForm(null)}>
                    {t('machines.cancel')}
                  </Button>
                </div>
              </form>
            )}
          </>
        ) : (
          <>
            <p className="mb-3 text-meta text-fg-muted">{t('machines.workspaceHint')}</p>
            <div className="mb-3 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-ui">{current?.name || t('machines.local')}</span>
              <Button disabled={busy} onClick={() => setView('machines')}>
                {t('machines.switch')}
              </Button>
            </div>
            {current && !['local', 'connected'].includes(current.status) ? (
              <p className="text-meta text-warn">{t('machines.offline')}</p>
            ) : directory ? (
              <>
                <div className="mb-2 flex gap-2">
                  <input
                    aria-label={t('machines.path')}
                    className={FIELD}
                    value={path}
                    onChange={e => setPath(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void run(() => browse(path))
                    }}
                  />
                  <Button disabled={busy} onClick={() => void run(() => browse(path))}>
                    {t('machines.go')}
                  </Button>
                </div>
                {current?.kind === 'wsl' && path.startsWith('/mnt/') && (
                  <p className="-mt-1 mb-2 text-meta text-warn">{t('wsl.mntHint')}</p>
                )}
                <div className="max-h-60 overflow-auto rounded-md border border-line p-1">
                  {directory.parent && (
                    <button
                      className="block w-full rounded p-2 text-left text-ui hover:bg-hover"
                      onClick={() => void run(() => browse(directory.parent!))}
                    >
                      .. / {t('machines.parent')}
                    </button>
                  )}
                  {directory.directories.map(name => {
                    const child = directory.path.replace(/\/$/, '') + '/' + name
                    return (
                      <div key={name} className="flex items-center gap-1 rounded hover:bg-hover">
                        <input
                          type="checkbox"
                          className="ml-2 shrink-0"
                          aria-label={t('machines.checkDirectory', { name })}
                          checked={checked.has(child)}
                          onChange={() =>
                            setChecked(prev => {
                              const next = new Set(prev)
                              if (next.has(child)) next.delete(child)
                              else next.add(child)
                              return next
                            })
                          }
                        />
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2 p-2 text-left text-ui"
                          onClick={() => void run(() => browse(child))}
                        >
                          <Folder size={14} className="shrink-0" />
                          <span className="break-all">{name}</span>
                        </button>
                      </div>
                    )
                  })}
                  {!directory.directories.length && (
                    <p className="p-2 text-meta text-fg-muted">{t('machines.emptyDirectory')}</p>
                  )}
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    disabled={busy}
                    variant="primary"
                    onClick={() =>
                      void run(async () => {
                        await window.pixelsky!.machines.addProject(state.currentId, directory.path)
                        setDirectory(null)
                      })
                    }
                  >
                    {t('machines.useDirectory')}
                  </Button>
                  {checked.size > 0 && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          // 一个一个加：远程机器的辅助进程只有单个添加
                          for (const dir of checked) await window.pixelsky!.machines.addProject(state.currentId, dir)
                          setDirectory(null)
                        })
                      }
                    >
                      {t('machines.addChecked', { n: checked.size })}
                    </Button>
                  )}
                  <Button disabled={busy} onClick={() => setDirectory(null)}>
                    {t('machines.cancel')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <input
                  className={FIELD + ' mb-3'}
                  placeholder={t('machines.search')}
                  aria-label={t('machines.search')}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                <div className="max-h-72 space-y-1 overflow-auto">
                  {workspaces
                    .filter(w => (w.name + w.path + w.branch).toLowerCase().includes(query.toLowerCase()))
                    .map(w => (
                      <button
                        key={w.copyId ?? w.projectId}
                        disabled={busy || !!w.error}
                        title={w.error ?? w.path}
                        className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-left hover:bg-hover disabled:opacity-50"
                        onClick={() =>
                          void run(async () => {
                            await selectWorkspace(w, freshPick)
                            setView(null)
                          })
                        }
                      >
                        <span className="block break-words text-ui font-medium">
                          {w.name}
                          {active.path === w.path ? ' ✓' : ''}
                        </span>
                        <span className="mt-0.5 block break-all text-meta text-fg-muted">{w.path}</span>
                        <span className="mt-0.5 block text-label text-fg-faint">
                          {t(w.copyId ? 'machines.copy' : 'machines.mainTree')}
                          {w.branch ? ' · ' + w.branch : ''}
                        </span>
                        {w.error && <span className="block text-meta text-warn">{w.error}</span>}
                      </button>
                    ))}
                </div>
                {loading ? (
                  <p className="p-3 text-meta text-fg-muted">{t('machines.loading')}</p>
                ) : !workspaces.length ? (
                  <p className="p-3 text-meta text-fg-muted">{t('machines.noProjects')}</p>
                ) : (
                  !workspaces.some(w => (w.name + w.path + w.branch).toLowerCase().includes(query.toLowerCase())) && (
                    <p className="p-3 text-meta text-fg-muted">{t('machines.noMatches')}</p>
                  )
                )}
                <div className="mt-3 flex gap-2">
                  <Button
                    disabled={busy || isDemo}
                    icon={Plus}
                    onClick={() =>
                      void run(async () => {
                        if (state.currentId === 'local') await addProject()
                        else await browse()
                      })
                    }
                  >
                    {t('machines.addDirectory')}
                  </Button>
                  <Button
                    disabled={!active.ref}
                    onClick={() => {
                      openRightTab('copies')
                      setView(null)
                    }}
                  >
                    {t('machines.manageCopies')}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </MachineModal>
      {discard && (
        <ConfirmDialog
          title={t('customApi.discardTitle')}
          description={t('ui.ConfirmDialog.unsaved')}
          busy={false}
          danger
          confirmLabel={t('ui.ConfirmDialog.discard')}
          cancelLabel={t('ui.ConfirmDialog.keepEditing')}
          onConfirm={() => {
            const action = discard
            setDiscard(null)
            setForm(null)
            action()
          }}
          onCancel={() => setDiscard(null)}
        />
      )}
      {trust && (
        <ConfirmDialog
          title={t('machines.fingerprintTitle')}
          description={
            <div className="space-y-3">
              <p>{t(trust.changed ? 'machines.fingerprintChanged' : 'machines.fingerprint')}</p>
              <code className="block break-all text-meta">{trust.fingerprint}</code>
            </div>
          }
          error={error || null}
          busy={busy}
          confirmLabel={t('machines.trust')}
          cancelLabel={t('machines.cancel')}
          onConfirm={() => void run(() => connect(trust.id, trust.fingerprint))}
          onCancel={() => setTrust(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={t(`machines.${confirm.action}`)}
          description={t(confirm.action === 'disconnect' ? 'machines.disconnectHint' : 'machines.removeHint')}
          busy={busy}
          error={error || null}
          confirmLabel={t(`machines.${confirm.action}`)}
          cancelLabel={t('machines.cancel')}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void run(async () => {
              const action = confirm
              setConfirm(null)
              const ids = getFiles()
                .tabs.filter(f => machineOf(f.ref.projectId ?? f.ref.sessionId) === action.id)
                .map(f => f.id)
              if (!(await confirmFiles(ids, t(`machines.${action.action}`)))) return
              if (action.action === 'remove') {
                if (action.id === state.currentId) await selectMachine('local')
                await window.pixelsky!.machines.remove(action.id)
              } else await window.pixelsky!.machines.disconnect(action.id)
            })
          }
        />
      )}
    </>
  )
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-meta text-fg-secondary">
      {label}
      {children}
    </label>
  )
}
function MachineModal({
  title,
  children,
  busy,
  close,
}: {
  title: string
  children: ReactNode
  busy: boolean
  close(): void
}) {
  const { t } = useI18n()
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    document.querySelector<HTMLElement>('[data-machines-dialog] button')?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-machines-dialog
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onMouseDown={e => {
        if (e.target === e.currentTarget && !busy) close()
      }}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape' && !busy) close()
        if (e.key === 'Tab') {
          const elements = [
            ...e.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
            ),
          ].filter(x => x.getBoundingClientRect().width)
          const first = elements[0],
            last = elements.at(-1)
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last?.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first?.focus()
          }
        }
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line-card bg-popover shadow-menu">
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
          <h2 className="flex-1 text-ui font-semibold">{title}</h2>
          <IconButton icon={X} label={t('machines.close')} disabled={busy} onClick={close} />
        </header>
        <div className="min-h-0 overflow-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
